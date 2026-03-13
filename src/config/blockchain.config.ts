import { registerAs } from '@nestjs/config';

export default registerAs('blockchain', () => ({
  rpcUrl: process.env.BLOCKCHAIN_RPC_URL,
  diamondAddress: process.env.DIAMOND_CONTRACT_ADDRESS,
  platformPrivateKey: process.env.PLATFORM_PRIVATE_KEY,
}));
