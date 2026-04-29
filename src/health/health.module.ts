import { Module } from '@nestjs/common';
import { TerminusModule } from '@nestjs/terminus';
import { BlockchainModule } from '../blockchain/blockchain.module';
import { CircleModule } from '../circle/circle.module';
import { HealthController } from './health.controller';
import { PrismaHealthIndicator } from './prisma-health.indicator';

@Module({
  imports: [TerminusModule, CircleModule, BlockchainModule],
  controllers: [HealthController],
  providers: [PrismaHealthIndicator],
})
export class HealthModule {}
