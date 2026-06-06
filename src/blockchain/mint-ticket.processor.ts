import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  BlockchainTxStatus,
  BlockchainTxType,
  TicketStatus,
  WalletCreationStatus,
} from '@prisma/client';
import { Job } from 'bullmq';
import { PrismaService } from '../prisma/prisma.service';
import { CircleContractService } from './circle-contract.service';
import { MintFinalizerService } from './mint-finalizer.service';
import {
  MINT_TICKET_JOB,
  MintTicketJobData,
  TICKET_MINT_QUEUE,
} from './mint-queue.service';

/**
 * On-chain FeeType enum (LibAddressesAndFees.sol). Mirrors the table
 * in event-publish.processor — both flows speak symbolic names but
 * the Diamond expects the numeric code. The mint must use the *same*
 * code that was used at createTicket for this ticketType, otherwise
 * the contract rejects the call.
 *
 * Today every ticket type is created with FeeType=ETH (placeholder
 * pricing in events.service). When real pricing/fee-types land, this
 * needs to read the fee code off the TicketType or Transaction row.
 */
const FEE_TYPE_BY_NAME: Record<string, number> = {
  ETH: 1,
  WETH: 2,
  USDT: 3,
  USDC: 4,
  USDT0: 5,
  EURC: 6,
  GHO: 7,
  LINK: 8,
  LSK: 9,
};
const DEFAULT_FEE_TYPE = FEE_TYPE_BY_NAME.ETH;

/**
 * Consumes `ticket-mint` jobs and runs `mintTicket(uint64 ticketId,
 * uint8 feeType, address buyer)` on the Diamond via Circle SCP.
 *
 * Completion is handled in one of two ways:
 *  - `circle.webhooksEnabled` ON (#65): submit and return — the Circle
 *    webhook handler reconciles and calls MintFinalizerService.
 *  - OFF (fallback): poll until terminal here, then finalize inline.
 * Both paths converge on the same idempotent MintFinalizerService.
 *
 * Wallet provisioning is async for guest buyers; this worker treats
 * a PENDING wallet as a transient state and throws to retry — Bull's
 * exponential backoff (10s base, 5 attempts) buys ~3 minutes of
 * runway for Circle to finish creating the SCA wallet.
 */
@Processor(TICKET_MINT_QUEUE)
export class MintTicketProcessor extends WorkerHost {
  private readonly logger = new Logger(MintTicketProcessor.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly circle: CircleContractService,
    private readonly finalizer: MintFinalizerService,
    private readonly config: ConfigService,
  ) {
    super();
  }

  async process(job: Job<MintTicketJobData>): Promise<void> {
    if (job.name !== MINT_TICKET_JOB) {
      this.logger.warn(`Unexpected job name on ticket-mint: ${job.name}`);
      return;
    }

    const { ticketId, blockchainTxId } = job.data;

    const ticket = await this.prisma.ticket.findUnique({
      where: { id: ticketId },
      include: {
        ticketType: true,
        event: {
          select: {
            id: true,
            name: true,
            chain: true,
            slug: true,
            venue: true,
            startTime: true,
          },
        },
        buyer: {
          include: {
            wallets: true,
          },
        },
      },
    });

    if (!ticket) {
      throw new Error(`Ticket ${ticketId} not found`);
    }

    // Idempotency — never re-mint a ticket that already has a tokenId.
    // Worker crashes between Circle submit and DB update can land us
    // here; we treat that case as success.
    if (ticket.tokenId !== null && ticket.status === TicketStatus.CONFIRMED) {
      this.logger.log(
        `Ticket ${ticketId} already minted (tokenId=${ticket.tokenId}); skipping`,
      );
      return;
    }

    // Pre-flight: TicketType must have its on-chain id (event-publish
    // worker writes this after createTicket confirms). If the publish
    // worker hasn't completed yet, retry — buys time without burning
    // a Circle call.
    if (ticket.ticketType.onChainTicketId === null) {
      throw new Error(
        `TicketType ${ticket.ticketType.id} has no onChainTicketId yet — event publish still pending`,
      );
    }

    if (!ticket.buyer) {
      // Should never happen post-guest-provisioning, but defensive:
      // there's no user → no wallet → no mint. Mark final.
      throw new Error(
        `Ticket ${ticketId} has no buyer row; cannot mint without a wallet owner`,
      );
    }

    const wallet = ticket.buyer.wallets.find(
      (w) => w.chain === ticket.event.chain,
    );
    if (!wallet) {
      throw new Error(
        `Buyer ${ticket.buyer.id} has no wallet on chain ${ticket.event.chain}`,
      );
    }
    if (
      wallet.creationStatus === WalletCreationStatus.PENDING ||
      !wallet.address
    ) {
      // Transient: wallet is still provisioning. Throw to trigger Bull
      // retry with backoff — gives Circle time to finish.
      throw new Error(
        `Buyer wallet ${wallet.id} still provisioning (status=${wallet.creationStatus})`,
      );
    }
    if (wallet.creationStatus === WalletCreationStatus.FAILED) {
      throw new Error(
        `Buyer wallet ${wallet.id} provisioning FAILED — admin retry required before mint can proceed`,
      );
    }

    try {
      const args = [
        ticket.ticketType.onChainTicketId,
        DEFAULT_FEE_TYPE,
        wallet.address,
      ];

      const { circleTransactionId } = await this.circle.executeContract({
        method: 'mintTicket',
        args,
        chain: ticket.event.chain,
        txType: BlockchainTxType.MINT,
        eventId: ticket.event.id,
        ticketId: ticket.id,
        existingBlockchainTransactionId: blockchainTxId,
      });

      this.logger.log(
        `mintTicket submitted (ticket=${ticket.id}, circleTxId=${circleTransactionId})`,
      );

      // When the Circle webhook is wired (#65) it is authoritative for
      // completion: submit and return, and the circle-webhook processor
      // reconciles + finalizes when the transaction notification lands.
      if (this.config.get<boolean>('circle.webhooksEnabled')) {
        this.logger.log(
          `mintTicket awaiting Circle webhook for completion (ticket=${ticket.id})`,
        );
        return;
      }

      // Fallback: poll until terminal. Mint takes one block, so a
      // 3-minute ceiling is generous.
      const final = await this.circle.pollUntilTerminal(circleTransactionId, {
        intervalMs: 4_000,
        timeoutMs: 180_000,
      });

      if (final.state !== 'CONFIRMED' && final.state !== 'COMPLETE') {
        throw new Error(
          `mintTicket on-chain state ${final.state}: ${final.errorReason ?? '(no reason)'}`,
        );
      }
      if (!final.txHash) {
        throw new Error('Circle reported terminal success without a txHash');
      }

      await this.finalizer.finalize(ticket.id, final.txHash);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'unknown error';
      const isFinal = job.attemptsMade + 1 >= (job.opts.attempts ?? 1);

      // Mark the row failed on every attempt; the next retry flips it
      // back to PENDING when CircleContractService submits a new tx.
      // Use updateMany so we don't crash on rows that haven't yet
      // attached a circleTransactionId.
      await this.prisma.blockchainTransaction.update({
        where: { id: blockchainTxId },
        data: {
          status: isFinal
            ? BlockchainTxStatus.FAILED
            : BlockchainTxStatus.PENDING,
          error: message.slice(0, 500),
        },
      });

      if (isFinal) {
        this.logger.error(
          `Mint failed (ticket=${ticketId}, attempts=${job.attemptsMade + 1}): ${message}`,
        );
      } else {
        this.logger.warn(
          `Mint attempt ${job.attemptsMade + 1} failed (ticket=${ticketId}): ${message}`,
        );
      }
      throw error;
    }
  }
}
