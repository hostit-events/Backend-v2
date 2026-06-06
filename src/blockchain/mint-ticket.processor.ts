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
import { Prisma } from '@prisma/client';
import { id as keccak256Utf8 } from 'ethers';
import { PrismaService } from '../prisma/prisma.service';
import { CircleContractService } from './circle-contract.service';
import { MintFinalizerService } from './mint-finalizer.service';
import {
  MINT_TICKET_JOB,
  MintTicketJobData,
  TICKET_MINT_QUEUE,
} from './mint-queue.service';

/**
 * Consumes `ticket-mint` jobs and issues the on-chain ticket NFT via
 * `mintFiatTicket(uint64 ticketId, address buyer, uint256 amount,
 * bytes32 paymentId)`, signed by the treasury — which is the Diamond's
 * `trustedBackend`. This is a free issuance (no on-chain fee): payment
 * was already collected off-chain (fiat gateway) or into HostIT custody
 * (USDC deposit, #69), and organizer settlement runs separately (#68).
 * `amount` (the off-chain price in kobo) is recorded on-chain via
 * `getTicketFiatRevenue`, and `paymentId` makes mints replay-safe.
 *
 * (The payable `mintTicket` path — buyer pays the contract directly and
 * the Diamond splits on-chain — is reserved for a future on-chain
 * settlement mode.)
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
      // Off-chain price recorded on-chain in the smallest fiat unit
      // (kobo for NGN). paymentId is deterministic per ticket so a
      // retry reuses it — the contract's replay guard + our tokenId
      // idempotency check keep a re-mint safe.
      const amountMinor = new Prisma.Decimal(ticket.ticketType.price)
        .mul(100)
        .toFixed(0);
      const paymentId = keccak256Utf8(ticket.reference);

      const args = [
        ticket.ticketType.onChainTicketId,
        wallet.address,
        amountMinor,
        paymentId,
      ];

      const { circleTransactionId } = await this.circle.executeContract({
        method: 'mintFiatTicket',
        args,
        chain: ticket.event.chain,
        txType: BlockchainTxType.MINT,
        eventId: ticket.event.id,
        ticketId: ticket.id,
        existingBlockchainTransactionId: blockchainTxId,
      });

      this.logger.log(
        `mintFiatTicket submitted (ticket=${ticket.id}, circleTxId=${circleTransactionId})`,
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
