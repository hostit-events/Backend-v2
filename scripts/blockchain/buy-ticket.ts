/**
 * End-to-end purchase test: a Circle-managed buyer wallet calls
 * mintTicket on the live Base Sepolia Diamond, paying in native ETH.
 *
 * Usage:
 *   pnpm blockchain:buy-ticket <ticketId> <buyerWalletId> [feeType]
 *
 *   ticketId       — uint64, e.g. 2
 *   buyerWalletId  — Circle wallet UUID for the buyer
 *                    (look up via SELECT circle_wallet_id FROM user_wallets ...)
 *   feeType        — symbolic name; defaults to ETH
 *
 * The script:
 *   1. Reads the ticket's total fee for the chosen FeeType (ethers, read-only).
 *   2. Estimates Circle's gas for the mintTicket call.
 *   3. Submits the call via Circle, signed by the buyer's wallet.
 *   4. Polls Circle until terminal state, prints the on-chain tx hash.
 *
 * For ERC20 fee types (USDC, etc) you'd need a prior `approve` call —
 * not handled here; this is the ETH happy path.
 */
import {
  initiateDeveloperControlledWalletsClient,
  type CircleDeveloperControlledWalletsClient,
} from '@circle-fin/developer-controlled-wallets';
import { Contract, JsonRpcProvider, formatEther, formatUnits } from 'ethers';
import * as dotenv from 'dotenv';
import { diamondAbi } from '../../src/blockchain/abis';

dotenv.config();

const FEE_TYPES: Record<string, number> = {
  ETH: 1,
  WETH: 2,
  USDT: 3,
  USDC: 4,
};
const TERMINAL = new Set([
  'COMPLETE',
  'CONFIRMED',
  'FAILED',
  'DENIED',
  'CANCELLED',
]);

interface Args {
  ticketId: bigint;
  buyerWalletId: string;
  feeTypeName: string;
  feeTypeCode: number;
}

function parseArgs(): Args {
  const [ticketArg, walletArg, feeArg = 'ETH'] = process.argv.slice(2);
  if (!ticketArg || !walletArg) {
    throw new Error(
      'Usage: pnpm blockchain:buy-ticket <ticketId> <buyerWalletId> [feeType]',
    );
  }
  const code = FEE_TYPES[feeArg.toUpperCase()];
  if (code === undefined) {
    throw new Error(
      `Unknown feeType ${feeArg}. Supported: ${Object.keys(FEE_TYPES).join(', ')}`,
    );
  }
  return {
    ticketId: BigInt(ticketArg),
    buyerWalletId: walletArg,
    feeTypeName: feeArg.toUpperCase(),
    feeTypeCode: code,
  };
}

async function pollUntilTerminal(
  client: CircleDeveloperControlledWalletsClient,
  txId: string,
) {
  const deadline = Date.now() + 180_000;
  while (Date.now() < deadline) {
    const r = await client.getTransaction({ id: txId });
    const tx = r.data?.transaction;
    const state = tx?.state ?? 'UNKNOWN';
    process.stdout.write(`  state=${state}\n`);
    if (TERMINAL.has(state)) return tx;
    await new Promise((r) => setTimeout(r, 4_000));
  }
  throw new Error(`Timed out polling Circle tx ${txId}`);
}

async function main() {
  const args = parseArgs();

  const apiKey = process.env.CIRCLE_API_KEY;
  const entitySecret = process.env.CIRCLE_ENTITY_SECRET;
  const rpcUrl = process.env.BLOCKCHAIN_RPC_URL;
  const diamondAddress = process.env.DIAMOND_CONTRACT_ADDRESS;

  if (!apiKey || !entitySecret || !rpcUrl || !diamondAddress) {
    throw new Error(
      'Need CIRCLE_API_KEY, CIRCLE_ENTITY_SECRET, BLOCKCHAIN_RPC_URL, DIAMOND_CONTRACT_ADDRESS in env',
    );
  }

  const client = initiateDeveloperControlledWalletsClient({
    apiKey,
    entitySecret,
  });
  const provider = new JsonRpcProvider(rpcUrl);
  const diamond = new Contract(diamondAddress, diamondAbi, provider);

  // ---- 1. Resolve buyer address + ticket fee
  const walletResp = await client.getWallet({ id: args.buyerWalletId });
  const buyerAddress = walletResp.data?.wallet?.address;
  if (!buyerAddress) {
    throw new Error(`Buyer wallet ${args.buyerWalletId} not found on Circle`);
  }

  const enabled = await diamond.isFeeEnabled(args.ticketId, args.feeTypeCode);
  if (!enabled) {
    throw new Error(
      `Ticket ${args.ticketId} does not accept ${args.feeTypeName}`,
    );
  }
  const [, , total] = await diamond.getAllFees(
    args.ticketId,
    args.feeTypeCode,
  );

  console.log(`Buyer:        ${buyerAddress} (walletId=${args.buyerWalletId})`);
  console.log(`Ticket:       #${args.ticketId}`);
  console.log(`Fee type:     ${args.feeTypeName} (code=${args.feeTypeCode})`);
  console.log(
    `Amount:       ${args.feeTypeCode === FEE_TYPES.ETH ? formatEther(total) + ' ETH' : formatUnits(total, 6) + ' tokens'}\n`,
  );

  if (args.feeTypeCode !== FEE_TYPES.ETH) {
    console.warn(
      'WARNING: ERC20 path requires a prior approve() call from the buyer wallet.\n' +
        '         This script only handles native ETH. Stopping before submission.\n',
    );
    return;
  }

  // ---- 2. Estimate fee (no broadcast)
  const ethAmount = formatEther(total);
  const sig = 'mintTicket(uint64,uint8,address)';
  const params = [args.ticketId.toString(), String(args.feeTypeCode), buyerAddress];

  const estimate = await client.estimateContractExecutionFee({
    source: { walletId: args.buyerWalletId },
    contractAddress: diamondAddress,
    abiFunctionSignature: sig,
    abiParameters: params,
    amount: ethAmount,
  });
  console.log('Fee estimate (medium tier):');
  console.log('  ', JSON.stringify(estimate.data?.medium ?? {}));
  console.log('');

  // ---- 3. Submit
  console.log('Submitting mintTicket via Circle…');
  const exec = await client.createContractExecutionTransaction({
    walletId: args.buyerWalletId,
    contractAddress: diamondAddress,
    abiFunctionSignature: sig,
    abiParameters: params,
    amount: ethAmount,
    fee: { type: 'level', config: { feeLevel: 'MEDIUM' } },
  });
  const txId = exec.data?.id;
  if (!txId) {
    throw new Error(`No transactionId in response: ${JSON.stringify(exec.data)}`);
  }
  console.log(`  Circle txId: ${txId}\n`);

  // ---- 4. Poll
  console.log('Polling for terminal state…');
  const final = await pollUntilTerminal(client, txId);
  console.log('');

  if (final?.state === 'COMPLETE' || final?.state === 'CONFIRMED') {
    console.log('✓ Mint succeeded.');
    console.log(`  txHash:      ${final.txHash}`);
    console.log(`  blockHeight: ${final.blockHeight}`);
    console.log(
      `  Basescan:    https://sepolia.basescan.org/tx/${final.txHash}`,
    );
    return;
  }

  console.error('✗ Mint did not reach success.');
  console.error(`  state: ${final?.state}`);
  console.error(`  error: ${final?.errorReason ?? '(none)'}`);
  process.exit(1);
}

main().catch((err) => {
  console.error('Buy script failed:', err?.response?.data ?? err.message ?? err);
  process.exit(1);
});
