import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Interface, ParamType } from 'ethers';
import { BlockchainTxStatus, BlockchainTxType } from '@prisma/client';
import { CircleService } from '../circle/circle.service';
import { PrismaService } from '../prisma/prisma.service';
import { diamondAbi } from './abis';

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
    const contractAddress = this.diamondAddress();

    const response =
      await this.circle.client.createContractExecutionTransaction({
        walletId: this.circle.treasuryWalletId,
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

    const tx = await this.prisma.blockchainTransaction.create({
      data: {
        type: params.txType,
        status: BlockchainTxStatus.PENDING,
        circleTransactionId,
        circleWalletId: this.circle.treasuryWalletId,
        chain: this.circle.defaultChain,
        ticketId: params.ticketId,
        eventId: params.eventId,
      },
    });

    this.logger.log(
      `Submitted ${params.method} via Circle (txId=${circleTransactionId}, blockchainTxId=${tx.id})`,
    );

    return {
      circleTransactionId,
      blockchainTransactionId: tx.id,
    };
  }

  /** Estimate gas tiers for a Diamond method without sending. */
  async estimateFee(
    method: string,
    args: unknown[],
    amount?: string,
  ): Promise<FeeEstimate> {
    const { signature, abiParameters } = this.encode(method, args);

    const response = await this.circle.client.estimateContractExecutionFee({
      source: { walletId: this.circle.treasuryWalletId },
      contractAddress: this.diamondAddress(),
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
    options: { intervalMs?: number; timeoutMs?: number } = {},
  ): Promise<CircleTransactionSnapshot> {
    const interval = options.intervalMs ?? 3_000;
    const timeout = options.timeoutMs ?? 120_000;
    const deadline = Date.now() + timeout;

    while (Date.now() < deadline) {
      const snapshot = await this.getTransactionStatus(circleTransactionId);
      if (TERMINAL_STATES.has(snapshot.state)) {
        await this.reconcile(circleTransactionId, snapshot);
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

  private diamondAddress(): string {
    return this.config.getOrThrow<string>('blockchain.diamondAddress');
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
