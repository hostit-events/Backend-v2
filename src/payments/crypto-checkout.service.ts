import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Prisma, WalletCreationStatus } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
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
 * Direct USDC deposit checkout (MVP of #69).
 *
 * Builds a deposit instruction for a pending transaction: the buyer
 * sends `amountUsdc` USDC to their own per-chain Circle wallet, and the
 * `transactions.inbound` webhook settles the purchase (see the inbound
 * handler in CircleWebhookProcessor). A `CryptoDeposit` row links the
 * receiving wallet to the transaction so the webhook can match it.
 *
 * MVP scope: funds land in the buyer's (HostIT-custodied) wallet;
 * sweeping to treasury / organizer settlement is a follow-up tied to
 * payouts (#68). Pricing uses a flat NGN→USDC rate, not a live oracle.
 */
@Injectable()
export class CryptoCheckoutService {
  private readonly logger = new Logger(CryptoCheckoutService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
  ) {}

  /** Convert an NGN amount to a 6-dp USDC Decimal using the flat rate. */
  ngnToUsdc(amountNgn: Prisma.Decimal): Prisma.Decimal {
    const rate = this.config.getOrThrow<number>('crypto.usdcNgnRate');
    return amountNgn.div(rate).toDecimalPlaces(USDC_DECIMALS);
  }

  /**
   * Create the deposit instruction + CryptoDeposit row for a pending
   * crypto transaction. Throws if the buyer has no ready wallet on the
   * event's chain (the webhook needs a known receiving wallet to match).
   */
  async createDepositIntent(input: {
    transactionId: string;
    buyerId: string;
    chain: string;
    /** Unit ticket price in the event currency (NGN). */
    priceNgn: Prisma.Decimal | string;
    quantity: number;
  }): Promise<DepositIntent> {
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

    // The deposit must cover the on-chain `totalFee` (ticketFee + HostIT's
    // cut) for every ticket, since `mintTicket` pulls totalFee per mint from
    // this wallet. Estimated off-chain via the shared fee helper (same math
    // that set the on-chain ticketFee at publish); the settlement worker
    // approves the authoritative on-chain totalFee at mint time.
    const usdcNgnRate = this.config.getOrThrow<number>('crypto.usdcNgnRate');
    const totalFeeBaseUnits = computeUsdcFees(
      input.priceNgn,
      usdcNgnRate,
    ).totalFee;
    const amountUsdc = new Prisma.Decimal(totalFeeBaseUnits)
      .mul(input.quantity)
      .div(10 ** USDC_DECIMALS);
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
        amountUsdc,
        usdcAddress: chainCfg.usdcAddress,
        expiresAt,
      },
    });

    this.logger.log(
      `Crypto deposit intent created (txn=${input.transactionId}, chain=${input.chain}, amountUsdc=${amountUsdc.toString()})`,
    );

    return {
      chain: input.chain,
      address: wallet.address,
      amountUsdc: amountUsdc.toString(),
      usdcAddress: chainCfg.usdcAddress,
      decimals: USDC_DECIMALS,
      expiresAt,
    };
  }
}
