import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  BlockchainTxStatus,
  BlockchainTxType,
  PaymentProvider,
  TicketStatus,
  WalletCreationStatus,
} from '@prisma/client';
import { Job, UnrecoverableError } from 'bullmq';
import { Interface } from 'ethers';
import { PrismaService } from '../prisma/prisma.service';
import { diamondAbi } from './abis';
import { CircleContractService } from './circle-contract.service';
import { FEE_TYPE_USDC } from './onchain-fees';
import { RefundFinalizerService } from './refund-finalizer.service';
import {
  REFUND_TICKET_JOB,
  RefundTicketJobData,
  TICKET_REFUND_QUEUE,
} from './refund-queue.service';

/**
 * Contract reverts that no amount of retrying will fix — the refund is
 * simply not allowed for this ticket. We short-circuit Bull's retry
 * budget for these (UnrecoverableError → straight to the failed set)
 * and mark the BlockchainTransaction FAILED for auditor review.
 *
 * `RefundPeriodNotReached` is intentionally NOT here: it means the
 * on-chain window hasn't opened yet, which is transient-ish, so we let
 * it ride the normal retry/backoff and land in `failed` only after the
 * budget is spent (ops can re-trigger once the window opens).
 */
const TERMINAL_REFUND_ERRORS = new Set([
  'RefundNotEnabled',
  'RefundPeriodExpired',
  'FiatTicketNotRefundable',
  'TicketNotOwned',
  'TicketDoesNotExist',
  'TicketIsFree',
]);

/**
 * Consumes `ticket-refund` jobs and issues the on-chain refund via
 * `claimRefund(uint64 ticketId, FeeType feeType, uint256 tokenId,
 * address to)` on the Diamond, signed by the BUYER's Circle wallet (the
 * contract checks token ownership — the treasury cannot refund on their
 * behalf). Escrowed USDC is returned to the buyer's wallet.
 *
 * Crypto (USDC) tickets only: `claimRefund` reverts
 * `FiatTicketNotRefundable` for fiat-minted tickets, so the producer
 * only enqueues CRYPTO tickets and this worker re-checks defensively.
 *
 * Completion mirrors the mint worker:
 *  - `circle.webhooksEnabled` ON: submit and return — the Circle webhook
 *    handler reconciles and calls RefundFinalizerService.
 *  - OFF (fallback): poll until terminal here, then finalize inline.
 * Both converge on the same idempotent RefundFinalizerService.
 */
@Processor(TICKET_REFUND_QUEUE)
export class RefundProcessor extends WorkerHost {
  private readonly logger = new Logger(RefundProcessor.name);
  private readonly iface = new Interface(diamondAbi);

  constructor(
    private readonly prisma: PrismaService,
    private readonly circle: CircleContractService,
    private readonly finalizer: RefundFinalizerService,
    private readonly config: ConfigService,
  ) {
    super();
  }

  async process(job: Job<RefundTicketJobData>): Promise<void> {
    if (job.name !== REFUND_TICKET_JOB) {
      this.logger.warn(
        `Unexpected job name on ${TICKET_REFUND_QUEUE}: ${job.name}`,
      );
      return;
    }

    const { ticketId, blockchainTxId } = job.data;

    const ticket = await this.prisma.ticket.findUnique({
      where: { id: ticketId },
      include: {
        ticketType: { select: { onChainTicketId: true } },
        transaction: { select: { provider: true } },
        event: { select: { id: true, chain: true } },
        buyer: { include: { wallets: true } },
      },
    });

    if (!ticket) {
      throw new Error(`Ticket ${ticketId} not found`);
    }

    // Idempotency — never re-refund a ticket that already settled.
    if (ticket.status === TicketStatus.REFUNDED) {
      this.logger.log(`Ticket ${ticketId} already refunded; skipping`);
      return;
    }

    // Crypto-only rail. Fiat tickets can't be refunded on-chain
    // (claimRefund reverts FiatTicketNotRefundable); they're handled
    // off-chain. Guard here even though the producer already filters.
    if (ticket.transaction?.provider !== PaymentProvider.CRYPTO) {
      this.logger.warn(
        `Ticket ${ticketId} is not a crypto purchase (provider=${ticket.transaction?.provider ?? 'none'}); on-chain refund not applicable — skipping`,
      );
      await this.markFailed(
        blockchainTxId,
        'Non-crypto ticket — off-chain refund required',
      );
      throw new UnrecoverableError(
        'Non-crypto ticket — no on-chain refund path',
      );
    }

    if (ticket.ticketType.onChainTicketId === null) {
      throw new Error(
        `TicketType ${ticket.ticketTypeId} has no onChainTicketId — cannot refund`,
      );
    }
    if (ticket.tokenId === null) {
      // Never minted on-chain → nothing to refund. Terminal.
      await this.markFailed(
        blockchainTxId,
        'Ticket has no on-chain tokenId — never minted',
      );
      throw new UnrecoverableError(
        `Ticket ${ticketId} has no tokenId; nothing to refund`,
      );
    }
    if (!ticket.buyer) {
      await this.markFailed(
        blockchainTxId,
        'Ticket has no buyer — no wallet to sign refund',
      );
      throw new UnrecoverableError(`Ticket ${ticketId} has no buyer row`);
    }

    const wallet = ticket.buyer.wallets.find(
      (w) => w.chain === ticket.event.chain,
    );
    if (!wallet?.circleWalletId || !wallet.address) {
      throw new Error(
        `Buyer ${ticket.buyer.id} has no usable wallet on ${ticket.event.chain} to sign the refund`,
      );
    }
    if (wallet.creationStatus !== WalletCreationStatus.CREATED) {
      // Transient during provisioning: retry with backoff.
      throw new Error(
        `Buyer wallet ${wallet.id} not ready (status=${wallet.creationStatus}); cannot sign refund yet`,
      );
    }

    try {
      const { circleTransactionId } = await this.circle.executeContract({
        method: 'claimRefund',
        args: [
          ticket.ticketType.onChainTicketId, // uint64 _ticketId
          FEE_TYPE_USDC, // enum FeeType _feeType (USDC)
          BigInt(ticket.tokenId), // uint256 _tokenId
          wallet.address, // address _to (refund recipient)
        ],
        chain: ticket.event.chain,
        txType: BlockchainTxType.REFUND,
        eventId: ticket.event.id,
        ticketId: ticket.id,
        existingBlockchainTransactionId: blockchainTxId,
        walletId: wallet.circleWalletId, // buyer signs — contract checks ownership
      });

      this.logger.log(
        `claimRefund submitted (ticket=${ticket.id}, circleTxId=${circleTransactionId})`,
      );

      // Webhook is authoritative for completion when wired.
      if (this.config.get<boolean>('circle.webhooksEnabled')) {
        this.logger.log(
          `claimRefund awaiting Circle webhook for completion (ticket=${ticket.id})`,
        );
        return;
      }

      // Fallback: poll until terminal. A refund is one block.
      const final = await this.circle.pollUntilTerminal(circleTransactionId, {
        intervalMs: 4_000,
        timeoutMs: 180_000,
      });

      if (final.state !== 'CONFIRMED' && final.state !== 'COMPLETE') {
        // Classify the revert: a terminal contract error must not burn
        // the whole retry budget.
        const reason = final.errorReason ?? '(no reason)';
        if (this.isTerminalRefundError(reason)) {
          throw new UnrecoverableError(
            `claimRefund not permitted (ticket=${ticket.id}): ${this.describeError(reason)}`,
          );
        }
        throw new Error(`claimRefund on-chain state ${final.state}: ${reason}`);
      }
      if (!final.txHash) {
        throw new Error('Circle reported terminal success without a txHash');
      }

      await this.finalizer.finalize(ticket.id, final.txHash);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'unknown error';
      const terminal =
        error instanceof UnrecoverableError ||
        this.isTerminalRefundError(message);
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
        // A terminal revert surfaced as a plain Error (e.g. thrown from
        // executeContract). Re-wrap so Bull stops retrying.
        this.logger.error(
          `Refund not permitted (ticket=${ticketId}): ${message}`,
        );
        throw new UnrecoverableError(message);
      }

      if (isFinal) {
        this.logger.error(
          `Refund failed (ticket=${ticketId}, attempts=${job.attemptsMade + 1}): ${message}`,
        );
      } else {
        this.logger.warn(
          `Refund attempt ${job.attemptsMade + 1} failed (ticket=${ticketId}): ${message}`,
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

  /**
   * True when a revert reason maps to a contract error that will never
   * succeed on retry. Handles both a decoded name in the string and a
   * raw ABI-encoded custom-error payload (0x… selector).
   */
  private isTerminalRefundError(reason: string): boolean {
    const name = this.decodeErrorName(reason);
    if (name && TERMINAL_REFUND_ERRORS.has(name)) return true;
    return [...TERMINAL_REFUND_ERRORS].some((e) => reason.includes(e));
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
