import { Injectable, Logger } from '@nestjs/common';
import { BlockchainTxStatus, BlockchainTxType } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';

/**
 * STUB — Phase 6 will replace this with a real BullMQ producer that
 * dispatches to a worker calling `mintTicket` on the Diamond contract.
 *
 * For now we record the intent in `BlockchainTransaction` (status:
 * PENDING) so the webhook flow has a complete audit trail and the real
 * implementation only has to drain pending rows.
 *
 * NOTE (Phase 7 — #40): when the mint worker confirms an on-chain
 * mint for a Ticket, it should:
 *   1. Persist `Ticket.tokenId` + the buyer's wallet address.
 *   2. Call `QrCodeService.issue({ chain, ticketId, tokenId, owner })`
 *      and store the token on `Ticket.qrCode`.
 *   3. Enqueue a TICKET_CONFIRMATION email via NotificationsService,
 *      passing the QR data URL + ticket/event metadata.
 * Issue #40 ships the template and dispatcher; the actual hook lives
 * with the Phase 6 mint worker that owns step 1.
 */
@Injectable()
export class MintQueueService {
  private readonly logger = new Logger(MintQueueService.name);

  constructor(private readonly prisma: PrismaService) {}

  async enqueueMint(ticketId: string, eventId: string): Promise<void> {
    await this.prisma.blockchainTransaction.create({
      data: {
        ticketId,
        eventId,
        type: BlockchainTxType.MINT,
        status: BlockchainTxStatus.PENDING,
      },
    });
    this.logger.log(
      `[STUB] queued ticket-mint for ticket=${ticketId} event=${eventId}`,
    );
  }
}
