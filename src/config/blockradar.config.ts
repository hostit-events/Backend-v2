import { registerAs } from '@nestjs/config';

export default registerAs('blockradar', () => ({
  apiKey: process.env.BLOCKRADAR_API_KEY,
  masterWalletId: process.env.BLOCKRADAR_MASTER_WALLET_ID,
  baseUrl: process.env.BLOCKRADAR_BASE_URL || 'https://api.blockradar.co/v1',
}));
