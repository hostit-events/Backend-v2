import { InjectQueue } from '@nestjs/bullmq';
import { Injectable, Logger } from '@nestjs/common';
import { BlockchainTxStatus, BlockchainTxType } from '@prisma/client';
import { Queue } from 'bullmq';
import { PrismaService } from '../prisma/prisma.service';

export const TICKET_REFUND_QUEUE = 'ticket-refund';
export const REFUND_TICKET_JOB = 'refund-ticket';

export interface RefundTicketJobData {
  ticketId: string;
  eventId: string;
  blockchainTxId: string;
}

/**
 * Producer for the `ticket-refund` queue. Called when a PUBLISHED event
 * with sold tickets is cancelled — one enqueue per crypto-paid Ticket,
 * so a cancelled event with N such tickets fans out into N independent
 * refund jobs (mirrors MintQueueService).
 *
 * Only crypto (USDC) tickets are enqueued: the on-chain `claimRefund`
 * reverts `FiatTicketNotRefundable` for fiat-minted tickets, so those
 * are handled off-chain (out of scope here — cancelEvent logs them as
 * pending). The producer stays rail-agnostic; the caller filters.
 *
 * The BlockchainTransaction row is written eagerly at enqueue time so we
 * always have an audit row. The worker (RefundProcessor) attaches the
 * Circle transaction id to this row when it submits to the chain.
 */
@Injectable()
export class RefundQueueService {
  private readonly logger = new Logger(RefundQueueService.name);

  constructor(
    private readonly prisma: PrismaService,
    @InjectQueue(TICKET_REFUND_QUEUE) private readonly queue: Queue,
  ) {}

  async enqueueRefund(ticketId: string, eventId: string): Promise<void> {
    const blockchainTx = await this.prisma.blockchainTransaction.create({
      data: {
        ticketId,
        eventId,
        type: BlockchainTxType.REFUND,
        status: BlockchainTxStatus.PENDING,
      },
    });

    await this.queue.add(
      REFUND_TICKET_JOB,
      {
        ticketId,
        eventId,
        blockchainTxId: blockchainTx.id,
      } satisfies RefundTicketJobData,
      {
        // Refund moves real on-chain value (escrowed USDC back to the
        // buyer). Five attempts with exponential backoff rides out
        // transient Circle outages; the processor short-circuits the
        // contract's terminal reverts (window expired, not refundable)
        // so those don't burn the full retry budget.
        attempts: 5,
        backoff: { type: 'exponential', delay: 10_000 },
        removeOnComplete: { age: 60 * 60 * 24, count: 1000 },
        removeOnFail: { age: 60 * 60 * 24 * 7 },
      },
    );

    this.logger.log(
      `Queued ticket-refund for ticket=${ticketId} event=${eventId} blockchainTxId=${blockchainTx.id}`,
    );
  }
}
