import { Injectable, Logger } from '@nestjs/common';
import { TicketStatus } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';

/**
 * Shared post-refund finalization. Given a confirmed `claimRefund` tx
 * hash, flips the Ticket to REFUNDED, stamps `refundedAt`/`refundTxHash`,
 * and releases the seat by decrementing the TicketType's soldCount.
 *
 * Extracted so both completion paths drive it identically:
 *  - the polling fallback in RefundProcessor, and
 *  - the Circle webhook handler, authoritative once
 *    `circle.webhooksEnabled` is on.
 *
 * Idempotent: a ticket already REFUNDED is a no-op, so whichever path
 * wins the race finalizes and the other simply returns — the soldCount
 * decrement therefore runs at most once per ticket.
 */
@Injectable()
export class RefundFinalizerService {
  private readonly logger = new Logger(RefundFinalizerService.name);

  constructor(private readonly prisma: PrismaService) {}

  /**
   * Finalize a refunded ticket from its confirmed tx hash. Returns true
   * if it performed finalization, false if it was a no-op (already
   * finalized by the other completion path).
   */
  async finalize(ticketId: string, txHash: string): Promise<boolean> {
    const ticket = await this.prisma.ticket.findUnique({
      where: { id: ticketId },
      select: { id: true, status: true, ticketTypeId: true },
    });

    if (!ticket) {
      throw new Error(`Ticket ${ticketId} not found`);
    }

    // Idempotency — already finalized (webhook + poll race, or webhook
    // re-delivery). Guard the soldCount decrement behind the status flip
    // so it can never double-count.
    if (ticket.status === TicketStatus.REFUNDED) {
      this.logger.log(
        `Ticket ${ticketId} already refunded; skipping finalization`,
      );
      return false;
    }

    // Flip status + release the seat atomically. updateMany with a
    // status guard makes the write a compare-and-set: a concurrent
    // finalizer that already flipped the row updates zero rows, so we
    // skip the decrement for it too.
    const flipped = await this.prisma.$transaction(async (db) => {
      const { count } = await db.ticket.updateMany({
        where: { id: ticketId, status: { not: TicketStatus.REFUNDED } },
        data: {
          status: TicketStatus.REFUNDED,
          refundedAt: new Date(),
          refundTxHash: txHash,
        },
      });

      if (count === 0) {
        return false;
      }

      await db.ticketType.update({
        where: { id: ticket.ticketTypeId },
        data: { soldCount: { decrement: 1 } },
      });
      return true;
    });

    if (!flipped) {
      this.logger.log(
        `Ticket ${ticketId} refunded by a concurrent finalizer; skipping`,
      );
      return false;
    }

    this.logger.log(`Ticket refunded (ticket=${ticketId}, txHash=${txHash})`);
    return true;
  }
}
