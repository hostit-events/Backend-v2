import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Logger } from '@nestjs/common';
import { Job } from 'bullmq';
import {
  BlockchainTxStatus,
  BlockchainTxType,
  EventStatus,
  WalletCreationStatus,
} from '@prisma/client';
import { Interface, type LogDescription } from 'ethers';
import { PrismaService } from '../prisma/prisma.service';
import { diamondAbi } from './abis';
import { BlockchainReadService } from './blockchain-read.service';
import { CircleContractService } from './circle-contract.service';
import { FEE_TYPE_BY_NAME } from './onchain-fees';

const EVENT_PUBLISH_QUEUE = 'event-publish';
const CREATE_EVENT_JOB = 'create-event';

interface CreateEventJobData {
  eventId: string;
  chain: string;
  ticketTypeId: string;
  blockchainTxId: string;
  ticketData: {
    startTime: number;
    endTime: number;
    purchaseStartTime: number;
    maxTickets: number;
    maxTicketsPerUser: number;
    isFree: boolean;
    isRefundable: boolean;
    name: string;
    symbol: string;
    uri: string;
  };
  feeTypes: string[];
  prices: string[];
}

/**
 * Consumes `event-publish` jobs (one per ticket type) and runs the
 * on-chain `createTicket(TicketData, FeeType[], uint256[])` call via
 * Circle SCP, signed by the platform treasury wallet.
 *
 * Until the webhook handler (#65) ships, completion is detected by
 * polling Circle. On success the `TicketCreated` event is parsed from
 * the receipt to recover the contract-assigned `ticketId`, which is
 * then written to the corresponding `TicketType` row.
 *
 * On final-attempt failure the parent Event is reverted to DRAFT so
 * the organizer can retry from the dashboard. Other ticket types in
 * the same event that succeeded keep their on-chain entries — partial
 * publish is allowed; rerunning publish on a DRAFT event re-enqueues
 * only the types whose `onChainTicketId` is still null.
 */
@Processor(EVENT_PUBLISH_QUEUE)
export class EventPublishProcessor extends WorkerHost {
  private readonly logger = new Logger(EventPublishProcessor.name);
  private readonly iface = new Interface(diamondAbi);

  constructor(
    private readonly prisma: PrismaService,
    private readonly circle: CircleContractService,
    private readonly read: BlockchainReadService,
  ) {
    super();
  }

  async process(job: Job<CreateEventJobData>): Promise<void> {
    if (job.name !== CREATE_EVENT_JOB) {
      this.logger.warn(`Unexpected job name on event-publish: ${job.name}`);
      return;
    }

    const data = job.data;
    const ticketType = await this.prisma.ticketType.findUnique({
      where: { id: data.ticketTypeId },
    });
    if (!ticketType) {
      throw new Error(`TicketType ${data.ticketTypeId} not found`);
    }

    if (ticketType.onChainTicketId !== null) {
      this.logger.log(
        `TicketType ${ticketType.id} already on-chain (id=${ticketType.onChainTicketId}); skipping`,
      );
      return;
    }

    // The organizer must sign createTicket so they become the ticket's
    // on-chain admin: `ticketAdmin` (the instant crypto-payout target for
    // non-refundable events + the mainAdmin who can withdraw refundable
    // balances) and the `ticketAdminRole` holder that gates check-in.
    // Signing with the treasury would make HostIT the admin instead.
    const event = await this.prisma.event.findUnique({
      where: { id: data.eventId },
      select: { organizerId: true },
    });
    if (!event) {
      throw new Error(`Event ${data.eventId} not found`);
    }
    const organizerWallet = await this.prisma.userWallet.findFirst({
      where: {
        userId: event.organizerId,
        chain: data.chain,
        creationStatus: WalletCreationStatus.CREATED,
      },
    });
    if (!organizerWallet?.circleWalletId) {
      // Transient during provisioning: throw so Bull retries with backoff
      // while Circle finishes creating the organizer's wallet.
      throw new Error(
        `Organizer ${event.organizerId} has no ready wallet on ${data.chain} — cannot sign createTicket`,
      );
    }

    try {
      const args = this.buildCreateTicketArgs(data);

      const { circleTransactionId } = await this.circle.executeContract({
        method: 'createTicket',
        args,
        chain: data.chain,
        txType: BlockchainTxType.CREATE_EVENT,
        eventId: data.eventId,
        existingBlockchainTransactionId: data.blockchainTxId,
        walletId: organizerWallet.circleWalletId,
      });

      this.logger.log(
        `createTicket submitted (eventId=${data.eventId}, ticketTypeId=${data.ticketTypeId}, circleTxId=${circleTransactionId})`,
      );

      // Pre-#65 fallback: poll until terminal. Keep timeout short
      // enough that a bad submission surfaces quickly but long enough
      // to ride out a slow block.
      const final = await this.circle.pollUntilTerminal(circleTransactionId, {
        intervalMs: 4_000,
        timeoutMs: 180_000,
      });

      if (final.state !== 'CONFIRMED' && final.state !== 'COMPLETE') {
        throw new Error(
          `createTicket on-chain state ${final.state}: ${final.errorReason ?? '(no reason)'}`,
        );
      }

      if (!final.txHash) {
        throw new Error('Circle reported terminal success without a txHash');
      }

      const onChainTicketId = await this.extractTicketId(
        data.chain,
        final.txHash,
      );

      await this.prisma.ticketType.update({
        where: { id: data.ticketTypeId },
        data: { onChainTicketId },
      });

      this.logger.log(
        `On-chain ticketType created (ticketTypeId=${data.ticketTypeId}, onChainTicketId=${onChainTicketId}, txHash=${final.txHash})`,
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : 'unknown error';

      const isFinal = job.attemptsMade + 1 >= (job.opts.attempts ?? 1);

      // Mark the row failed on every attempt; the next retry will flip
      // it back to PENDING when CircleContractService submits a new
      // transaction. On the final attempt, additionally roll the
      // parent Event back to DRAFT so the organizer can edit/retry.
      await this.prisma.blockchainTransaction.update({
        where: { id: data.blockchainTxId },
        data: {
          status: isFinal
            ? BlockchainTxStatus.FAILED
            : BlockchainTxStatus.PENDING,
          error: message.slice(0, 500),
        },
      });

      if (isFinal) {
        await this.prisma.event.update({
          where: { id: data.eventId },
          data: { status: EventStatus.DRAFT },
        });
        this.logger.error(
          `Event publish failed (eventId=${data.eventId}, ticketTypeId=${data.ticketTypeId}, attempts=${job.attemptsMade + 1}): ${message}`,
        );
      } else {
        this.logger.warn(
          `Event publish attempt ${job.attemptsMade + 1} failed (eventId=${data.eventId}, ticketTypeId=${data.ticketTypeId}): ${message}`,
        );
      }

      throw error;
    }
  }

  // ---------- internals ----------

  private buildCreateTicketArgs(data: CreateEventJobData): unknown[] {
    const td = data.ticketData;
    const tupleArg = [
      td.startTime,
      td.endTime,
      td.purchaseStartTime,
      td.maxTickets,
      td.maxTicketsPerUser,
      td.isFree,
      td.isRefundable,
      td.name,
      td.symbol,
      td.uri,
    ];

    const feeTypeCodes = data.feeTypes.map((name) => {
      const code = FEE_TYPE_BY_NAME[name];
      if (code === undefined) {
        throw new Error(`Unknown fee type: ${name}`);
      }
      return code;
    });
    const fees = data.prices.map((p) => BigInt(p));

    return [tupleArg, feeTypeCodes, fees];
  }

  /**
   * Pull the receipt for a confirmed Circle transaction and parse out
   * the `TicketCreated` event's `ticketId` arg. The event is emitted
   * by FactoryFacet on every successful createTicket call.
   */
  private async extractTicketId(
    chain: string,
    txHash: string,
  ): Promise<bigint> {
    const provider = this.read.getProvider(chain);
    const receipt = await provider.getTransactionReceipt(txHash);
    if (!receipt) {
      throw new Error(`No receipt for tx ${txHash} on ${chain}`);
    }

    let ticketCreated: LogDescription | null = null;
    for (const log of receipt.logs) {
      try {
        const parsed = this.iface.parseLog({
          topics: Array.from(log.topics),
          data: log.data,
        });
        if (parsed?.name === 'TicketCreated') {
          ticketCreated = parsed;
          break;
        }
      } catch {
        // log doesn't match any known facet event — skip
      }
    }

    if (!ticketCreated) {
      throw new Error(
        `TicketCreated event not found in receipt for tx ${txHash}`,
      );
    }
    return ticketCreated.args.ticketId as bigint;
  }
}
