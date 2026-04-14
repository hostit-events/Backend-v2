import * as crypto from 'crypto';

/**
 * Generates a short, human-friendly reference. 8 hex chars from
 * 4 random bytes → 32 bits of entropy (~4.3B values), uppercased.
 *
 * Uniqueness collisions are vanishingly rare for our scale, but the
 * `reference` columns are `@unique` so the DB rejects any clash and
 * the caller can retry.
 */
function shortToken(): string {
  return crypto.randomBytes(4).toString('hex').toUpperCase();
}

export function generateTicketReference(): string {
  return `HOSTIT_TKT_${shortToken()}`;
}

export function generateTransactionReference(): string {
  return `HOSTIT_TXN_${shortToken()}`;
}
