import { registerAs } from '@nestjs/config';

/**
 * Crypto (USDC) checkout settings.
 *
 * `usdcNgnRate` is the flat NGN-per-1-USDC rate used to convert an
 * event's NGN ticket price into the USDC amount a buyer must deposit.
 * MVP only — a live FX oracle is a follow-up. `depositExpiryMinutes`
 * bounds how long a returned deposit instruction stays valid.
 */
export default registerAs('crypto', () => ({
  usdcNgnRate: Number(process.env.USDC_NGN_RATE) || 1600,
  depositExpiryMinutes: Number(process.env.CRYPTO_DEPOSIT_EXPIRY_MINUTES) || 30,
}));
