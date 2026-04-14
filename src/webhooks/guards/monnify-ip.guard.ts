import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
  Logger,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Request } from 'express';

const MONNIFY_ALLOWED_IPS = ['35.242.133.146'];
const DEV_ALLOWED_IPS = ['127.0.0.1', '::1', '::ffff:127.0.0.1'];

/**
 * Restricts Monnify webhook calls to the documented source IP.
 * Localhost is allowed when `NODE_ENV !== 'production'` so ngrok and
 * curl-based testing work.
 */
@Injectable()
export class MonnifyIpGuard implements CanActivate {
  private readonly logger = new Logger(MonnifyIpGuard.name);
  private readonly isProduction: boolean;

  constructor(configService: ConfigService) {
    this.isProduction =
      configService.get<string>('NODE_ENV') === 'production' ||
      configService.get<string>('app.nodeEnv') === 'production';
  }

  canActivate(ctx: ExecutionContext): boolean {
    const req = ctx.switchToHttp().getRequest<Request>();
    const ip = this.extractIp(req);

    const allowed = [
      ...MONNIFY_ALLOWED_IPS,
      ...(this.isProduction ? [] : DEV_ALLOWED_IPS),
    ];

    if (!allowed.includes(ip)) {
      this.logger.warn(`Rejected Monnify webhook from disallowed IP: ${ip}`);
      throw new ForbiddenException('Source IP not allowed');
    }
    return true;
  }

  private extractIp(req: Request): string {
    // x-forwarded-for is comma-separated; the leftmost is the original client.
    const forwarded = req.headers['x-forwarded-for'];
    if (typeof forwarded === 'string' && forwarded.length > 0) {
      return forwarded.split(',')[0].trim();
    }
    return req.ip ?? '';
  }
}
