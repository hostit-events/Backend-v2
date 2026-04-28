import { Controller, Get } from '@nestjs/common';
import { HealthCheck, HealthCheckService } from '@nestjs/terminus';
import { BlockchainHealthIndicator } from '../blockchain/blockchain-health.indicator';
import { CircleHealthIndicator } from '../circle/circle.health';
import { Public } from '../common/decorators/public.decorator';
import { PrismaHealthIndicator } from './prisma-health.indicator';

@Controller('health')
export class HealthController {
  constructor(
    private health: HealthCheckService,
    private db: PrismaHealthIndicator,
    private circle: CircleHealthIndicator,
    private blockchain: BlockchainHealthIndicator,
  ) {}

  @Get()
  @Public()
  @HealthCheck()
  check() {
    return this.health.check([
      () => this.db.isHealthy('database'),
      () => this.circle.isHealthy('circle'),
      () => this.blockchain.isHealthy('blockchain'),
    ]);
  }
}
