import { InjectQueue } from '@nestjs/bullmq';
import { Injectable, Logger } from '@nestjs/common';
import { BlockchainTxStatus, BlockchainTxType } from '@prisma/client';
import { Queue } from 'bullmq';
import { PrismaService } from '../prisma/prisma.service';

export const TICKET_MINT_QUEUE = 'ticket-mint';
export const MINT_TICKET_JOB = 'mint-ticket';

export interface MintTicketJobData {
  ticketId: string;
  eventId: string;
  blockchainTxId: string;
}

/**
 * Producer for the `ticket-mint` queue. Called by the webhook handler
 * after a payment confirms — one enqueue per Ticket row, so a quantity
 * of N purchases fans out into N independent mint jobs.
 *
 * The BlockchainTransaction row is written eagerly at enqueue time so
 * we always have an audit row, even if the queue itself is briefly
 * unreachable. The worker (MintTicketProcessor) attaches the Circle
 * transaction id to this row when it submits to the chain.
 */
@Injectable()
export class MintQueueService {
  private readonly logger = new Logger(MintQueueService.name);

  constructor(
    private readonly prisma: PrismaService,
    @InjectQueue(TICKET_MINT_QUEUE) private readonly queue: Queue,
  ) {}

  async enqueueMint(ticketId: string, eventId: string): Promise<void> {
    const blockchainTx = await this.prisma.blockchainTransaction.create({
      data: {
        ticketId,
        eventId,
        type: BlockchainTxType.MINT,
        status: BlockchainTxStatus.PENDING,
      },
    });

    await this.queue.add(
      MINT_TICKET_JOB,
      {
        ticketId,
        eventId,
        blockchainTxId: blockchainTx.id,
      } satisfies MintTicketJobData,
      {
        // Mint is high-cost (real ETH gas, real on-chain state). Five
        // attempts with exponential backoff covers transient Circle
        // outages and the wallet-not-ready window for guest buyers
        // whose wallet is still provisioning at payment-confirm time.
        attempts: 5,
        backoff: { type: 'exponential', delay: 10_000 },
        removeOnComplete: { age: 60 * 60 * 24, count: 1000 },
        removeOnFail: { age: 60 * 60 * 24 * 7 },
      },
    );

    this.logger.log(
      `Queued ticket-mint for ticket=${ticketId} event=${eventId} blockchainTxId=${blockchainTx.id}`,
    );
  }
}
