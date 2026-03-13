import { registerAs } from '@nestjs/config';

export default registerAs('auth', () => ({
  jwtSecret: process.env.JWT_SECRET,
  jwtExpiration: process.env.JWT_EXPIRATION || '24h',
  bcryptRounds: parseInt(process.env.BCRYPT_ROUNDS ?? '10', 10),
}));
