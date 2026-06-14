import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { BlockchainTxStatus, BlockchainTxType } from '@prisma/client';
import { Job } from 'bullmq';
import { PrismaService } from '../prisma/prisma.service';
import { CircleContractService } from './circle-contract.service';
import {
  CHECKIN_TICKET_JOB,
  CheckinTicketJobData,
  TICKET_CHECKIN_QUEUE,
} from './checkin-queue.service';

/**
 * Consumes `ticket-checkin` jobs and records the attendee's presence
 * on-chain via `checkIn(uint64 ticketId, address ticketOwner,
 * uint40 tokenId)` on the Diamond's CheckInFacet, signed by the treasury
 * (the contract's trusted backend).
 *
 * Single-file: `concurrency: 1` drains the queue in enqueue order, which
 * preserves per-event ordering and lets the mobile app flush a batch of
 * offline check-ins without races.
 *
 * Completion mirrors the mint path:
 *  - `circle.webhooksEnabled` ON (#65): submit and return; the Circle
 *    webhook reconciles the BlockchainTransaction and logs the result.
 *  - OFF (fallback): poll until terminal here.
 *
 * Conflict handling: a deterministic revert (e.g. the ticket is already
 * checked in on-chain) must NOT retry — re-submitting reverts again. We
 * detect a terminal failure, log a CheckInConflict for auditor review,
 * and return normally so Bull marks the job complete. Only transient
 * (pre-terminal) errors throw, which Bull retries with backoff.
 */
@Processor(TICKET_CHECKIN_QUEUE, { concurrency: 1 })
export class TicketCheckinProcessor extends WorkerHost {
  private readonly logger = new Logger(TicketCheckinProcessor.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly circle: CircleContractService,
    private readonly config: ConfigService,
  ) {
    super();
  }

  async process(job: Job<CheckinTicketJobData>): Promise<void> {
    if (job.name !== CHECKIN_TICKET_JOB) {
      this.logger.warn(
        `Unexpected job name on ${TICKET_CHECKIN_QUEUE}: ${job.name}`,
      );
      return;
    }

    const { ticketId, blockchainTxId } = job.data;

    const ticket = await this.prisma.ticket.findUnique({
      where: { id: ticketId },
      include: {
        ticketType: { select: { id: true, onChainTicketId: true } },
        event: { select: { id: true, chain: true } },
        buyer: { include: { wallets: true } },
      },
    });
    if (!ticket) {
      throw new Error(`Ticket ${ticketId} not found`);
    }

    // Idempotency — never double-record a check-in on-chain. A worker
    // crash between Circle submit and confirmation can replay us here.
    const alreadyConfirmed = await this.prisma.blockchainTransaction.findFirst({
      where: {
        ticketId,
        type: BlockchainTxType.CHECKIN,
        status: BlockchainTxStatus.CONFIRMED,
      },
    });
    if (alreadyConfirmed) {
      this.logger.log(
        `Ticket ${ticketId} already checked in on-chain (blockchainTxId=${alreadyConfirmed.id}); skipping`,
      );
      return;
    }

    // The on-chain check-in addresses a minted NFT — it must carry both
    // the on-chain ticket id (from the TicketType) and the per-mint
    // tokenId. Absence means the ticket was never minted; that's a hard
    // error, not something a retry fixes.
    if (ticket.tokenId === null) {
      throw new Error(
        `Ticket ${ticketId} has no tokenId — cannot check in a ticket that was never minted`,
      );
    }
    if (ticket.ticketType.onChainTicketId === null) {
      throw new Error(
        `TicketType ${ticket.ticketType.id} has no onChainTicketId — event publish incomplete`,
      );
    }
    if (!ticket.buyer) {
      throw new Error(`Ticket ${ticketId} has no buyer; cannot resolve owner`);
    }
    const wallet = ticket.buyer.wallets.find(
      (w) => w.chain === ticket.event.chain,
    );
    if (!wallet?.address) {
      throw new Error(
        `Buyer ${ticket.buyer.id} has no wallet on chain ${ticket.event.chain}`,
      );
    }

    try {
      const args = [
        ticket.ticketType.onChainTicketId, // uint64 _ticketId
        wallet.address, // address _ticketOwner
        ticket.tokenId, // uint40 _tokenId
      ];

      const { circleTransactionId } = await this.circle.executeContract({
        method: 'checkIn',
        args,
        chain: ticket.event.chain,
        txType: BlockchainTxType.CHECKIN,
        eventId: ticket.event.id,
        ticketId: ticket.id,
        existingBlockchainTransactionId: blockchainTxId,
      });

      this.logger.log(
        `checkIn submitted (ticket=${ticket.id}, circleTxId=${circleTransactionId})`,
      );

      // Webhook is authoritative for completion when enabled (#65).
      if (this.config.get<boolean>('circle.webhooksEnabled')) {
        this.logger.log(
          `checkIn awaiting Circle webhook for completion (ticket=${ticket.id})`,
        );
        return;
      }

      // Fallback: poll until terminal. checkIn lands in one block.
      const final = await this.circle.pollUntilTerminal(circleTransactionId, {
        intervalMs: 4_000,
        timeoutMs: 180_000,
      });

      if (final.state === 'CONFIRMED' || final.state === 'COMPLETE') {
        this.logger.log(
          `On-chain check-in recorded (ticket=${ticket.id}, txHash=${final.txHash})`,
        );
        return;
      }

      // Terminal failure → conflict (most likely already checked in
      // on-chain). reconcile() inside pollUntilTerminal already marked
      // the row FAILED. Do NOT throw — a revert won't succeed on retry.
      this.logger.error(
        `CheckInConflict: on-chain checkIn for ticket=${ticket.id} ended ${final.state} ` +
          `(${final.errorReason ?? 'no reason'}) — auditor review, no retry`,
      );
    } catch (error) {
      // Pre-terminal (transient) failure — Circle/RPC error before a
      // terminal state. Mark the row and rethrow so Bull retries.
      const message = error instanceof Error ? error.message : 'unknown error';
      const isFinal = job.attemptsMade + 1 >= (job.opts.attempts ?? 1);

      await this.prisma.blockchainTransaction.update({
        where: { id: blockchainTxId },
        data: {
          status: isFinal
            ? BlockchainTxStatus.FAILED
            : BlockchainTxStatus.PENDING,
          error: message.slice(0, 500),
        },
      });

      this.logger.warn(
        `checkIn attempt ${job.attemptsMade + 1} failed (ticket=${ticketId}): ${message}`,
      );
      throw error;
    }
  }
}
