import { Injectable, Logger } from '@nestjs/common';
import { PayoutStatus } from '@prisma/client';
import { Interface, type LogDescription } from 'ethers';
import { PrismaService } from '../prisma/prisma.service';
import { diamondAbi } from './abis';
import { BlockchainReadService } from './blockchain-read.service';
import { FEE_TYPE_USDC, USDC_DECIMALS } from './onchain-fees';

/** Format a 6-dp USDC base-unit amount as a decimal string, for logs. */
function formatUsdc(raw: bigint): string {
  const s = raw.toString().padStart(USDC_DECIMALS + 1, '0');
  return `${s.slice(0, -USDC_DECIMALS)}.${s.slice(-USDC_DECIMALS)}`;
}

/**
 * Shared post-payout finalization. Given a confirmed
 * `withdrawTicketBalance` tx hash, parses the `TicketBalanceWithdrawn`
 * event to recover the amount + destination and writes an audit log line
 * (tx hash + destination + amount — the #37 acceptance criterion).
 *
 * Both completion paths drive it identically:
 *  - the polling fallback in PayoutProcessor, and
 *  - the Circle webhook handler, authoritative once
 *    `circle.webhooksEnabled` is on.
 *
 * A payout request (#46) may fan out several per-ticket-type withdraws.
 * Each confirmed withdraw drives this hook; once the event's remaining
 * escrow across all ticket types hits zero, the event's active Payout
 * row is closed to COMPLETED. The compare-and-set on status makes it
 * idempotent under webhook re-delivery / poll races.
 */
@Injectable()
export class PayoutFinalizerService {
  private readonly logger = new Logger(PayoutFinalizerService.name);
  private readonly iface = new Interface(diamondAbi);

  constructor(
    private readonly prisma: PrismaService,
    private readonly read: BlockchainReadService,
  ) {}

  async finalize(
    input: { eventId: string; chain: string },
    txHash: string,
  ): Promise<void> {
    const withdrawn = await this.extractWithdrawn(input.chain, txHash);

    if (withdrawn) {
      this.logger.log(
        `Payout settled (event=${input.eventId}, ticketId=${withdrawn.ticketId}, ` +
          `amount=${formatUsdc(withdrawn.fee)} USDC, to=${withdrawn.to}, txHash=${txHash})`,
      );
    } else {
      // Confirmed on-chain but no TicketBalanceWithdrawn in the receipt —
      // treat as a zero/no-op withdraw rather than failing the payout.
      this.logger.log(
        `Payout confirmed with no TicketBalanceWithdrawn event (event=${input.eventId}, txHash=${txHash}) — nothing withdrawn`,
      );
    }

    await this.maybeCompletePayout(input.eventId, input.chain, txHash);
  }

  // ---------- internals ----------

  /**
   * Close the event's active Payout once its escrow is fully drained.
   * No-op when the event has no in-flight payout (e.g. a withdraw
   * triggered outside the #46 request flow) or escrow remains.
   */
  private async maybeCompletePayout(
    eventId: string,
    chain: string,
    txHash: string,
  ): Promise<void> {
    const payout = await this.prisma.payout.findFirst({
      where: {
        eventId,
        status: { in: [PayoutStatus.PENDING, PayoutStatus.PROCESSING] },
      },
      select: { id: true },
    });
    if (!payout) return;

    const ticketTypes = await this.prisma.ticketType.findMany({
      where: { eventId, onChainTicketId: { not: null } },
      select: { onChainTicketId: true },
    });

    let remaining = 0n;
    for (const t of ticketTypes) {
      if (t.onChainTicketId === null) continue;
      remaining += await this.read.getTicketBalance(
        chain,
        t.onChainTicketId,
        FEE_TYPE_USDC,
      );
    }

    if (remaining > 0n) {
      this.logger.log(
        `Payout ${payout.id} still has ${formatUsdc(remaining)} USDC escrow outstanding — leaving PROCESSING`,
      );
      return;
    }

    // Compare-and-set: a concurrent finalizer that already closed the
    // row updates zero rows and we skip.
    const { count } = await this.prisma.payout.updateMany({
      where: {
        id: payout.id,
        status: { in: [PayoutStatus.PENDING, PayoutStatus.PROCESSING] },
      },
      data: {
        status: PayoutStatus.COMPLETED,
        processedAt: new Date(),
        providerReference: txHash,
      },
    });

    if (count > 0) {
      this.logger.log(
        `Payout ${payout.id} completed (event=${eventId}, txHash=${txHash})`,
      );
    }
  }

  private async extractWithdrawn(
    chain: string,
    txHash: string,
  ): Promise<{ ticketId: bigint; fee: bigint; to: string } | null> {
    const provider = this.read.getProvider(chain);
    const receipt = await provider.getTransactionReceipt(txHash);
    if (!receipt) {
      throw new Error(`No receipt for tx ${txHash} on ${chain}`);
    }

    let parsed: LogDescription | null = null;
    for (const log of receipt.logs) {
      try {
        const p = this.iface.parseLog({
          topics: Array.from(log.topics),
          data: log.data,
        });
        if (p?.name === 'TicketBalanceWithdrawn') {
          parsed = p;
          break;
        }
      } catch {
        // not a known facet event — skip
      }
    }

    if (!parsed) return null;
    return {
      ticketId: parsed.args.ticketId as bigint,
      fee: parsed.args.fee as bigint,
      to: parsed.args.to as string,
    };
  }
}
