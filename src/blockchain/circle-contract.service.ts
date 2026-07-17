import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Interface, ParamType } from 'ethers';
import { BlockchainTxStatus, BlockchainTxType } from '@prisma/client';
import { CircleService } from '../circle/circle.service';
import { PrismaService } from '../prisma/prisma.service';
import { diamondAbi } from './abis';
import { getChain } from './chains.config';

export type FeeLevel = 'LOW' | 'MEDIUM' | 'HIGH';

export interface ExecuteContractParams {
  /** Diamond facet method name, e.g. "createTicket" or "mintTicket". */
  method: string;
  /** Args matching the method's ABI inputs (raw JS values; serialized for Circle internally). */
  args: unknown[];
  /** Native token amount for payable methods (e.g. "0.01" for 0.01 ETH). */
  amount?: string;
  feeLevel?: FeeLevel;
  /** Domain classification used for the BlockchainTransaction row. */
  txType: BlockchainTxType;
  ticketId?: string;
  eventId?: string;
  /** Chain id (e.g. "BASE-SEPOLIA"). Defaults to the legacy single-chain
   *  config for backwards compatibility — new callers should always pass
   *  this explicitly so multi-chain dispatch works. */
  chain?: string;
  /** When provided, attach the result to an existing pending
   *  BlockchainTransaction row instead of creating a new one. Used by
   *  workers that pre-record the queued transaction at enqueue time. */
  existingBlockchainTransactionId?: string;
  /** Circle wallet id that signs (and therefore is `msg.sender` for) this
   *  execution. Defaults to the platform treasury wallet. Callers pass an
   *  organizer/scanner wallet when the on-chain identity must be theirs —
   *  e.g. `createTicket` (organizer becomes the ticket admin + payout
   *  target) or `checkIn` (signed by the role-holding scanner). */
  walletId?: string;
}

export interface ExecuteContractResult {
  circleTransactionId: string;
  blockchainTransactionId: string;
}

export interface FeeEstimate {
  low?: { gasLimit?: string; networkFee?: string };
  medium?: { gasLimit?: string; networkFee?: string };
  high?: { gasLimit?: string; networkFee?: string };
}

export interface CircleTransactionSnapshot {
  state: string;
  txHash?: string;
  blockHeight?: number;
  errorReason?: string;
}

const TERMINAL_STATES = new Set([
  'COMPLETE',
  'CONFIRMED',
  'FAILED',
  'DENIED',
  'CANCELLED',
]);

/**
 * Wraps Circle's developer-controlled-wallets contract execution API,
 * signed by the platform treasury wallet (#63). Every call writes a
 * BlockchainTransaction row keyed by circle_transaction_id so the
 * webhook handler (#65) can reconcile the final state when it lands.
 *
 * Until #65 ships, callers can use `pollUntilTerminal` to wait
 * synchronously — acceptable for one-shot scripts but discouraged in
 * Bull workers (they should switch to webhook-driven completion).
 */
@Injectable()
export class CircleContractService {
  private readonly logger = new Logger(CircleContractService.name);
  private readonly iface = new Interface(diamondAbi);

  constructor(
    private readonly circle: CircleService,
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
  ) {}

  /** Execute a Diamond write via Circle. Returns immediately with IDs;
   *  on-chain confirmation is async (poll or wait for webhook). */
  async executeContract(
    params: ExecuteContractParams,
  ): Promise<ExecuteContractResult> {
    const { signature, abiParameters } = this.encode(
      params.method,
      params.args,
    );
    const chain = params.chain ?? this.circle.defaultChain;
    const contractAddress = this.resolveDiamondAddress(chain);
    const signerWalletId = params.walletId ?? this.circle.treasuryWalletId;

    const response =
      await this.circle.client.createContractExecutionTransaction({
        walletId: signerWalletId,
        contractAddress,
        abiFunctionSignature: signature,
        abiParameters,
        amount: params.amount,
        fee: {
          type: 'level',
          config: { feeLevel: params.feeLevel ?? 'MEDIUM' },
        },
      });

    const circleTransactionId = response.data?.id;
    if (!circleTransactionId) {
      throw new Error(
        `Circle returned no transactionId: ${JSON.stringify(response.data)}`,
      );
    }

    const tx = params.existingBlockchainTransactionId
      ? await this.prisma.blockchainTransaction.update({
          where: { id: params.existingBlockchainTransactionId },
          data: {
            circleTransactionId,
            circleWalletId: signerWalletId,
            chain,
          },
        })
      : await this.prisma.blockchainTransaction.create({
          data: {
            type: params.txType,
            status: BlockchainTxStatus.PENDING,
            circleTransactionId,
            circleWalletId: signerWalletId,
            chain,
            ticketId: params.ticketId,
            eventId: params.eventId,
          },
        });

    this.logger.log(
      `Submitted ${params.method} via Circle (chain=${chain}, txId=${circleTransactionId}, blockchainTxId=${tx.id})`,
    );

    return {
      circleTransactionId,
      blockchainTransactionId: tx.id,
    };
  }

  /**
   * Approve an ERC-20 spender from a developer-controlled wallet. Used to
   * let the Diamond pull USDC from the buyer's wallet before `mintTicket`.
   * Runs against the token contract (not the Diamond), so it bypasses the
   * diamond ABI / address resolution. Returns the Circle transaction id;
   * poll it (persist: false) to confirm before the dependent transfer.
   */
  async approveErc20(params: {
    walletId: string;
    tokenAddress: string;
    spender: string;
    /** Allowance in token base units. */
    amount: string;
    chain: string;
    feeLevel?: FeeLevel;
  }): Promise<{ circleTransactionId: string }> {
    const response =
      await this.circle.client.createContractExecutionTransaction({
        walletId: params.walletId,
        contractAddress: params.tokenAddress,
        abiFunctionSignature: 'approve(address,uint256)',
        abiParameters: [params.spender, params.amount],
        fee: {
          type: 'level',
          config: { feeLevel: params.feeLevel ?? 'MEDIUM' },
        },
      });

    const circleTransactionId = response.data?.id;
    if (!circleTransactionId) {
      throw new Error(
        `Circle returned no transactionId for approve: ${JSON.stringify(response.data)}`,
      );
    }

    this.logger.log(
      `Submitted USDC approve via Circle (chain=${params.chain}, spender=${params.spender}, amount=${params.amount}, txId=${circleTransactionId})`,
    );
    return { circleTransactionId };
  }

  /** Estimate gas tiers for a Diamond method without sending. */
  async estimateFee(
    method: string,
    args: unknown[],
    amount?: string,
    chain?: string,
  ): Promise<FeeEstimate> {
    const { signature, abiParameters } = this.encode(method, args);
    const targetChain = chain ?? this.circle.defaultChain;

    const response = await this.circle.client.estimateContractExecutionFee({
      source: { walletId: this.circle.treasuryWalletId },
      contractAddress: this.resolveDiamondAddress(targetChain),
      abiFunctionSignature: signature,
      abiParameters,
      amount,
    });

    return response.data ?? {};
  }

  /** Read Circle's view of a transaction. Useful for status reads
   *  ahead of webhook integration (#65). */
  async getTransactionStatus(
    circleTransactionId: string,
  ): Promise<CircleTransactionSnapshot> {
    const response = await this.circle.client.getTransaction({
      id: circleTransactionId,
    });
    const tx = response.data?.transaction;
    return {
      state: tx?.state ?? 'UNKNOWN',
      txHash: tx?.txHash,
      blockHeight: tx?.blockHeight,
      errorReason: tx?.errorReason,
    };
  }

  /** Block until Circle reports a terminal state. Pre-#65 fallback
   *  for one-shot scripts and tests. Bull workers should NOT call
   *  this — they will move to webhook-driven completion in #65. */
  async pollUntilTerminal(
    circleTransactionId: string,
    options: {
      intervalMs?: number;
      timeoutMs?: number;
      /** Mirror the terminal state onto a BlockchainTransaction row.
       *  Set false for txs we don't track (e.g. the ERC-20 approve leg),
       *  where `reconcile` would fail to find a matching row. */
      persist?: boolean;
    } = {},
  ): Promise<CircleTransactionSnapshot> {
    const interval = options.intervalMs ?? 3_000;
    const timeout = options.timeoutMs ?? 120_000;
    const deadline = Date.now() + timeout;

    while (Date.now() < deadline) {
      const snapshot = await this.getTransactionStatus(circleTransactionId);
      if (TERMINAL_STATES.has(snapshot.state)) {
        if (options.persist !== false) {
          await this.reconcile(circleTransactionId, snapshot);
        }
        return snapshot;
      }
      await new Promise((r) => setTimeout(r, interval));
    }

    throw new Error(
      `Timed out polling Circle transaction ${circleTransactionId}`,
    );
  }

  /** Mirror Circle's terminal state onto BlockchainTransaction.
   *  Public so the future webhook handler can call it on each event. */
  async reconcile(
    circleTransactionId: string,
    snapshot: CircleTransactionSnapshot,
  ): Promise<void> {
    const status = mapCircleState(snapshot.state);
    if (!status) return; // non-terminal, nothing to persist

    await this.prisma.blockchainTransaction.update({
      where: { circleTransactionId },
      data: {
        status,
        txHash: snapshot.txHash ?? undefined,
        error: snapshot.errorReason ?? undefined,
      },
    });
  }

  // ---------- internals ----------

  /**
   * Resolve a Diamond address for a given chain.
   *
   * Prefers the chains.config registry (the multi-chain source of truth
   * post-#33). Falls back to the legacy single-chain
   * `blockchain.diamondAddress` env var so smoke scripts that haven't
   * migrated keep working — drop the fallback once all callers pass
   * `chain` explicitly.
   */
  private resolveDiamondAddress(chain: string): string {
    try {
      return getChain(chain).diamondAddress;
    } catch {
      const legacy = this.config.get<string>('blockchain.diamondAddress');
      if (legacy) return legacy;
      throw new Error(
        `No Diamond address configured for chain ${chain}. Either add it to ACTIVE_CHAINS or set DIAMOND_CONTRACT_ADDRESS.`,
      );
    }
  }

  private encode(
    method: string,
    args: unknown[],
  ): { signature: string; abiParameters: unknown[] } {
    const fragment = this.iface.getFunction(method);
    if (!fragment) {
      throw new Error(`Unknown Diamond method: ${method}`);
    }
    if (fragment.inputs.length !== args.length) {
      throw new Error(
        `${method} expects ${fragment.inputs.length} args, got ${args.length}`,
      );
    }

    return {
      signature: fragment.format('sighash'),
      abiParameters: args.map((arg, i) =>
        serializeArg(arg, fragment.inputs[i]),
      ),
    };
  }
}

/**
 * Recursively serialize a JS value into the shape Circle expects:
 *   - primitives (bigint/number/string/bool/address) → string
 *   - arrays → array of serialized elements
 *   - tuples → array indexed by component order
 *
 * Mirrors the convention the Circle docs use in their abiParameters
 * examples: each leaf is a string, structures are nested arrays.
 */
function serializeArg(arg: unknown, type: ParamType): unknown {
  if (type.baseType === 'array') {
    if (!Array.isArray(arg)) {
      throw new Error(
        `Expected array for type ${type.format()}; got ${typeof arg}`,
      );
    }
    const elementType = type.arrayChildren as ParamType;
    return arg.map((el) => serializeArg(el, elementType));
  }

  if (type.baseType === 'tuple') {
    const components = type.components ?? [];
    if (Array.isArray(arg)) {
      return components.map((comp, i) => serializeArg(arg[i], comp));
    }
    if (arg && typeof arg === 'object') {
      const obj = arg as Record<string, unknown>;
      return components.map((comp) => serializeArg(obj[comp.name], comp));
    }
    throw new Error(`Expected array or object for tuple ${type.format()}`);
  }

  // primitives: bigint | number | boolean | string
  if (typeof arg === 'bigint') return arg.toString();
  if (typeof arg === 'boolean') return arg ? 'true' : 'false';
  return String(arg);
}

function mapCircleState(state: string): BlockchainTxStatus | null {
  switch (state) {
    case 'INITIATED':
    case 'WAITING':
    case 'QUEUED':
    case 'CLEARED':
      return null;
    case 'SENT':
      return BlockchainTxStatus.SUBMITTED;
    case 'CONFIRMED':
    case 'COMPLETE':
      return BlockchainTxStatus.CONFIRMED;
    case 'FAILED':
    case 'DENIED':
    case 'CANCELLED':
    case 'STUCK':
      return BlockchainTxStatus.FAILED;
    default:
      return null;
  }
}
