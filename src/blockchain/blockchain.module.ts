import { Module } from '@nestjs/common';
import { TerminusModule } from '@nestjs/terminus';
import { CircleModule } from '../circle/circle.module';
import { BlockchainHealthIndicator } from './blockchain-health.indicator';
import { BlockchainReadService } from './blockchain-read.service';
import { CircleContractService } from './circle-contract.service';
import { MintQueueService } from './mint-queue.service';

/**
 * Phase 6 surface area:
 *   - BlockchainReadService: ethers-backed view-call wrapper across
 *     every active chain (#33).
 *   - CircleContractService: write path through Circle SCP, signed by
 *     the treasury wallet (#67). Bull workers in #34-#37 call into it.
 *   - BlockchainHealthIndicator: per-chain RPC liveness for /health.
 *   - MintQueueService: stub kept until #35 wires the real queue.
 */
@Module({
  imports: [CircleModule, TerminusModule],
  providers: [
    BlockchainReadService,
    BlockchainHealthIndicator,
    CircleContractService,
    MintQueueService,
  ],
  exports: [
    BlockchainReadService,
    BlockchainHealthIndicator,
    CircleContractService,
    MintQueueService,
  ],
})
export class BlockchainModule {}
