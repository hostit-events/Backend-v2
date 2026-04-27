import { Module } from '@nestjs/common';
import { CircleModule } from '../circle/circle.module';
import { CircleContractService } from './circle-contract.service';
import { MintQueueService } from './mint-queue.service';

/**
 * Phase 6 entry point. Currently exposes:
 *   - CircleContractService: write path through Circle SCP, signed by
 *     the treasury wallet (#67). Bull workers in #34-#37 call into it.
 *   - MintQueueService: stub kept until #35 wires the real ticket-mint
 *     queue against CircleContractService.
 *
 * Reads (view functions) still happen via ethers from any consumer
 * holding a JsonRpcProvider — no service for those yet (#33).
 */
@Module({
  imports: [CircleModule],
  providers: [CircleContractService, MintQueueService],
  exports: [CircleContractService, MintQueueService],
})
export class BlockchainModule {}
