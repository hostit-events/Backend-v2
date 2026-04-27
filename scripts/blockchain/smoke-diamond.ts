/**
 * Smoke test for the Base Sepolia Diamond deployment.
 *
 * Usage: pnpm blockchain:smoke
 *
 * Reads BLOCKCHAIN_RPC_URL + DIAMOND_CONTRACT_ADDRESS from .env, calls
 * a handful of view functions on the Diamond and prints results. No
 * writes — safe to run anytime.
 *
 * Expected output on a fresh deployment with no events created yet:
 *   getRefundPeriod = 259200n   (3 days in seconds)
 *   ticketCount     = 0n
 *   getHostItFee(1_000_000) = 30_000n  (3% of input)
 */
import { JsonRpcProvider, Contract } from 'ethers';
import * as dotenv from 'dotenv';
import { diamondAbi } from '../../src/blockchain/abis';

dotenv.config();

async function main() {
  const rpcUrl = process.env.BLOCKCHAIN_RPC_URL;
  const diamondAddress = process.env.DIAMOND_CONTRACT_ADDRESS;

  if (!rpcUrl) throw new Error('BLOCKCHAIN_RPC_URL not set');
  if (!diamondAddress) throw new Error('DIAMOND_CONTRACT_ADDRESS not set');

  console.log(`RPC:     ${rpcUrl}`);
  console.log(`Diamond: ${diamondAddress}\n`);

  const provider = new JsonRpcProvider(rpcUrl);
  const network = await provider.getNetwork();
  console.log(`Connected. chainId=${network.chainId} name=${network.name}\n`);

  const code = await provider.getCode(diamondAddress);
  if (code === '0x') {
    throw new Error(
      `No contract code at ${diamondAddress} on this RPC. Wrong network?`,
    );
  }
  console.log(`Bytecode present (${(code.length - 2) / 2} bytes).\n`);

  const diamond = new Contract(diamondAddress, diamondAbi, provider);

  const refundPeriod = await diamond.getRefundPeriod();
  console.log(`getRefundPeriod()       = ${refundPeriod} (expect 259200)`);

  const ticketCount = await diamond.ticketCount();
  console.log(`ticketCount()           = ${ticketCount}`);

  const hostItFee = await diamond.getHostItFee(1_000_000n);
  console.log(`getHostItFee(1_000_000) = ${hostItFee} (expect 30000 = 3%)`);

  // FeeType.USDC = 4 per LibAddressesAndFees enum
  const usdcAddress = await diamond.getFeeTokenAddress(4);
  console.log(`getFeeTokenAddress(USDC)= ${usdcAddress}`);

  console.log('\n✓ Smoke test passed — Diamond is reachable and responding.');
}

main().catch((err) => {
  console.error('Smoke test failed:', err.message ?? err);
  process.exit(1);
});
