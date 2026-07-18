import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Prisma, WalletCreationStatus } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { CircleService } from '../circle/circle.service';
import { getChain } from '../blockchain/chains.config';
import { computeUsdcFees } from '../blockchain/onchain-fees';

/** USDC is 6-decimal everywhere Circle issues it. */
const USDC_DECIMALS = 6;

export interface DepositIntent {
  chain: string;
  /** HostIT-custodied address the buyer sends USDC to. */
  address: string;
  /** USDC amount to send, as a decimal string (6 dp). */
  amountUsdc: string;
  /** USDC token contract on `chain`. */
  usdcAddress: string;
  decimals: number;
  expiresAt: Date;
}

/**
 * How a crypto purchase will settle:
 *  - `balance`: the buyer's custodial wallet already holds enough USDC;
 *    settle straight from balance (no deposit step).
 *  - `deposit`: top-up needed — `deposit.amountUsdc` is the SHORTFALL the
 *    buyer must send; the mint pulls the full total from the combined
 *    balance afterwards.
 */
export type CryptoSettlementPlan =
  | { mode: 'balance'; requiredUsdc: string; walletBalanceUsdc: string }
  | { mode: 'deposit'; deposit: DepositIntent; walletBalanceUsdc: string };

/**
 * Crypto (USDC) checkout. Funds are always spent from the buyer's own
 * HostIT-custodied Circle wallet — the settlement worker signs
 * `approve` + `mintTicket` from it. This service decides whether that
 * wallet can already cover the purchase (pay from balance) or needs a
 * top-up deposit first.
 *
 * Pricing uses a flat NGN→USDC rate (not a live oracle); the on-chain
 * split + settlement is handled by MintTicketProcessor.
 */
@Injectable()
export class CryptoCheckoutService {
  private readonly logger = new Logger(CryptoCheckoutService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
    private readonly circle: CircleService,
  ) {}

  /** Convert an NGN amount to a 6-dp USDC Decimal using the flat rate. */
  ngnToUsdc(amountNgn: Prisma.Decimal): Prisma.Decimal {
    const rate = this.config.getOrThrow<number>('crypto.usdcNgnRate');
    return amountNgn.div(rate).toDecimalPlaces(USDC_DECIMALS);
  }

  /**
   * Decide how a pending crypto transaction settles. Reads the buyer's
   * custodial USDC balance: if it covers the required total, returns a
   * `balance` plan (caller settles + enqueues mints immediately); else
   * creates a `CryptoDeposit` for the shortfall and returns a `deposit`
   * plan (the inbound webhook settles once the top-up lands).
   *
   * Throws if the buyer has no ready wallet on the event's chain.
   */
  async prepareCrypto(input: {
    transactionId: string;
    buyerId: string;
    chain: string;
    /** Unit ticket price in the event currency (NGN). */
    priceNgn: Prisma.Decimal | string;
    quantity: number;
  }): Promise<CryptoSettlementPlan> {
    const chainCfg = getChain(input.chain);

    const wallet = await this.prisma.userWallet.findFirst({
      where: { userId: input.buyerId, chain: input.chain },
    });
    if (
      !wallet ||
      !wallet.circleWalletId ||
      !wallet.address ||
      wallet.creationStatus !== WalletCreationStatus.CREATED
    ) {
      throw new BadRequestException(
        'Your wallet is still being provisioned. Please retry crypto checkout in a moment.',
      );
    }

    // Required = on-chain totalFee (ticketFee + HostIT's cut) per ticket,
    // times quantity — exactly what `mintTicket` pulls across the N mints.
    // Estimated off-chain via the shared fee helper (same math that set the
    // on-chain ticketFee at publish); the worker approves the authoritative
    // on-chain totalFee at mint time.
    const usdcNgnRate = this.config.getOrThrow<number>('crypto.usdcNgnRate');
    const totalFeeBaseUnits = computeUsdcFees(
      input.priceNgn,
      usdcNgnRate,
    ).totalFee;
    const requiredUsdc = new Prisma.Decimal(totalFeeBaseUnits)
      .mul(input.quantity)
      .div(10 ** USDC_DECIMALS);

    const walletBalanceUsdc = await this.getUsdcBalance(
      wallet.circleWalletId,
      chainCfg.usdcAddress,
    );

    // Enough already in the custodial wallet — pay from balance, no deposit.
    if (walletBalanceUsdc.gte(requiredUsdc)) {
      this.logger.log(
        `Crypto pay-from-balance (txn=${input.transactionId}, required=${requiredUsdc.toFixed(USDC_DECIMALS)}, balance=${walletBalanceUsdc.toFixed(USDC_DECIMALS)})`,
      );
      return {
        mode: 'balance',
        requiredUsdc: requiredUsdc.toFixed(USDC_DECIMALS),
        walletBalanceUsdc: walletBalanceUsdc.toFixed(USDC_DECIMALS),
      };
    }

    // Short — deposit only the missing amount. The mint pulls the full
    // total from the combined (existing + topped-up) balance.
    const shortfall = requiredUsdc.sub(walletBalanceUsdc);
    const expiryMinutes = this.config.getOrThrow<number>(
      'crypto.depositExpiryMinutes',
    );
    const expiresAt = new Date(Date.now() + expiryMinutes * 60_000);

    await this.prisma.cryptoDeposit.create({
      data: {
        transactionId: input.transactionId,
        chain: input.chain,
        walletId: wallet.circleWalletId,
        address: wallet.address,
        amountUsdc: shortfall,
        usdcAddress: chainCfg.usdcAddress,
        expiresAt,
      },
    });

    this.logger.log(
      `Crypto deposit (shortfall) created (txn=${input.transactionId}, shortfall=${shortfall.toFixed(USDC_DECIMALS)}, balance=${walletBalanceUsdc.toFixed(USDC_DECIMALS)})`,
    );

    return {
      mode: 'deposit',
      walletBalanceUsdc: walletBalanceUsdc.toFixed(USDC_DECIMALS),
      deposit: {
        chain: input.chain,
        address: wallet.address,
        amountUsdc: shortfall.toFixed(USDC_DECIMALS),
        usdcAddress: chainCfg.usdcAddress,
        decimals: USDC_DECIMALS,
        expiresAt,
      },
    };
  }

  /** Current USDC balance of a Circle wallet, as a Decimal (0 if none). */
  private async getUsdcBalance(
    circleWalletId: string,
    usdcAddress: string,
  ): Promise<Prisma.Decimal> {
    const response = await this.circle.client.getWalletTokenBalance({
      id: circleWalletId,
    });
    const balances = response.data?.tokenBalances ?? [];
    const usdc = balances.find(
      (b) => b.token?.tokenAddress?.toLowerCase() === usdcAddress.toLowerCase(),
    );
    return new Prisma.Decimal(usdc?.amount ?? 0);
  }
}
