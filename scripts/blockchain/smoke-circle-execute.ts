/**
 * Sanity check for the Circle write path.
 *
 * Calls Circle's `estimateContractExecutionFee` for `createTicket` —
 * a Diamond write that doesn't broadcast a tx but exercises the full
 * stack: entity secret, treasury wallet, tuple args serialization,
 * Circle's decoder against the Diamond ABI, and the on-chain simulator.
 *
 * Usage: pnpm blockchain:smoke-execute
 *
 * Expected: fee tiers print (low/medium/high). If Circle rejects the
 * call, the error message tells you which layer broke (auth, address,
 * ABI, or args shape).
 *
 * Note: requires CIRCLE_TREASURY_WALLET_ID in .env from issue #63.
 */
import { initiateDeveloperControlledWalletsClient } from '@circle-fin/developer-controlled-wallets';
import { Interface, ParamType } from 'ethers';
import * as dotenv from 'dotenv';
import { diamondAbi } from '../../src/blockchain/abis';

dotenv.config();

const METHOD = 'createTicket';
// createTicket has no role check (it auto-grants main admin to the
// caller), so the simulation should pass on a fresh Diamond. The
// timestamps satisfy the contract's validation rules:
//   startTime > now, endTime >= startTime + 1d, purchaseStartTime <= startTime - 1d.
const NOW = Math.floor(Date.now() / 1000);
const START = NOW + 7 * 86_400;
const END = START + 2 * 86_400;
const PURCHASE_START = NOW;
const TICKET_DATA = [
  START, // uint48 startTime
  END, // uint48 endTime
  PURCHASE_START, // uint48 purchaseStartTime
  100, // uint40 maxTickets
  5, // uint8  maxTicketsPerUser
  false, // bool   isFree
  false, // bool   isRefundable
  'Circle Smoke', // string name
  'CSMK', // string symbol
  'ipfs://smoke', // string uri
];
const FEE_TYPES = [4]; // USDC
const FEES = [1_000_000n]; // 1 USDC (6 decimals)
const ARGS: unknown[] = [TICKET_DATA, FEE_TYPES, FEES];

function serializeArg(arg: unknown, type: ParamType): unknown {
  if (type.baseType === 'array') {
    if (!Array.isArray(arg)) {
      throw new Error(`Expected array for ${type.format()}`);
    }
    const elementType = type.arrayChildren as ParamType;
    return arg.map((el) => serializeArg(el, elementType));
  }
  if (type.baseType === 'tuple') {
    const components = type.components ?? [];
    if (Array.isArray(arg)) {
      return components.map((c, i) => serializeArg(arg[i], c));
    }
    if (arg && typeof arg === 'object') {
      const obj = arg as Record<string, unknown>;
      return components.map((c) => serializeArg(obj[c.name], c));
    }
    throw new Error(`Expected array/object for tuple ${type.format()}`);
  }
  if (typeof arg === 'bigint') return arg.toString();
  if (typeof arg === 'boolean') return arg ? 'true' : 'false';
  return String(arg);
}

async function main() {
  const apiKey = process.env.CIRCLE_API_KEY;
  const entitySecret = process.env.CIRCLE_ENTITY_SECRET;
  const treasuryWalletId = process.env.CIRCLE_TREASURY_WALLET_ID;
  const diamondAddress = process.env.DIAMOND_CONTRACT_ADDRESS;

  if (!apiKey || !entitySecret) {
    throw new Error('CIRCLE_API_KEY + CIRCLE_ENTITY_SECRET must be set');
  }
  if (!treasuryWalletId) {
    throw new Error(
      'CIRCLE_TREASURY_WALLET_ID not set — run pnpm circle:bootstrap-treasury first',
    );
  }
  if (!diamondAddress) {
    throw new Error('DIAMOND_CONTRACT_ADDRESS not set');
  }

  const iface = new Interface(diamondAbi);
  const fragment = iface.getFunction(METHOD);
  if (!fragment) throw new Error(`Diamond ABI missing ${METHOD}`);
  const signature = fragment.format('sighash');
  const abiParameters = ARGS.map((a, i) => serializeArg(a, fragment.inputs[i]));

  console.log(`Method:    ${METHOD}`);
  console.log(`Signature: ${signature}`);
  console.log(`Args:      ${JSON.stringify(abiParameters)}`);
  console.log(`Treasury:  ${treasuryWalletId}`);
  console.log(`Diamond:   ${diamondAddress}\n`);

  const client = initiateDeveloperControlledWalletsClient({
    apiKey,
    entitySecret,
  });

  const response = await client.estimateContractExecutionFee({
    source: { walletId: treasuryWalletId },
    contractAddress: diamondAddress,
    abiFunctionSignature: signature,
    abiParameters,
  });

  const data = response.data ?? {};
  console.log('Fee estimate:');
  console.log(JSON.stringify(data, null, 2));
  console.log('\n✓ Circle accepted the request — wiring is sound.');
}

main().catch((err) => {
  console.error('Smoke failed:', err?.response?.data ?? err.message ?? err);
  process.exit(1);
});
