/**
 * One-time: create the HostIT user wallet set.
 *
 * Usage: pnpm circle:bootstrap-wallet-set
 *
 * Idempotent — if CIRCLE_WALLET_SET_ID is already set in .env, verifies it still
 * exists on Circle and exits. Otherwise creates a new set and prints the ID.
 *
 * Prerequisites:
 *   - CIRCLE_API_KEY + CIRCLE_ENTITY_SECRET in .env
 *   - `pnpm circle:register-secret` completed (one-time)
 *
 * See issue #61 for context, #63 for the platform treasury wallet (separate set).
 */
import { initiateDeveloperControlledWalletsClient } from '@circle-fin/developer-controlled-wallets';
import * as dotenv from 'dotenv';

dotenv.config();

const WALLET_SET_NAME = 'hostit-users';

async function main() {
  const apiKey = process.env.CIRCLE_API_KEY;
  const entitySecret = process.env.CIRCLE_ENTITY_SECRET;
  const existingId = process.env.CIRCLE_WALLET_SET_ID;

  if (!apiKey || !entitySecret) {
    throw new Error(
      'CIRCLE_API_KEY and CIRCLE_ENTITY_SECRET must be set in .env before bootstrapping',
    );
  }

  const client = initiateDeveloperControlledWalletsClient({
    apiKey,
    entitySecret,
  });

  if (existingId) {
    try {
      const existing = await client.getWalletSet({ id: existingId });
      if (existing.data?.walletSet?.id) {
        console.log(
          `✓ Wallet set already configured: ${existingId}\n  No action needed.`,
        );
        return;
      }
    } catch {
      console.warn(
        `CIRCLE_WALLET_SET_ID=${existingId} is set but not found on Circle — creating a new one.`,
      );
    }
  }

  const response = await client.createWalletSet({ name: WALLET_SET_NAME });
  const id = response.data?.walletSet?.id;

  if (!id) {
    console.error('Unexpected response shape:', response);
    process.exit(1);
  }

  console.log(`✓ Wallet set "${WALLET_SET_NAME}" created.`);
  console.log(`\nCIRCLE_WALLET_SET_ID=${id}\n`);
  console.log('Paste that line into your .env and restart the app.');
}

main().catch((err) => {
  console.error('Bootstrap failed:', err?.response?.data ?? err);
  process.exit(1);
});
