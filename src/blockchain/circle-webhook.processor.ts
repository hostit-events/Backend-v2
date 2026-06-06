import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Logger } from '@nestjs/common';
import { BlockchainTxType } from '@prisma/client';
import { Job } from 'bullmq';
import { PrismaService } from '../prisma/prisma.service';
import { CircleContractService } from './circle-contract.service';
import { MintFinalizerService } from './mint-finalizer.service';
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
}

/**
 * Processes verified Circle webhooks (#65). Loads the audit row, parses
 * the notification, and dispatches by type.
 *
 * Phase 1 handles **contract executions** we initiated (matched by
 * `circleTransactionId` → BlockchainTransaction): reconcile the row's
 * status, and on a confirmed MINT run the shared MintFinalizerService.
 * Inbound USDC deposits (#69) and organizer payouts (#68) match no
 * BlockchainTransaction and are no-ops here until Phase 2.
 *
 * Replay-safe: the WebhookEvent.processedAt guard, plus the idempotent
 * reconcile() and finalize(), make re-delivery of the same notification
 * a no-op.
 */
@Processor(CIRCLE_WEBHOOK_QUEUE)
export class CircleWebhookProcessor extends WorkerHost {
  private readonly logger = new Logger(CircleWebhookProcessor.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly circle: CircleContractService,
    private readonly finalizer: MintFinalizerService,
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

    if (notificationType.startsWith('transactions.')) {
      await this.handleTransaction(payload);
      return;
    }

    // notifications.*, wallets.*, etc. — no Phase 1 handler.
    this.logger.log(
      `Circle webhook: no handler for type=${notificationType} (Phase 2)`,
    );
  }

  private async handleTransaction(
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
      } else {
        this.logger.log(
          `Circle webhook: confirmed ${bt.type} tx ${circleTxId} (no finalizer for this type yet)`,
        );
      }
    } else if (FAILED_STATES.has(state)) {
      // reconcile() already marked the row FAILED; this is the
      // dead-letter / alerting hook.
      this.logger.error(
        `Circle webhook: ${bt.type} tx ${circleTxId} FAILED (state=${state}, reason=${tx.errorReason ?? 'n/a'})`,
      );
    } else {
      this.logger.log(
        `Circle webhook: ${bt.type} tx ${circleTxId} non-terminal state=${state}`,
      );
    }
  }
}
