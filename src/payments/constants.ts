/**
 * HostIT's commission as a fraction of the gross transaction amount.
 * Calculated and locked in at init time from gross — gateway fees come
 * out of the organizer's share, never the platform's.
 */
export const PLATFORM_FEE_RATE = 0.03;

/**
 * `feeBearer` value persisted on Transaction and sent to providers.
 * Today everyone is ORGANIZER; PLATFORM exists for future commercial
 * tiers (e.g. enterprise organizers who pay a flat platform fee that
 * includes gateway fees).
 */
export const DEFAULT_FEE_BEARER: 'ORGANIZER' = 'ORGANIZER';
