import { InjectQueue } from '@nestjs/bullmq';
import { Injectable, Logger } from '@nestjs/common';
import { BlockchainTxStatus, BlockchainTxType } from '@prisma/client';
import { Queue } from 'bullmq';
import { PrismaService } from '../prisma/prisma.service';

export const TICKET_CHECKIN_QUEUE = 'ticket-checkin';
export const CHECKIN_TICKET_JOB = 'checkin-ticket';

export interface CheckinTicketJobData {
  ticketId: string;
  eventId: string;
  blockchainTxId: string;
  /** Optional audit context from the scanning client. */
  scannedBy?: string;
  scannedAt?: string;
}

/**
 * Producer for the `ticket-checkin` queue. Called once per door check-in
 * (the on-chain record of an attendee marked present). The off-chain
 * ticket transition to USED is owned by the check-in endpoint (#24);
 * this queue only records the action on-chain via `CheckInFacet.checkIn`.
 *
 * A BlockchainTransaction row (type CHECKIN) is written eagerly so we
 * always have an audit row; the worker attaches the Circle transaction
 * id when it submits.
 *
 * Ordering: the worker runs single-file (concurrency 1) so check-ins
 * settle in enqueue order — this also lets the mobile app drain a batch
 * of offline check-ins without races.
 */
@Injectable()
export class CheckinQueueService {
  private readonly logger = new Logger(CheckinQueueService.name);

  constructor(
    private readonly prisma: PrismaService,
    @InjectQueue(TICKET_CHECKIN_QUEUE) private readonly queue: Queue,
  ) {}

  async enqueueCheckin(
    ticketId: string,
    eventId: string,
    meta: { scannedBy?: string; scannedAt?: string } = {},
  ): Promise<void> {
    const blockchainTx = await this.prisma.blockchainTransaction.create({
      data: {
        ticketId,
        eventId,
        type: BlockchainTxType.CHECKIN,
        status: BlockchainTxStatus.PENDING,
      },
    });

    await this.queue.add(
      CHECKIN_TICKET_JOB,
      {
        ticketId,
        eventId,
        blockchainTxId: blockchainTx.id,
        scannedBy: meta.scannedBy,
        scannedAt: meta.scannedAt,
      } satisfies CheckinTicketJobData,
      {
        // A revert (e.g. already checked in on-chain) is deterministic
        // and handled as a conflict without retrying; these attempts
        // only cover transient Circle/RPC failures before submission.
        attempts: 3,
        backoff: { type: 'exponential', delay: 10_000 },
        removeOnComplete: { age: 60 * 60 * 24, count: 1000 },
        removeOnFail: { age: 60 * 60 * 24 * 7 },
      },
    );

    this.logger.log(
      `Queued ticket-checkin for ticket=${ticketId} event=${eventId} blockchainTxId=${blockchainTx.id}`,
    );
  }
}
