import { InjectQueue } from '@nestjs/bullmq';
import { Injectable, Logger } from '@nestjs/common';
import { BlockchainTxStatus, BlockchainTxType } from '@prisma/client';
import { Queue } from 'bullmq';
import { PrismaService } from '../prisma/prisma.service';

export const TICKET_PAYOUT_QUEUE = 'ticket-payout';
export const PAYOUT_TICKET_JOB = 'payout-ticket';

export interface PayoutTicketJobData {
  /** TicketType whose on-chain escrow balance is being withdrawn. */
  ticketTypeId: string;
  eventId: string;
  blockchainTxId: string;
}

/**
 * Producer for the `ticket-payout` queue. Withdraws an organizer's
 * escrowed USDC from the Diamond via `withdrawTicketBalance`, one job
 * per TicketType (the on-chain unit — escrow accrues per on-chain
 * ticketId).
 *
 * Only crypto revenue for REFUNDABLE events is escrowed on-chain and
 * therefore withdrawable here: non-refundable crypto pays the organizer
 * instantly at mint, and fiat is split to the organizer's bank at
 * purchase time via Paystack/Monnify subaccounts — neither touches this
 * queue.
 *
 * Trigger-agnostic: the caller (the #46 organizer request endpoint, or a
 * future payout cron) decides which ticket types to enqueue. The
 * BlockchainTransaction row is written eagerly so there's always an audit
 * row; the worker attaches the Circle transaction id when it submits.
 */
@Injectable()
export class PayoutQueueService {
  private readonly logger = new Logger(PayoutQueueService.name);

  constructor(
    private readonly prisma: PrismaService,
    @InjectQueue(TICKET_PAYOUT_QUEUE) private readonly queue: Queue,
  ) {}

  async enqueuePayout(ticketTypeId: string, eventId: string): Promise<void> {
    const blockchainTx = await this.prisma.blockchainTransaction.create({
      data: {
        eventId,
        type: BlockchainTxType.WITHDRAW,
        status: BlockchainTxStatus.PENDING,
      },
    });

    await this.queue.add(
      PAYOUT_TICKET_JOB,
      {
        ticketTypeId,
        eventId,
        blockchainTxId: blockchainTx.id,
      } satisfies PayoutTicketJobData,
      {
        // Withdraw moves real on-chain value to the organizer. Five
        // attempts with exponential backoff rides out transient Circle
        // outages; the processor short-circuits terminal reverts
        // (insufficient balance, unauthorized) so those don't burn the
        // full budget.
        attempts: 5,
        backoff: { type: 'exponential', delay: 10_000 },
        removeOnComplete: { age: 60 * 60 * 24, count: 1000 },
        removeOnFail: { age: 60 * 60 * 24 * 7 },
      },
    );

    this.logger.log(
      `Queued ticket-payout for ticketType=${ticketTypeId} event=${eventId} blockchainTxId=${blockchainTx.id}`,
    );
  }
}
