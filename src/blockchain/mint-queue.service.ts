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
