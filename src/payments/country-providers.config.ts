import { PaymentProvider } from '@prisma/client';

/**
 * Per-country payment provider registry.
 *
 * The source of truth for "which fiat providers can settle a payment
 * for an event held in country X." Crypto is NOT in this map — it's
 * handled separately because it's universally available and gated only
 * by Event.acceptsCrypto, not by country.
 *
 * Adding a new country at MVP is supposed to be a config change, not a
 * code refactor: append a new key with the providers that serve it,
 * make sure the corresponding *Provider class is registered in
 * PaymentsModule, and you're done.
 */

export interface ProviderConfig {
  /** Maps to the PaymentProvider Prisma enum. */
  id: PaymentProvider;
  /** Human-readable channels this provider supports in the country. */
  methods: PaymentMethod[];
  /**
   * Whether this is the recommended default for the country. Frontend
   * uses this to highlight one option; multiple defaults are fine,
   * none is also fine.
   */
  default?: boolean;
}

export type PaymentMethod =
  | 'CARD'
  | 'BANK_TRANSFER'
  | 'USSD'
  | 'NQR'
  | 'MOMO'
  | 'MPESA';

/**
 * Active fiat providers per country (ISO-3166-1 alpha-2).
 *
 * Today: Nigeria only. Add a row the day a new country has a wired
 * provider class.
 */
export const FIAT_PROVIDERS_BY_COUNTRY: Record<string, ProviderConfig[]> = {
  NG: [
    {
      id: PaymentProvider.PAYSTACK,
      methods: ['CARD', 'BANK_TRANSFER', 'USSD'],
      default: true,
    },
    {
      id: PaymentProvider.MONNIFY,
      methods: ['CARD', 'BANK_TRANSFER', 'USSD', 'NQR'],
    },
  ],
  // Add new countries here as their providers come online:
  // GH: [{ id: PaymentProvider.PAYSTACK, methods: ['CARD', 'MOMO'], default: true }],
  // KE: [{ id: PaymentProvider.PAYSTACK, methods: ['CARD', 'MPESA'], default: true }],
  // ZA: [{ id: PaymentProvider.PAYSTACK, methods: ['CARD'],         default: true }],
};

/**
 * Crypto checkout option. Always returned alongside fiat (when the
 * event opts in via `acceptsCrypto`), regardless of country. Tokens
 * advertised here are the universally-supported ones; per-event token
 * eligibility eventually narrows to whatever feeTypes the ticket type
 * actually accepts on-chain.
 */
export const CRYPTO_OPTION = {
  type: 'crypto' as const,
  tokens: ['USDC', 'ETH'] as const,
};

export function fiatProvidersForCountry(country: string): ProviderConfig[] {
  return FIAT_PROVIDERS_BY_COUNTRY[country] ?? [];
}
