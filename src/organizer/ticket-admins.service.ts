import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import {
  BlockchainTxType,
  TicketAdminStatus,
  UserRole,
  WalletCreationStatus,
} from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { CircleContractService } from '../blockchain/circle-contract.service';
import { WalletsService } from '../wallets/wallets.service';

/**
 * Organizer-facing check-in delegation. An organizer grants/revokes the
 * on-chain `ticketAdminRole` to other HostIT users so they can scan
 * attendees in. On-chain the role is per ticket type (the CheckInFacet's
 * addTicketAdmins/removeTicketAdmins are keyed by the on-chain ticket id),
 * so a single event-level grant fans out across all of the event's ticket
 * types. The contract has no getter for the admin set, so the
 * EventTicketAdmin table is the source of truth for listing delegates.
 *
 * The organizer signs the grant/revoke (they are the event's on-chain
 * mainAdmin); the check-in worker already signs `checkIn` with the
 * scanner's own wallet, so a granted delegate is picked up automatically.
 */
@Injectable()
export class TicketAdminsService {
  private readonly logger = new Logger(TicketAdminsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly circle: CircleContractService,
    private readonly wallets: WalletsService,
  ) {}

  /** Grant ticket-admin (check-in) rights to one or more users. */
  async addAdmins(organizerId: string, eventId: string, userIds: string[]) {
    const event = await this.loadOwnedEvent(eventId, organizerId);
    const onchainTicketIds = this.resolveOnchainTicketIds(event.ticketTypes);
    const signerWalletId = await this.resolveOrganizerSigner(
      organizerId,
      event.chain,
    );

    const targets: { userId: string; address: string }[] = [];
    const provisioning: string[] = [];

    for (const userId of [...new Set(userIds)]) {
      if (userId === organizerId) {
        throw new BadRequestException(
          'You are already the ticket admin for this event',
        );
      }
      const user = await this.prisma.user.findUnique({
        where: { id: userId },
        select: { id: true, role: true },
      });
      if (!user) {
        throw new BadRequestException(`User ${userId} not found`);
      }
      if (user.role === UserRole.ADMIN) {
        throw new BadRequestException(
          `User ${userId} is a platform admin and cannot be a ticket admin`,
        );
      }

      const wallet = await this.prisma.userWallet.findFirst({
        where: {
          userId,
          chain: event.chain,
          creationStatus: WalletCreationStatus.CREATED,
        },
        select: { address: true },
      });
      if (!wallet?.address) {
        // Kick provisioning so a retry succeeds, then reject clearly.
        await this.wallets.ensureWalletsForActiveChains(userId);
        provisioning.push(userId);
        continue;
      }
      targets.push({ userId, address: wallet.address });
    }

    if (provisioning.length > 0) {
      throw new BadRequestException(
        `Wallet still provisioning on ${event.chain} for: ${provisioning.join(
          ', ',
        )}. It was just kicked off — retry shortly.`,
      );
    }

    const addresses = targets.map((t) => t.address);
    // One grant per ticket type (role is keyed by on-chain ticket id).
    for (const ticketId of onchainTicketIds) {
      await this.circle.executeContract({
        method: 'addTicketAdmins',
        args: [ticketId, addresses],
        chain: event.chain,
        txType: BlockchainTxType.SET_ADMINS,
        eventId,
        walletId: signerWalletId,
      });
    }

    await this.prisma.$transaction(
      targets.map((t) =>
        this.prisma.eventTicketAdmin.upsert({
          where: { eventId_userId: { eventId, userId: t.userId } },
          create: {
            eventId,
            userId: t.userId,
            address: t.address,
            status: TicketAdminStatus.ACTIVE,
          },
          update: { address: t.address, status: TicketAdminStatus.ACTIVE },
        }),
      ),
    );

    this.logger.log(
      `Granted ticket-admin to ${targets.length} user(s) on event ${eventId} ` +
        `across ${onchainTicketIds.length} ticket type(s)`,
    );

    return this.listAdmins(organizerId, eventId);
  }

  /** Revoke ticket-admin rights from one or more users. */
  async removeAdmins(organizerId: string, eventId: string, userIds: string[]) {
    const event = await this.loadOwnedEvent(eventId, organizerId);
    const onchainTicketIds = this.resolveOnchainTicketIds(event.ticketTypes);
    const signerWalletId = await this.resolveOrganizerSigner(
      organizerId,
      event.chain,
    );

    const admins = await this.prisma.eventTicketAdmin.findMany({
      where: {
        eventId,
        userId: { in: [...new Set(userIds)] },
        status: TicketAdminStatus.ACTIVE,
      },
    });
    if (admins.length === 0) {
      throw new BadRequestException(
        'None of the given users are active ticket admins for this event',
      );
    }

    const addresses = admins.map((a) => a.address);
    for (const ticketId of onchainTicketIds) {
      await this.circle.executeContract({
        method: 'removeTicketAdmins',
        args: [ticketId, addresses],
        chain: event.chain,
        txType: BlockchainTxType.SET_ADMINS,
        eventId,
        walletId: signerWalletId,
      });
    }

    await this.prisma.eventTicketAdmin.updateMany({
      where: { eventId, userId: { in: admins.map((a) => a.userId) } },
      data: { status: TicketAdminStatus.REVOKED },
    });

    this.logger.log(
      `Revoked ticket-admin from ${admins.length} user(s) on event ${eventId}`,
    );

    return this.listAdmins(organizerId, eventId);
  }

  /** List the event's current (active) check-in delegates. */
  async listAdmins(organizerId: string, eventId: string) {
    await this.loadOwnedEvent(eventId, organizerId);

    const admins = await this.prisma.eventTicketAdmin.findMany({
      where: { eventId, status: TicketAdminStatus.ACTIVE },
      include: {
        user: {
          select: { id: true, firstName: true, lastName: true, email: true },
        },
      },
      orderBy: { createdAt: 'asc' },
    });

    return admins.map((a) => ({
      userId: a.userId,
      name: `${a.user.firstName} ${a.user.lastName}`,
      email: a.user.email,
      address: a.address,
      status: a.status,
      grantedAt: a.createdAt,
    }));
  }

  // ---------- internals ----------

  private async loadOwnedEvent(eventId: string, organizerId: string) {
    const event = await this.prisma.event.findUnique({
      where: { id: eventId },
      include: { ticketTypes: { select: { onChainTicketId: true } } },
    });
    if (!event) {
      throw new NotFoundException('Event not found');
    }
    if (event.organizerId !== organizerId) {
      throw new ForbiddenException('You do not own this event');
    }
    return event;
  }

  private resolveOnchainTicketIds(
    ticketTypes: { onChainTicketId: bigint | null }[],
  ): bigint[] {
    const ids = ticketTypes
      .map((t) => t.onChainTicketId)
      .filter((id): id is bigint => id !== null);
    if (ids.length === 0) {
      throw new BadRequestException(
        'Event has no on-chain ticket types yet — publish must complete before delegating check-in',
      );
    }
    return ids;
  }

  private async resolveOrganizerSigner(
    organizerId: string,
    chain: string,
  ): Promise<string> {
    const wallet = await this.prisma.userWallet.findFirst({
      where: {
        userId: organizerId,
        chain,
        creationStatus: WalletCreationStatus.CREATED,
      },
      select: { circleWalletId: true },
    });
    if (!wallet?.circleWalletId) {
      throw new BadRequestException(
        `You have no ready wallet on ${chain} to sign the ticket-admin change`,
      );
    }
    return wallet.circleWalletId;
  }
}
