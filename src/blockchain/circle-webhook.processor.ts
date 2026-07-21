import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Logger } from '@nestjs/common';
import {
  BlockchainTxType,
  CryptoDepositStatus,
  Prisma,
  TransactionStatus,
} from '@prisma/client';
import { Job } from 'bullmq';
import { PrismaService } from '../prisma/prisma.service';
import { CircleContractService } from './circle-contract.service';
import { MintFinalizerService } from './mint-finalizer.service';
import { MintQueueService } from './mint-queue.service';
import { RefundFinalizerService } from './refund-finalizer.service';
import {
  CIRCLE_WEBHOOK_JOB,
  CIRCLE_WEBHOOK_QUEUE,
  CircleWebhookJobData,
} from './circle-webhook.queue';

/** Circle terminal success states (see mapCircleState in circle-contract). */
const CONFIRMED_STATES = new Set(['CONFIRMED', 'COMPLETE']);
/** Circle terminal failure states. */
const FAILED_STATES = new Set(['FAILED', 'DENIED', 'CANCELLED', 'STUCK']);

/** Transaction resource carried inside a `transactions.*` notification. */
interface CircleTxResource {
  id?: string;
  state?: string;
  txHash?: string;
  blockHeight?: number;
  errorReason?: string;
  /** Receiving (inbound) / sending (outbound) Circle wallet id. */
  walletId?: string;
  /** Transfer amounts as decimal strings; USDC uses amounts[0]. */
  amounts?: string[];
}

/**
 * Processes verified Circle webhooks (#65). Loads the audit row, parses
 * the notification, and dispatches by type.
 *
 * - **Contract executions** we initiated (`transactions.outbound`,
 *   matched by `circleTransactionId` → BlockchainTransaction): reconcile
 *   the row's status; on a confirmed MINT run MintFinalizerService.
 * - **Inbound USDC deposits** (`transactions.inbound`, #69 crypto
 *   checkout): matched by receiving `walletId` + amount → a PENDING
 *   CryptoDeposit; settle the linked transaction and enqueue mints.
 * - Organizer payouts (#68) are not yet handled.
 *
 * Replay-safe: the WebhookEvent.processedAt guard, plus idempotent
 * reconcile/finalize and the CryptoDeposit/transaction status guards,
 * make re-delivery of the same notification a no-op.
 */
@Processor(CIRCLE_WEBHOOK_QUEUE)
export class CircleWebhookProcessor extends WorkerHost {
  private readonly logger = new Logger(CircleWebhookProcessor.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly circle: CircleContractService,
    private readonly finalizer: MintFinalizerService,
    private readonly refundFinalizer: RefundFinalizerService,
    private readonly mintQueue: MintQueueService,
  ) {
    super();
  }

  async process(job: Job<CircleWebhookJobData>): Promise<void> {
    if (job.name !== CIRCLE_WEBHOOK_JOB) {
      this.logger.warn(
        `Unexpected job name on ${CIRCLE_WEBHOOK_QUEUE}: ${job.name}`,
      );
      return;
    }

    const { webhookEventId } = job.data;
    const event = await this.prisma.webhookEvent.findUnique({
      where: { id: webhookEventId },
    });
    if (!event) {
      this.logger.warn(`WebhookEvent ${webhookEventId} not found; skipping`);
      return;
    }
    if (event.processedAt) {
      this.logger.log(
        `WebhookEvent ${webhookEventId} already processed; skipping`,
      );
      return;
    }

    try {
      await this.dispatch(event.type, event.payload as Record<string, unknown>);
      await this.prisma.webhookEvent.update({
        where: { id: webhookEventId },
        data: { processedAt: new Date(), error: null },
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : 'unknown error';
      await this.prisma.webhookEvent.update({
        where: { id: webhookEventId },
        data: { error: message.slice(0, 500) },
      });
      throw err; // let Bull retry transient failures
    }
  }

  // ---------- dispatch ----------

  private async dispatch(
    type: string | null,
    payload: Record<string, unknown>,
  ): Promise<void> {
    const notificationType =
      type ?? (payload.notificationType as string | undefined);

    if (!notificationType || notificationType === 'webhooks.test') {
      this.logger.log(
        `Circle webhook: ${notificationType ?? 'untyped'} — nothing to process`,
      );
      return;
    }

    if (notificationType === 'transactions.inbound') {
      await this.handleInboundDeposit(payload);
      return;
    }

    if (notificationType.startsWith('transactions.')) {
      await this.handleContractExecution(payload);
      return;
    }

    // notifications.*, wallets.*, etc. — no handler yet.
    this.logger.log(`Circle webhook: no handler for type=${notificationType}`);
  }

  /**
   * Inbound USDC deposit → settle a crypto ticket purchase. Matches the
   * receiving wallet + amount to a PENDING CryptoDeposit, marks it
   * CONFIRMED, flips the linked transaction to SUCCESS, and enqueues a
   * mint per ticket (mirrors WebhooksService.handleSuccess).
   */
  private async handleInboundDeposit(
    payload: Record<string, unknown>,
  ): Promise<void> {
    const tx = (payload.notification ?? {}) as CircleTxResource;
    const { id: circleTxId, state, walletId } = tx;
    const amount = tx.amounts?.[0];

    if (!state || !walletId || amount === undefined) {
      this.logger.warn(
        'Circle webhook: inbound notification missing state/walletId/amount',
      );
      return;
    }

    // Only act on a confirmed inbound transfer.
    if (!CONFIRMED_STATES.has(state)) {
      this.logger.log(
        `Circle webhook: inbound to wallet ${walletId} non-terminal state=${state}`,
      );
      return;
    }

    const amountUsdc = new Prisma.Decimal(amount);
    const deposit = await this.prisma.cryptoDeposit.findFirst({
      where: {
        walletId,
        status: CryptoDepositStatus.PENDING,
        amountUsdc: { lte: amountUsdc },
      },
      orderBy: { createdAt: 'asc' },
    });

    if (!deposit) {
      this.logger.log(
        `Circle webhook: inbound USDC to wallet ${walletId} (amount=${amount}) matched no pending deposit — ignoring`,
      );
      return;
    }

    // Mark the deposit confirmed and settle the transaction + tickets in
    // one write. Idempotent: the transaction status guard makes a
    // re-delivered inbound a no-op (returns no tickets to enqueue).
    const tickets = await this.prisma.$transaction(async (db) => {
      await db.cryptoDeposit.update({
        where: { id: deposit.id },
        data: {
          status: CryptoDepositStatus.CONFIRMED,
          circleTransactionId: circleTxId,
          txHash: tx.txHash,
        },
      });

      const transaction = await db.transaction.findUnique({
        where: { id: deposit.transactionId },
      });
      if (!transaction || transaction.status !== TransactionStatus.PENDING) {
        return [] as { id: string; eventId: string }[];
      }

      await db.transaction.update({
        where: { id: transaction.id },
        data: {
          status: TransactionStatus.SUCCESS,
          providerReference: circleTxId,
        },
      });

      return db.ticket.findMany({
        where: { transactionId: transaction.id },
        select: { id: true, eventId: true },
      });
    });

    // Enqueue mints after the settlement commits.
    for (const ticket of tickets) {
      await this.mintQueue.enqueueMint(ticket.id, ticket.eventId);
    }

    this.logger.log(
      `Crypto deposit settled (deposit=${deposit.id}, txn=${deposit.transactionId}, mints=${tickets.length})`,
    );
  }

  private async handleContractExecution(
    payload: Record<string, unknown>,
  ): Promise<void> {
    const tx = (payload.notification ?? {}) as CircleTxResource;
    const circleTxId = tx.id;
    const state = tx.state;

    if (!circleTxId || !state) {
      this.logger.warn(
        'Circle webhook: transaction notification missing id/state',
      );
      return;
    }

    const bt = await this.prisma.blockchainTransaction.findUnique({
      where: { circleTransactionId: circleTxId },
    });

    if (!bt) {
      // Not a contract execution we initiated — likely an inbound USDC
      // deposit (#69) or an organizer payout (#68). Phase 2 wires these.
      this.logger.log(
        `Circle webhook: no tracked tx for circleTxId=${circleTxId} (Phase 2 path)`,
      );
      return;
    }

    // Mirror Circle's state onto the BlockchainTransaction row.
    await this.circle.reconcile(circleTxId, {
      state,
      txHash: tx.txHash,
      blockHeight: tx.blockHeight,
      errorReason: tx.errorReason,
    });

    if (CONFIRMED_STATES.has(state)) {
      if (bt.type === BlockchainTxType.MINT && bt.ticketId) {
        if (!tx.txHash) {
          throw new Error(
            `Confirmed mint webhook for ${circleTxId} has no txHash`,
          );
        }
        await this.finalizer.finalize(bt.ticketId, tx.txHash);
      } else if (bt.type === BlockchainTxType.REFUND && bt.ticketId) {
        if (!tx.txHash) {
          throw new Error(
            `Confirmed refund webhook for ${circleTxId} has no txHash`,
          );
        }
        await this.refundFinalizer.finalize(bt.ticketId, tx.txHash);
      } else if (bt.type === BlockchainTxType.CHECKIN) {
        // The door already flipped the ticket to USED (#24); the
        // confirmed CHECKIN tx is the on-chain audit record, now
        // reconciled onto the BlockchainTransaction row above.
        this.logger.log(
          `Circle webhook: on-chain check-in recorded (ticket=${bt.ticketId ?? 'n/a'}, tx=${circleTxId})`,
        );
      } else {
        this.logger.log(
          `Circle webhook: confirmed ${bt.type} tx ${circleTxId} (no finalizer for this type yet)`,
        );
      }
    } else if (FAILED_STATES.has(state)) {
      // reconcile() already marked the row FAILED; this is the
      // dead-letter / alerting hook.
      if (bt.type === BlockchainTxType.CHECKIN) {
        // A reverted check-in is most likely a duplicate (already
        // checked in on-chain). Surface it for auditor review — no
        // retry, the off-chain USED state is unaffected.
        this.logger.error(
          `CheckInConflict: on-chain checkIn FAILED (ticket=${bt.ticketId ?? 'n/a'}, tx=${circleTxId}, ` +
            `reason=${tx.errorReason ?? 'n/a'}) — auditor review`,
        );
      } else {
        this.logger.error(
          `Circle webhook: ${bt.type} tx ${circleTxId} FAILED (state=${state}, reason=${tx.errorReason ?? 'n/a'})`,
        );
      }
    } else {
      this.logger.log(
        `Circle webhook: ${bt.type} tx ${circleTxId} non-terminal state=${state}`,
      );
    }
  }
}
