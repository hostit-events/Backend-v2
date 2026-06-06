import { Injectable, Logger } from '@nestjs/common';
import { TicketStatus, WalletCreationStatus } from '@prisma/client';
import { Interface, type LogDescription } from 'ethers';
import { PrismaService } from '../prisma/prisma.service';
import { NotificationsService } from '../notifications/notifications.service';
import { QrCodeService } from '../tickets/qr-code.service';
import { diamondAbi } from './abis';
import { BlockchainReadService } from './blockchain-read.service';

/**
 * Shared post-mint finalization. Given a confirmed `mintTicket` tx
 * hash, recovers the on-chain `tokenId` from the `TicketMinted` event,
 * flips the Ticket to CONFIRMED, issues a signed QR, and fires the
 * confirmation email.
 *
 * Extracted so both completion paths can drive it identically:
 *  - the polling fallback in MintTicketProcessor (pre-#65), and
 *  - the Circle webhook handler (#65), which is authoritative once
 *    `circle.webhooksEnabled` is on.
 *
 * Idempotent: a ticket that already carries a `tokenId` and is
 * CONFIRMED is a no-op, so whichever path wins the race finalizes and
 * the other simply returns.
 */
@Injectable()
export class MintFinalizerService {
  private readonly logger = new Logger(MintFinalizerService.name);
  private readonly iface = new Interface(diamondAbi);

  constructor(
    private readonly prisma: PrismaService,
    private readonly read: BlockchainReadService,
    private readonly qrCode: QrCodeService,
    private readonly notifications: NotificationsService,
  ) {}

  /**
   * Finalize a minted ticket from its confirmed tx hash.
   * Returns true if it performed finalization, false if it was a
   * no-op (already finalized).
   */
  async finalize(ticketId: string, txHash: string): Promise<boolean> {
    const ticket = await this.prisma.ticket.findUnique({
      where: { id: ticketId },
      include: {
        ticketType: true,
        event: {
          select: {
            id: true,
            name: true,
            chain: true,
            slug: true,
            venue: true,
            startTime: true,
          },
        },
        buyer: { include: { wallets: true } },
      },
    });

    if (!ticket) {
      throw new Error(`Ticket ${ticketId} not found`);
    }

    // Idempotency — already finalized by the other completion path.
    if (ticket.tokenId !== null && ticket.status === TicketStatus.CONFIRMED) {
      this.logger.log(
        `Ticket ${ticketId} already finalized (tokenId=${ticket.tokenId}); skipping`,
      );
      return false;
    }

    if (ticket.ticketType.onChainTicketId === null) {
      throw new Error(
        `TicketType ${ticket.ticketType.id} has no onChainTicketId — cannot finalize`,
      );
    }

    const wallet = ticket.buyer?.wallets.find(
      (w) => w.chain === ticket.event.chain,
    );
    if (
      !wallet ||
      !wallet.address ||
      wallet.creationStatus !== WalletCreationStatus.CREATED
    ) {
      throw new Error(
        `Ticket ${ticketId} buyer wallet not ready on ${ticket.event.chain}; cannot finalize`,
      );
    }

    const tokenId = await this.extractTokenId(ticket.event.chain, txHash);

    // Schema note: Ticket.tokenId is `Int` (32-bit) while the on-chain
    // type is uint40. We cast via Number() — safe up to 2.1B mints,
    // which testnet won't approach. Widen the column to BigInt before
    // mainnet if total per-Diamond mint count is expected to cross it.
    await this.prisma.ticket.update({
      where: { id: ticket.id },
      data: { tokenId: Number(tokenId), status: TicketStatus.CONFIRMED },
    });

    this.logger.log(
      `Ticket finalized (ticket=${ticket.id}, tokenId=${tokenId}, txHash=${txHash})`,
    );

    await this.issueQrAndNotify({
      ticketId: ticket.id,
      chain: ticket.event.chain,
      onChainTicketId: ticket.ticketType.onChainTicketId,
      tokenId,
      ownerAddress: wallet.address,
      buyerEmail: ticket.buyerEmail,
      buyerName: ticket.buyerName,
      eventName: ticket.event.name,
      eventStart: ticket.event.startTime,
      eventVenue: ticket.event.venue,
      ticketTypeName: ticket.ticketType.name,
      ticketReference: ticket.reference,
    });

    return true;
  }

  // ---------- internals ----------

  private async extractTokenId(chain: string, txHash: string): Promise<bigint> {
    const provider = this.read.getProvider(chain);
    const receipt = await provider.getTransactionReceipt(txHash);
    if (!receipt) {
      throw new Error(`No receipt for tx ${txHash} on ${chain}`);
    }

    let minted: LogDescription | null = null;
    for (const log of receipt.logs) {
      try {
        const parsed = this.iface.parseLog({
          topics: Array.from(log.topics),
          data: log.data,
        });
        if (parsed?.name === 'TicketMinted') {
          minted = parsed;
          break;
        }
      } catch {
        // not a known facet event — skip
      }
    }

    if (!minted) {
      throw new Error(
        `TicketMinted event not found in receipt for tx ${txHash}`,
      );
    }
    return minted.args.tokenId as bigint;
  }

  private async issueQrAndNotify(input: {
    ticketId: string;
    chain: string;
    onChainTicketId: bigint;
    tokenId: bigint;
    ownerAddress: string;
    buyerEmail: string;
    buyerName: string;
    eventName: string;
    eventStart: Date;
    eventVenue: string;
    ticketTypeName: string;
    ticketReference: string;
  }): Promise<void> {
    const issued = await this.qrCode.issue({
      chain: input.chain,
      ticketId: input.onChainTicketId.toString(),
      tokenId: input.tokenId.toString(),
      owner: input.ownerAddress,
    });

    // Persist the signed token (not the data URL — that's reproducible
    // from the token, and storing a 12KB PNG per ticket is wasteful).
    await this.prisma.ticket.update({
      where: { id: input.ticketId },
      data: { qrCode: issued.token },
    });

    try {
      await this.notifications.enqueue({
        type: 'TICKET_CONFIRMATION',
        to: input.buyerEmail,
        ticketId: input.ticketId,
        data: {
          buyerName: input.buyerName,
          eventName: input.eventName,
          eventStart: input.eventStart,
          eventVenue: input.eventVenue,
          ticketTypeName: input.ticketTypeName,
          ticketReference: input.ticketReference,
          qrDataUrl: issued.dataUrl,
        },
      });
    } catch (err) {
      this.logger.warn(
        `Failed to enqueue ticket confirmation email for ${input.ticketId}: ${(err as Error).message}`,
      );
    }
  }
}
