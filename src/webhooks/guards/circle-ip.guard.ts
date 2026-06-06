import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
  Logger,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Request } from 'express';

const DEV_ALLOWED_IPS = ['127.0.0.1', '::1', '::ffff:127.0.0.1'];

/**
 * Restricts Circle webhook calls to Circle's documented source IPs.
 * Opt-in: only enforced when `circle.webhookEnforceIp` is true —
 * signature verification is the primary authentication, and IP
 * allowlisting can break behind load balancers/proxies. Localhost is
 * always allowed off-production for ngrok/curl testing.
 */
@Injectable()
export class CircleIpGuard implements CanActivate {
  private readonly logger = new Logger(CircleIpGuard.name);
  private readonly enforce: boolean;
  private readonly allowedIps: string[];
  private readonly isProduction: boolean;

  constructor(configService: ConfigService) {
    this.enforce =
      configService.get<boolean>('circle.webhookEnforceIp') ?? false;
    this.allowedIps =
      configService.get<string[]>('circle.webhookAllowedIps') ?? [];
    this.isProduction =
      configService.get<string>('NODE_ENV') === 'production' ||
      configService.get<string>('app.nodeEnv') === 'production';
  }

  canActivate(ctx: ExecutionContext): boolean {
    if (!this.enforce) return true;

    const req = ctx.switchToHttp().getRequest<Request>();
    const ip = this.extractIp(req);

    const allowed = [
      ...this.allowedIps,
      ...(this.isProduction ? [] : DEV_ALLOWED_IPS),
    ];

    if (!allowed.includes(ip)) {
      this.logger.warn(`Rejected Circle webhook from disallowed IP: ${ip}`);
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
