/**
 * Pre-purchase inspection.
 *
 * Reads the latest on-chain ticket, its fee per FeeType, the platform
 * 3% cut, plus the buyer wallet's native + USDC balance and its
 * Diamond allowance. Prints a checklist of what's still needed before
 * a mint can succeed.
 *
 * Usage: pnpm blockchain:inspect <buyer-address>
 *
 * If buyer-address is omitted, falls back to the most recently created
 * UserWallet in the DB.
 */
import { JsonRpcProvider, Contract, formatEther, formatUnits } from 'ethers';
import * as dotenv from 'dotenv';
import { diamondAbi } from '../../src/blockchain/abis';

dotenv.config();

const ERC20_MIN_ABI = [
  'function balanceOf(address) view returns (uint256)',
  'function allowance(address owner, address spender) view returns (uint256)',
  'function decimals() view returns (uint8)',
  'function symbol() view returns (string)',
];

// FeeType enum from LibAddressesAndFees.sol
const FEE_TYPES: Record<string, number> = {
  ETH: 1,
  WETH: 2,
  USDT: 3,
  USDC: 4,
  USDT0: 5,
  EURC: 6,
  GHO: 7,
  LINK: 8,
  LSK: 9,
};

function resolveBuyer(): string {
  const argv = process.argv[2];
  if (!argv) {
    throw new Error(
      'Pass a buyer address: pnpm blockchain:inspect 0x...\n' +
        'Find one via: SELECT address FROM user_wallets WHERE creation_status = \'CREATED\' ORDER BY created_at DESC LIMIT 1;',
    );
  }
  return argv;
}

async function main() {
  const rpcUrl = process.env.BLOCKCHAIN_RPC_URL!;
  const diamondAddress = process.env.DIAMOND_CONTRACT_ADDRESS!;
  const buyer = resolveBuyer();

  const provider = new JsonRpcProvider(rpcUrl);
  const diamond = new Contract(diamondAddress, diamondAbi, provider);

  // --- Latest ticket
  const count = await diamond.ticketCount();
  const ticketId = count;
  console.log(`ticketCount     = ${count}`);
  console.log(`Inspecting ticket id ${ticketId}\n`);

  const data = await diamond.ticketData(ticketId);
  const now = Math.floor(Date.now() / 1000);
  console.log('Ticket data:');
  console.log(`  name              = ${data.name}`);
  console.log(`  symbol            = ${data.symbol}`);
  console.log(`  uri               = ${data.uri}`);
  console.log(`  ticketAddress     = ${data.ticketAddress}`);
  console.log(`  ticketAdmin       = ${data.ticketAdmin}`);
  console.log(`  startTime         = ${data.startTime} (${data.startTime > now ? 'future' : 'past'})`);
  console.log(`  endTime           = ${data.endTime}`);
  console.log(`  purchaseStartTime = ${data.purchaseStartTime} (${data.purchaseStartTime <= now ? 'open' : 'not yet'})`);
  console.log(`  maxTickets        = ${data.maxTickets}`);
  console.log(`  soldTickets       = ${data.soldTickets}`);
  console.log(`  maxTicketsPerUser = ${data.maxTicketsPerUser}`);
  console.log(`  isFree            = ${data.isFree}`);
  console.log(`  isRefundable      = ${data.isRefundable}\n`);

  // --- Fees enabled
  console.log('Fees enabled per FeeType:');
  const enabled: Array<{ type: string; code: number; ticketFee: bigint; hostItFee: bigint; total: bigint }> = [];
  for (const [name, code] of Object.entries(FEE_TYPES)) {
    const isOn = await diamond.isFeeEnabled(ticketId, code);
    if (!isOn) continue;
    const [ticketFee, hostItFee, totalFee] = await diamond.getAllFees(ticketId, code);
    enabled.push({ type: name, code, ticketFee, hostItFee, total: totalFee });
    console.log(
      `  ${name.padEnd(6)} (code=${code}): ticketFee=${ticketFee} hostItFee=${hostItFee} total=${totalFee}`,
    );
  }
  if (enabled.length === 0) {
    console.log('  (none enabled — purchase impossible until setTicketFees is called)\n');
    return;
  }
  console.log('');

  // --- Buyer state for each enabled fee type
  console.log(`Buyer:           ${buyer}`);
  const native = await provider.getBalance(buyer);
  console.log(`Native balance:  ${formatEther(native)} ETH (gas — SCA wallets don't strictly need this if Circle covers gas)\n`);

  for (const fee of enabled) {
    if (fee.code === FEE_TYPES.ETH) {
      const need = fee.total;
      const ok = native >= need;
      console.log(
        `[${fee.type}] need ${formatEther(need)} ETH; have ${formatEther(native)} → ${ok ? 'OK' : 'INSUFFICIENT'}`,
      );
      continue;
    }
    const tokenAddress = await diamond.getFeeTokenAddress(fee.code);
    if (tokenAddress === '0x0000000000000000000000000000000000000000') {
      console.log(`[${fee.type}] token address not configured on this chain`);
      continue;
    }
    const erc20 = new Contract(tokenAddress, ERC20_MIN_ABI, provider);
    const [bal, allowance, dec, sym] = await Promise.all([
      erc20.balanceOf(buyer) as Promise<bigint>,
      erc20.allowance(buyer, diamondAddress) as Promise<bigint>,
      erc20.decimals() as Promise<bigint>,
      erc20.symbol() as Promise<string>,
    ]);
    const haveBal = bal >= fee.total;
    const haveAllow = allowance >= fee.total;
    console.log(
      `[${fee.type}] token=${sym} (${tokenAddress})\n` +
        `   need:      ${formatUnits(fee.total, dec)} ${sym}\n` +
        `   balance:   ${formatUnits(bal, dec)} ${sym} ${haveBal ? '✓' : '✗ insufficient'}\n` +
        `   allowance: ${formatUnits(allowance, dec)} ${sym} → Diamond ${haveAllow ? '✓' : '✗ approve required'}`,
    );
  }
}

main().catch((err) => {
  console.error('Inspection failed:', err.message ?? err);
  process.exit(1);
});
