import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  BlockchainTxStatus,
  BlockchainTxType,
  WalletCreationStatus,
} from '@prisma/client';
import { Job, UnrecoverableError } from 'bullmq';
import { Interface } from 'ethers';
import { PrismaService } from '../prisma/prisma.service';
import { diamondAbi } from './abis';
import { BlockchainReadService } from './blockchain-read.service';
import { CircleContractService } from './circle-contract.service';
import { FEE_TYPE_USDC } from './onchain-fees';
import { PayoutFinalizerService } from './payout-finalizer.service';
import {
  PAYOUT_TICKET_JOB,
  PayoutTicketJobData,
  TICKET_PAYOUT_QUEUE,
} from './payout-queue.service';

/**
 * Contract reverts that no amount of retrying will fix — the withdraw is
 * simply not allowed. We short-circuit Bull's retry budget for these
 * (UnrecoverableError → straight to the failed set) and mark the
 * BlockchainTransaction FAILED for auditor review.
 *
 * `WithdrawPeriodNotReached` is intentionally NOT here: the caller is
 * expected to gate on the withdraw period before enqueuing, but if a job
 * lands early we let it ride the normal retry/backoff rather than hard-
 * fail it.
 */
const TERMINAL_PAYOUT_ERRORS = new Set([
  'InsufficientWithdrawBalance',
  'FiatBalanceNotWithdrawable',
  'AccessControlUnauthorizedAccount',
  'TicketDoesNotExist',
]);

/**
 * Consumes `ticket-payout` jobs and withdraws an organizer's escrowed
 * USDC from the Diamond via `withdrawTicketBalance(uint64 ticketId,
 * FeeType feeType, address to)`, signed by the ORGANIZER's Circle wallet
 * (they are the ticket admin — only they may withdraw) and paid out to
 * that same wallet.
 *
 * Preflight reads the on-chain balance and no-ops a zero balance (the
 * natural idempotency guard: a second run after a successful withdraw
 * reads zero and skips).
 *
 * Completion mirrors the mint/refund workers:
 *  - `circle.webhooksEnabled` ON: submit and return — the Circle webhook
 *    handler reconciles and calls PayoutFinalizerService.
 *  - OFF (fallback): poll until terminal here, then finalize inline.
 */
@Processor(TICKET_PAYOUT_QUEUE)
export class PayoutProcessor extends WorkerHost {
  private readonly logger = new Logger(PayoutProcessor.name);
  private readonly iface = new Interface(diamondAbi);

  constructor(
    private readonly prisma: PrismaService,
    private readonly circle: CircleContractService,
    private readonly read: BlockchainReadService,
    private readonly finalizer: PayoutFinalizerService,
    private readonly config: ConfigService,
  ) {
    super();
  }

  async process(job: Job<PayoutTicketJobData>): Promise<void> {
    if (job.name !== PAYOUT_TICKET_JOB) {
      this.logger.warn(
        `Unexpected job name on ${TICKET_PAYOUT_QUEUE}: ${job.name}`,
      );
      return;
    }

    const { ticketTypeId, eventId, blockchainTxId } = job.data;

    const ticketType = await this.prisma.ticketType.findUnique({
      where: { id: ticketTypeId },
      select: {
        onChainTicketId: true,
        event: { select: { id: true, chain: true, organizerId: true } },
      },
    });

    if (!ticketType) {
      throw new Error(`TicketType ${ticketTypeId} not found`);
    }
    if (ticketType.onChainTicketId === null) {
      // Never published on-chain → no escrow to withdraw. Terminal.
      await this.markFailed(
        blockchainTxId,
        'TicketType has no onChainTicketId',
      );
      throw new UnrecoverableError(
        `TicketType ${ticketTypeId} has no onChainTicketId; nothing to withdraw`,
      );
    }

    const { chain, organizerId } = ticketType.event;
    const onChainTicketId = ticketType.onChainTicketId;

    const organizerWallet = await this.prisma.userWallet.findFirst({
      where: {
        userId: organizerId,
        chain,
        creationStatus: WalletCreationStatus.CREATED,
      },
    });
    if (!organizerWallet?.circleWalletId || !organizerWallet.address) {
      // Transient during provisioning: retry with backoff.
      throw new Error(
        `Organizer ${organizerId} has no ready wallet on ${chain} to sign the withdraw`,
      );
    }

    // Preflight: nothing to withdraw → close the audit row and stop.
    const balance = await this.read.getTicketBalance(
      chain,
      onChainTicketId,
      FEE_TYPE_USDC,
    );
    if (balance === 0n) {
      this.logger.log(
        `Payout no-op: ticketType=${ticketTypeId} (onChainTicketId=${onChainTicketId}) has zero escrow balance`,
      );
      await this.prisma.blockchainTransaction.update({
        where: { id: blockchainTxId },
        data: { status: BlockchainTxStatus.CONFIRMED },
      });
      return;
    }

    try {
      const { circleTransactionId } = await this.circle.executeContract({
        method: 'withdrawTicketBalance',
        args: [
          onChainTicketId, // uint64 _ticketId
          FEE_TYPE_USDC, // enum FeeType _feeType (USDC)
          organizerWallet.address, // address _to (payout destination)
        ],
        chain,
        txType: BlockchainTxType.WITHDRAW,
        eventId,
        existingBlockchainTransactionId: blockchainTxId,
        walletId: organizerWallet.circleWalletId, // organizer signs — they own the balance
      });

      this.logger.log(
        `withdrawTicketBalance submitted (ticketType=${ticketTypeId}, circleTxId=${circleTransactionId})`,
      );

      // Webhook is authoritative for completion when wired.
      if (this.config.get<boolean>('circle.webhooksEnabled')) {
        this.logger.log(
          `withdrawTicketBalance awaiting Circle webhook for completion (ticketType=${ticketTypeId})`,
        );
        return;
      }

      // Fallback: poll until terminal. A withdraw is one block.
      const final = await this.circle.pollUntilTerminal(circleTransactionId, {
        intervalMs: 4_000,
        timeoutMs: 180_000,
      });

      if (final.state !== 'CONFIRMED' && final.state !== 'COMPLETE') {
        const reason = final.errorReason ?? '(no reason)';
        if (this.isTerminalPayoutError(reason)) {
          throw new UnrecoverableError(
            `withdrawTicketBalance not permitted (ticketType=${ticketTypeId}): ${this.describeError(reason)}`,
          );
        }
        throw new Error(
          `withdrawTicketBalance on-chain state ${final.state}: ${reason}`,
        );
      }
      if (!final.txHash) {
        throw new Error('Circle reported terminal success without a txHash');
      }

      await this.finalizer.finalize({ eventId, chain }, final.txHash);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'unknown error';
      const terminal =
        error instanceof UnrecoverableError ||
        this.isTerminalPayoutError(message);
      const isFinal =
        terminal || job.attemptsMade + 1 >= (job.opts.attempts ?? 1);

      await this.prisma.blockchainTransaction.update({
        where: { id: blockchainTxId },
        data: {
          status: isFinal
            ? BlockchainTxStatus.FAILED
            : BlockchainTxStatus.PENDING,
          error: message.slice(0, 500),
        },
      });

      if (terminal && !(error instanceof UnrecoverableError)) {
        this.logger.error(
          `Payout not permitted (ticketType=${ticketTypeId}): ${message}`,
        );
        throw new UnrecoverableError(message);
      }

      if (isFinal) {
        this.logger.error(
          `Payout failed (ticketType=${ticketTypeId}, attempts=${job.attemptsMade + 1}): ${message}`,
        );
      } else {
        this.logger.warn(
          `Payout attempt ${job.attemptsMade + 1} failed (ticketType=${ticketTypeId}): ${message}`,
        );
      }
      throw error;
    }
  }

  // ---------- internals ----------

  private async markFailed(
    blockchainTxId: string,
    error: string,
  ): Promise<void> {
    await this.prisma.blockchainTransaction.update({
      where: { id: blockchainTxId },
      data: { status: BlockchainTxStatus.FAILED, error: error.slice(0, 500) },
    });
  }

  private isTerminalPayoutError(reason: string): boolean {
    const name = this.decodeErrorName(reason);
    if (name && TERMINAL_PAYOUT_ERRORS.has(name)) return true;
    return [...TERMINAL_PAYOUT_ERRORS].some((e) => reason.includes(e));
  }

  private describeError(reason: string): string {
    return this.decodeErrorName(reason) ?? reason;
  }

  /** Parse a custom-error name out of raw revert data, if present. */
  private decodeErrorName(reason: string): string | null {
    const match = reason.match(/0x[0-9a-fA-F]{8,}/);
    if (!match) return null;
    try {
      return this.iface.parseError(match[0])?.name ?? null;
    } catch {
      return null;
    }
  }
}
