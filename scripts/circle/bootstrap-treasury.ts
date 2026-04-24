/**
 * One-time: create the HostIT platform treasury wallet.
 *
 * The treasury wallet signs all platform-side on-chain operations:
 * event publication, ticket minting, check-ins, and balance withdrawals
 * (see issues #67 and #34-#37). It is intentionally kept in its own
 * wallet set so admin rotation/revocation doesn't touch user wallets.
 *
 * Usage: pnpm circle:bootstrap-treasury
 *
 * Idempotent — reads CIRCLE_TREASURY_WALLET_ID from .env and, if present,
 * verifies the wallet still exists on Circle. Otherwise creates a fresh
 * wallet set + wallet on the configured chain.
 *
 * Prerequisites:
 *   - CIRCLE_API_KEY + CIRCLE_ENTITY_SECRET in .env
 *   - `pnpm circle:register-secret` completed
 *
 * After running, paste the printed IDs into .env and restart the app.
 *
 * See issue #63.
 */
import { initiateDeveloperControlledWalletsClient } from '@circle-fin/developer-controlled-wallets';
import * as dotenv from 'dotenv';
import { randomUUID } from 'node:crypto';

dotenv.config();

const WALLET_SET_NAME = 'hostit-treasury';
const ACCOUNT_TYPE = 'SCA' as const;

async function main() {
  const apiKey = process.env.CIRCLE_API_KEY;
  const entitySecret = process.env.CIRCLE_ENTITY_SECRET;
  const chain = process.env.CIRCLE_DEFAULT_CHAIN || 'BASE-SEPOLIA';

  const existingWalletSetId = process.env.CIRCLE_TREASURY_WALLET_SET_ID;
  const existingWalletId = process.env.CIRCLE_TREASURY_WALLET_ID;

  if (!apiKey || !entitySecret) {
    throw new Error(
      'CIRCLE_API_KEY and CIRCLE_ENTITY_SECRET must be set in .env before bootstrapping',
    );
  }

  const client = initiateDeveloperControlledWalletsClient({
    apiKey,
    entitySecret,
  });

  // Fast path: both IDs already configured — verify they exist and exit.
  if (existingWalletSetId && existingWalletId) {
    try {
      const [walletSet, wallet] = await Promise.all([
        client.getWalletSet({ id: existingWalletSetId }),
        client.getWallet({ id: existingWalletId }),
      ]);
      if (walletSet.data?.walletSet?.id && wallet.data?.wallet?.id) {
        console.log(
          `✓ Treasury already configured:\n` +
            `  walletSetId=${existingWalletSetId}\n` +
            `  walletId=${existingWalletId}\n` +
            `  address=${wallet.data.wallet.address}\n  chain=${wallet.data.wallet.blockchain}\n` +
            `No action needed.`,
        );
        return;
      }
    } catch {
      console.warn(
        `CIRCLE_TREASURY_WALLET_ID is set but not found on Circle — creating a new treasury.`,
      );
    }
  }

  // Create (or reuse) a dedicated wallet set for the treasury.
  let walletSetId = existingWalletSetId;
  if (!walletSetId) {
    const setResponse = await client.createWalletSet({
      name: WALLET_SET_NAME,
      idempotencyKey: randomUUID(),
    });
    walletSetId = setResponse.data?.walletSet?.id;
    if (!walletSetId) {
      console.error('Unexpected createWalletSet response:', setResponse);
      process.exit(1);
    }
    console.log(`✓ Treasury wallet set created: ${walletSetId}`);
  } else {
    console.log(`→ Reusing existing treasury wallet set: ${walletSetId}`);
  }

  // Create the treasury wallet inside that set.
  const walletsResponse = await client.createWallets({
    accountType: ACCOUNT_TYPE,
    blockchains: [chain as 'BASE-SEPOLIA'],
    count: 1,
    walletSetId,
    idempotencyKey: randomUUID(),
  });

  const wallet = walletsResponse.data?.wallets?.[0];
  if (!wallet?.id) {
    console.error('Unexpected createWallets response:', walletsResponse);
    process.exit(1);
  }

  console.log(`\n✓ Treasury wallet created.\n`);
  console.log(`CIRCLE_TREASURY_WALLET_SET_ID=${walletSetId}`);
  console.log(`CIRCLE_TREASURY_WALLET_ID=${wallet.id}\n`);
  console.log(`  address: ${wallet.address}`);
  console.log(`  chain:   ${wallet.blockchain}`);
  console.log(`  type:    ${ACCOUNT_TYPE}\n`);
  console.log(
    'Next steps:\n' +
      '  1. Paste both lines above into .env and restart the app\n' +
      '  2. Fund the address with a small USDC balance on testnet (faucet or transfer)\n' +
      '  3. Once #66 lands (Diamond on Base), grant this address the\n' +
      '     mainAdmin + ticketAdmin roles on the Diamond via a governance tx\n',
  );
}

main().catch((err) => {
  console.error('Treasury bootstrap failed:', err?.response?.data ?? err);
  process.exit(1);
});
