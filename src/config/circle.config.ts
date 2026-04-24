import { registerAs } from '@nestjs/config';

export default registerAs('circle', () => ({
  apiKey: process.env.CIRCLE_API_KEY,
  entitySecret: process.env.CIRCLE_ENTITY_SECRET,
  walletSetId: process.env.CIRCLE_WALLET_SET_ID,
  treasuryWalletSetId: process.env.CIRCLE_TREASURY_WALLET_SET_ID,
  treasuryWalletId: process.env.CIRCLE_TREASURY_WALLET_ID,
  environment: process.env.CIRCLE_ENVIRONMENT || 'sandbox',
  defaultChain: process.env.CIRCLE_DEFAULT_CHAIN || 'BASE-SEPOLIA',
}));
