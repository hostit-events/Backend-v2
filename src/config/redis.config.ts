import { registerAs } from '@nestjs/config';

export default registerAs('redis', () => ({
  host: process.env.REDIS_HOST || 'localhost',
  port: parseInt(process.env.REDIS_PORT ?? '6379', 10),
  password: process.env.REDIS_PASSWORD || undefined,
  // 'true' enables TLS-wrapped connection (Upstash, Redis Cloud, etc).
  // Default 'false' for local docker Redis which runs plaintext.
  tls: process.env.REDIS_TLS || 'false',
}));
