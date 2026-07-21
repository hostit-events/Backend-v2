import { Injectable, Logger } from '@nestjs/common';
import { Interface, type LogDescription } from 'ethers';
import { diamondAbi } from './abis';
import { BlockchainReadService } from './blockchain-read.service';
import { USDC_DECIMALS } from './onchain-fees';

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
 * This slice keeps no per-payout domain row (the Payout record lifecycle
 * belongs to the #46 request/history work); the BlockchainTransaction —
 * reconciled to CONFIRMED with its txHash — is the source of truth, and
 * this hook is the seam #46 will extend to flip Payout rows to COMPLETED.
 * It performs no mutation, so it is naturally idempotent under webhook
 * re-delivery / poll races.
 */
@Injectable()
export class PayoutFinalizerService {
  private readonly logger = new Logger(PayoutFinalizerService.name);
  private readonly iface = new Interface(diamondAbi);

  constructor(private readonly read: BlockchainReadService) {}

  async finalize(
    input: { eventId: string; chain: string },
    txHash: string,
  ): Promise<void> {
    const withdrawn = await this.extractWithdrawn(input.chain, txHash);

    if (!withdrawn) {
      // Confirmed on-chain but no TicketBalanceWithdrawn in the receipt —
      // treat as a zero/no-op withdraw rather than failing the payout.
      this.logger.log(
        `Payout confirmed with no TicketBalanceWithdrawn event (event=${input.eventId}, txHash=${txHash}) — nothing withdrawn`,
      );
      return;
    }

    this.logger.log(
      `Payout settled (event=${input.eventId}, ticketId=${withdrawn.ticketId}, ` +
        `amount=${formatUsdc(withdrawn.fee)} USDC, to=${withdrawn.to}, txHash=${txHash})`,
    );
  }

  // ---------- internals ----------

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
