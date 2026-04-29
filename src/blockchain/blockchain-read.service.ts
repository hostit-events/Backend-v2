import { Injectable, Logger } from '@nestjs/common';
import { Contract, JsonRpcProvider } from 'ethers';
import { diamondAbi } from './abis';
import { getChain, listActiveChains } from './chains.config';

export interface TicketData {
  id: bigint;
  createdAt: bigint;
  updatedAt: bigint;
  startTime: bigint;
  endTime: bigint;
  purchaseStartTime: bigint;
  maxTickets: bigint;
  soldTickets: bigint;
  maxTicketsPerUser: number;
  isFree: boolean;
  isRefundable: boolean;
  ticketAdmin: string;
  ticketAddress: string;
  name: string;
  symbol: string;
  uri: string;
}

export interface FeeBreakdown {
  ticketFee: bigint;
  hostItFee: bigint;
  totalFee: bigint;
}

/**
 * Read-only access to deployed Diamonds across active chains. Every
 * method takes the chain id first; the service maintains one cached
 * provider + Contract instance per chain.
 *
 * Writes go through CircleContractService (#67), not here. This
 * service holds no signing keys.
 */
@Injectable()
export class BlockchainReadService {
  private readonly logger = new Logger(BlockchainReadService.name);
  private readonly providers = new Map<string, JsonRpcProvider>();
  private readonly diamonds = new Map<string, Contract>();

  getProvider(chain: string): JsonRpcProvider {
    let provider = this.providers.get(chain);
    if (!provider) {
      const cfg = getChain(chain);
      provider = new JsonRpcProvider(cfg.rpcUrl);
      this.providers.set(chain, provider);
    }
    return provider;
  }

  getDiamond(chain: string): Contract {
    let diamond = this.diamonds.get(chain);
    if (!diamond) {
      const cfg = getChain(chain);
      diamond = new Contract(
        cfg.diamondAddress,
        diamondAbi,
        this.getProvider(chain),
      );
      this.diamonds.set(chain, diamond);
    }
    return diamond;
  }

  // ----- view function wrappers -----

  async getTicketCount(chain: string): Promise<bigint> {
    return this.getDiamond(chain).ticketCount() as Promise<bigint>;
  }

  async ticketExists(chain: string, ticketId: bigint): Promise<boolean> {
    return this.getDiamond(chain).ticketExists(ticketId) as Promise<boolean>;
  }

  async getTicketData(chain: string, ticketId: bigint): Promise<TicketData> {
    const r = await this.getDiamond(chain).ticketData(ticketId);
    return {
      id: r.id,
      createdAt: r.createdAt,
      updatedAt: r.updatedAt,
      startTime: r.startTime,
      endTime: r.endTime,
      purchaseStartTime: r.purchaseStartTime,
      maxTickets: r.maxTickets,
      soldTickets: r.soldTickets,
      maxTicketsPerUser: Number(r.maxTicketsPerUser),
      isFree: r.isFree,
      isRefundable: r.isRefundable,
      ticketAdmin: r.ticketAdmin,
      ticketAddress: r.ticketAddress,
      name: r.name,
      symbol: r.symbol,
      uri: r.uri,
    };
  }

  async getRefundPeriod(chain: string): Promise<bigint> {
    return this.getDiamond(chain).getRefundPeriod() as Promise<bigint>;
  }

  async getAllFees(
    chain: string,
    ticketId: bigint,
    feeType: number,
  ): Promise<FeeBreakdown> {
    const [ticketFee, hostItFee, totalFee] = await this.getDiamond(
      chain,
    ).getAllFees(ticketId, feeType);
    return { ticketFee, hostItFee, totalFee };
  }

  async isFeeEnabled(
    chain: string,
    ticketId: bigint,
    feeType: number,
  ): Promise<boolean> {
    return this.getDiamond(chain).isFeeEnabled(
      ticketId,
      feeType,
    ) as Promise<boolean>;
  }

  async getFeeTokenAddress(chain: string, feeType: number): Promise<string> {
    return this.getDiamond(chain).getFeeTokenAddress(
      feeType,
    ) as Promise<string>;
  }

  async isCheckedIn(
    chain: string,
    ticketId: bigint,
    owner: string,
  ): Promise<boolean> {
    return this.getDiamond(chain).isCheckedIn(
      ticketId,
      owner,
    ) as Promise<boolean>;
  }

  async isCheckedInForDay(
    chain: string,
    ticketId: bigint,
    day: number,
    owner: string,
  ): Promise<boolean> {
    return this.getDiamond(chain).isCheckedInForDay(
      ticketId,
      day,
      owner,
    ) as Promise<boolean>;
  }

  // ----- chain meta -----

  async getBlockNumber(chain: string): Promise<number> {
    return this.getProvider(chain).getBlockNumber();
  }

  /** All chains we know about + can read from right now. */
  listChains() {
    return listActiveChains();
  }
}
