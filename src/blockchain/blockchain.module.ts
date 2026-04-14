import { Module } from '@nestjs/common';
import { MintQueueService } from './mint-queue.service';

/**
 * Phase 6 placeholder. For now exposes a stub `MintQueueService` so
 * Phase 5 webhooks can call into it. Real BullMQ wiring lands with
 * issues #33–#35.
 */
@Module({
  providers: [MintQueueService],
  exports: [MintQueueService],
})
export class BlockchainModule {}
