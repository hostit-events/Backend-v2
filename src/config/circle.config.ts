import { registerAs } from '@nestjs/config';

export default registerAs('circle', () => ({
  apiKey: process.env.CIRCLE_API_KEY,
  entitySecret: process.env.CIRCLE_ENTITY_SECRET,
  walletSetId: process.env.CIRCLE_WALLET_SET_ID,
  treasuryWalletSetId: process.env.CIRCLE_TREASURY_WALLET_SET_ID,
  treasuryWalletId: process.env.CIRCLE_TREASURY_WALLET_ID,
  environment: process.env.CIRCLE_ENVIRONMENT || 'sandbox',
  defaultChain: process.env.CIRCLE_DEFAULT_CHAIN || 'BASE-SEPOLIA',
  // REST base used for non-SDK calls (e.g. fetching the webhook public
  // key for signature verification). Same host for sandbox + prod —
  // the API key determines the environment.
  apiBaseUrl: process.env.CIRCLE_API_BASE_URL || 'https://api.circle.com',
  // Webhook delivery. When `webhooksEnabled` is true the mint worker
  // stops polling and waits for the Circle webhook to drive completion.
  // Defaults to false so the polling fallback stays in control until a
  // notification subscription is actually wired in the Circle console.
  webhooksEnabled: process.env.CIRCLE_WEBHOOKS_ENABLED === 'true',
  // Documented Circle webhook source IPs. Enforced by CircleIpGuard
  // only when `webhookEnforceIp` is true (off by default — signature
  // verification is the primary auth; IP allowlisting can break behind
  // some proxies).
  webhookEnforceIp: process.env.CIRCLE_WEBHOOK_ENFORCE_IP === 'true',
  webhookAllowedIps: (
    process.env.CIRCLE_WEBHOOK_ALLOWED_IPS ||
    '54.243.112.156,100.24.191.35,54.165.52.248,54.87.106.46'
  )
    .split(',')
    .map((ip) => ip.trim())
    .filter(Boolean),
}));
