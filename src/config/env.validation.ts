import * as Joi from 'joi';

export const envValidationSchema = Joi.object({
  // App
  NODE_ENV: Joi.string()
    .valid('development', 'production', 'test')
    .default('development'),
  PORT: Joi.number().default(3000),
  API_PREFIX: Joi.string().default('api'),

  // Database
  DATABASE_URL: Joi.string().required(),

  // Redis
  REDIS_HOST: Joi.string().default('localhost'),
  REDIS_PORT: Joi.number().default(6379),
  REDIS_PASSWORD: Joi.string().allow('').default(''),

  // Auth
  JWT_SECRET: Joi.string().required(),
  JWT_EXPIRATION: Joi.string().default('24h'),
  BCRYPT_ROUNDS: Joi.number().default(10),

  // Paystack
  PAYSTACK_SECRET_KEY: Joi.string().required(),
  PAYSTACK_PUBLIC_KEY: Joi.string().required(),

  // Dev escape hatches — must NOT be 'true' in production. Each
  // bypass also self-disables when NODE_ENV=production.
  SKIP_BVN_VERIFICATION: Joi.string().valid('true', 'false').default('false'),
  // Skip Paystack's upfront bank-account resolve in /become-organizer.
  // Used in dev because Paystack and Monnify sandboxes accept mutually
  // exclusive test bank data — skipping the upfront check lets each
  // provider validate independently during sub-account creation.
  SKIP_BANK_VERIFICATION: Joi.string().valid('true', 'false').default('false'),

  // Monnify
  MONNIFY_API_KEY: Joi.string().required(),
  MONNIFY_SECRET_KEY: Joi.string().required(),
  MONNIFY_CONTRACT_CODE: Joi.string().required(),
  MONNIFY_BASE_URL: Joi.string().uri().default('https://sandbox.monnify.com'),

  // Blockradar (scoped to NGN virtual accounts only — see hostit skill §3B.7)
  BLOCKRADAR_API_KEY: Joi.string().required(),
  BLOCKRADAR_MASTER_WALLET_ID: Joi.string().required(),
  BLOCKRADAR_BASE_URL: Joi.string()
    .uri()
    .default('https://api.blockradar.co/v1'),

  // Circle Wallet-as-a-Service (primary wallet + on-chain ops provider)
  CIRCLE_API_KEY: Joi.string().required(),
  CIRCLE_ENTITY_SECRET: Joi.string().length(64).hex().required(),
  CIRCLE_WALLET_SET_ID: Joi.string().uuid().required(),
  CIRCLE_TREASURY_WALLET_SET_ID: Joi.string().uuid().required(),
  CIRCLE_TREASURY_WALLET_ID: Joi.string().uuid().required(),
  CIRCLE_ENVIRONMENT: Joi.string()
    .valid('sandbox', 'production')
    .default('sandbox'),
  CIRCLE_DEFAULT_CHAIN: Joi.string().default('BASE-SEPOLIA'),

  // Blockchain — multi-chain registry. ACTIVE_CHAINS is the comma-
  // separated list of chain ids the backend is allowed to use; each
  // active chain requires its own *_RPC_URL and *_DIAMOND_ADDRESS
  // pair. Joi can't conditionally require pairs based on list contents,
  // so we mark them all optional here and let chains.config.ts throw a
  // clear error at first use if an active chain is missing config.
  ACTIVE_CHAINS: Joi.string().default('BASE-SEPOLIA'),
  BASE_SEPOLIA_RPC_URL: Joi.string().uri().optional(),
  BASE_SEPOLIA_DIAMOND_ADDRESS: Joi.string()
    .pattern(/^0x[0-9a-fA-F]{40}$/)
    .optional(),
  BASE_RPC_URL: Joi.string().uri().optional(),
  BASE_DIAMOND_ADDRESS: Joi.string()
    .pattern(/^0x[0-9a-fA-F]{40}$/)
    .optional(),

  // Legacy single-chain vars — being phased out in favour of the
  // per-chain registry above. Kept optional so existing scripts and
  // .env files continue working through the transition. Remove once
  // all consumers (#34-#37 Bull queues, smoke scripts, CI) are
  // ported to the registry.
  BLOCKCHAIN_RPC_URL: Joi.string().uri().optional(),
  DIAMOND_CONTRACT_ADDRESS: Joi.string().optional(),
  PLATFORM_PRIVATE_KEY: Joi.string().optional(),

  // SendGrid
  SENDGRID_API_KEY: Joi.string().required(),
  SENDGRID_FROM_EMAIL: Joi.string().email().required(),

  // Twilio
  TWILIO_ACCOUNT_SID: Joi.string().required(),
  TWILIO_AUTH_TOKEN: Joi.string().required(),
  TWILIO_PHONE_NUMBER: Joi.string().required(),
});
