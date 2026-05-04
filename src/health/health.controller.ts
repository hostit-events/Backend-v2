import { Controller, Get } from '@nestjs/common';
import { HealthCheck, HealthCheckService } from '@nestjs/terminus';
import { BlockchainHealthIndicator } from '../blockchain/blockchain-health.indicator';
import { CircleHealthIndicator } from '../circle/circle.health';
import { Public } from '../common/decorators/public.decorator';
import { PrismaHealthIndicator } from './prisma-health.indicator';

@Controller()
export class HealthController {
  constructor(
    private health: HealthCheckService,
    private db: PrismaHealthIndicator,
    private circle: CircleHealthIndicator,
    private blockchain: BlockchainHealthIndicator,
  ) {}

  /**
   * Heavy composite check — DB + Circle + per-chain RPC. For human/
   * dashboard use. Slow path; some checks make outbound network calls.
   */
  @Get('health')
  @Public()
  @HealthCheck()
  check() {
    return this.health.check([
      () => this.db.isHealthy('database'),
      () => this.circle.isHealthy('circle'),
      () => this.blockchain.isHealthy('blockchain'),
    ]);
  }

  /**
   * Lightweight liveness endpoint for platform health checks (Render,
   * Kubernetes, AWS ALB, etc). Returns 200 immediately without doing
   * any I/O. Use the heavy `/health` for actual diagnostics.
   */
  @Get('healthz')
  @Public()
  healthz() {
    return { status: 'ok' };
  }
}
