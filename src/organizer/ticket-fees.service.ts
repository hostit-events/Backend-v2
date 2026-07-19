import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  BlockchainTxType,
  EventStatus,
  Prisma,
  WalletCreationStatus,
} from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { CircleContractService } from '../blockchain/circle-contract.service';
import { computeUsdcFees, FEE_TYPE_USDC } from '../blockchain/onchain-fees';

/**
 * Organizer-facing ticket price updates. A published event's ticket price
 * is set on-chain once at publish (NGN → USDC 6-dp ticketFee). This lets
 * the organizer change it afterwards via organizer-signed
 * `updateTicketFees`, re-deriving the on-chain fee the same way publish
 * does. Only future mints are affected — already-minted tickets keep the
 * price they were bought at.
 */
@Injectable()
export class TicketFeesService {
  private readonly logger = new Logger(TicketFeesService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly circle: CircleContractService,
    private readonly config: ConfigService,
  ) {}

  async updateFee(
    organizerId: string,
    eventId: string,
    ticketTypeId: string,
    priceNgn: number,
  ) {
    const event = await this.prisma.event.findUnique({
      where: { id: eventId },
      select: {
        organizerId: true,
        chain: true,
        isFree: true,
        status: true,
        startTime: true,
      },
    });
    if (!event) {
      throw new NotFoundException('Event not found');
    }
    if (event.organizerId !== organizerId) {
      throw new ForbiddenException('You do not own this event');
    }
    if (event.isFree) {
      throw new BadRequestException(
        'Free events have no on-chain fee to update',
      );
    }
    if (event.status !== EventStatus.PUBLISHED) {
      throw new BadRequestException(
        'Only published events have an on-chain fee — edit the draft price directly',
      );
    }
    if (Date.now() >= event.startTime.getTime()) {
      throw new BadRequestException(
        'Cannot change ticket price after the event has started',
      );
    }

    const ticketType = await this.prisma.ticketType.findFirst({
      where: { id: ticketTypeId, eventId },
      select: { id: true, name: true, onChainTicketId: true },
    });
    if (!ticketType) {
      throw new NotFoundException('Ticket type not found for this event');
    }
    if (ticketType.onChainTicketId === null) {
      throw new BadRequestException(
        'Ticket type is not on-chain yet — publish must complete first',
      );
    }

    const signerWalletId = await this.resolveOrganizerSigner(
      organizerId,
      event.chain,
    );

    const usdcNgnRate = this.config.getOrThrow<number>('crypto.usdcNgnRate');
    const { ticketFee } = computeUsdcFees(priceNgn, usdcNgnRate);

    // Organizer-signed on-chain fee update. Submitted async (webhook
    // reconciles the BlockchainTransaction). Only the DB price is updated
    // after a successful submit; a failed submit leaves both untouched.
    await this.circle.executeContract({
      method: 'updateTicketFees',
      args: [ticketType.onChainTicketId, [FEE_TYPE_USDC], [BigInt(ticketFee)]],
      chain: event.chain,
      txType: BlockchainTxType.SET_FEES,
      eventId,
      walletId: signerWalletId,
    });

    const updated = await this.prisma.ticketType.update({
      where: { id: ticketTypeId },
      data: { price: new Prisma.Decimal(priceNgn) },
      select: { id: true, name: true, price: true },
    });

    this.logger.log(
      `Updated fee for ticketType ${ticketTypeId} (event ${eventId}) → ` +
        `${priceNgn} NGN / ${ticketFee} USDC base units`,
    );

    return {
      ticketTypeId: updated.id,
      name: updated.name,
      priceNgn: updated.price,
      onChainTicketId: ticketType.onChainTicketId.toString(),
      onChainFeeUsdc: ticketFee,
    };
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
        `You have no ready wallet on ${chain} to sign the fee update`,
      );
    }
    return wallet.circleWalletId;
  }
}
