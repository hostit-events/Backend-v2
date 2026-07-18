import { Prisma } from '@prisma/client';

/**
 * FeeType enum codes from the deployed Base MarketplaceFacet
 * (Blockscout-verified): NONE=0, FIAT=1, then tokens. Single source of
 * truth for both the publish producer (event-publish) and the crypto
 * settlement worker. `FIAT` (1) is intentionally absent — it isn't
 * mintable via mintTicket nor settable via setTicketFees.
 */
export const FEE_TYPE_BY_NAME: Record<string, number> = {
  NATIVE: 2,
  WNATIVE: 3,
  USDT: 4,
  USDC: 5,
  USDT0: 6,
  EURC: 7,
  GHO: 8,
  LINK: 9,
  LSK: 10,
};

/**
 * ⚠️ TEMPORARY TESTNET WORKAROUND — revert after the Diamond is redeployed.
 *
 * The deployed Base Sepolia Diamond has the real USDC token address
 * registered under the **USDT (4)** slot; `FeeType.USDC (5)` is UNSET, so
 * `mintTicket(…, USDC, …)` reverts `TokenAddressZero()`. Until a redeploy
 * maps USDC (5) → 0x036CbD5…, we route crypto settlement (publish fee +
 * approve + mintTicket) through the USDT slot, which resolves to the USDC
 * token on-chain. Flip `SETTLEMENT_FEE_TYPE_NAME` back to `'USDC'` once the
 * contract is fixed. Tracked in epic #96.
 */
export const SETTLEMENT_FEE_TYPE_NAME = 'USDT';

/** On-chain FeeType code used for crypto (USDC) settlement. */
export const FEE_TYPE_USDC = FEE_TYPE_BY_NAME[SETTLEMENT_FEE_TYPE_NAME];

/** USDC is 6-decimal everywhere Circle issues it. */
export const USDC_DECIMALS = 6;

/**
 * HostIT platform fee in basis points, matching the deployed
 * MarketplaceFacet's `hostItFeeBps` (300 = 3%). Keep in sync with the
 * contract; the authoritative value at settlement is always read on-chain
 * via `getAllFees`, but this drives the off-chain publish + deposit math.
 */
export const HOSTIT_FEE_BPS = 300;

export interface UsdcFees {
  /** Organizer's cut, USDC base units (6dp) — the on-chain `ticketFee`. */
  ticketFee: string;
  /** ticketFee + HostIT's cut, USDC base units — what the buyer pays. */
  totalFee: string;
}

/**
 * On-chain USDC fees for a ticket priced in NGN, under the ORGANIZER-BEARS
 * model: the buyer pays the face price, so HostIT's cut is backed out of
 * the price when setting `ticketFee` (ticketFee = price * 10000/(10000+bps)).
 * Mirrors the contract's integer math (hostItFee = floor(ticketFee*bps/1e4))
 * so an off-chain estimate matches what the Diamond will charge.
 */
export function computeUsdcFees(
  priceNgn: Prisma.Decimal | string | number,
  usdcNgnRate: number,
): UsdcFees {
  const facePrice = new Prisma.Decimal(priceNgn)
    .div(usdcNgnRate)
    .mul(10 ** USDC_DECIMALS);
  const ticketFee = facePrice
    .mul(10_000)
    .div(10_000 + HOSTIT_FEE_BPS)
    .toDecimalPlaces(0, Prisma.Decimal.ROUND_DOWN);
  const hostItFee = ticketFee
    .mul(HOSTIT_FEE_BPS)
    .div(10_000)
    .toDecimalPlaces(0, Prisma.Decimal.ROUND_DOWN);
  return {
    ticketFee: ticketFee.toFixed(0),
    totalFee: ticketFee.add(hostItFee).toFixed(0),
  };
}
