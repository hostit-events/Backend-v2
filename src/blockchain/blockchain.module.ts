import { Module } from '@nestjs/common';
import { BullModule } from '@nestjs/bullmq';
import { TerminusModule } from '@nestjs/terminus';
import { CircleModule } from '../circle/circle.module';
import { BlockchainHealthIndicator } from './blockchain-health.indicator';
import { BlockchainReadService } from './blockchain-read.service';
import { CircleContractService } from './circle-contract.service';
import { EventPublishProcessor } from './event-publish.processor';
import { MintQueueService } from './mint-queue.service';

/**
 * Phase 6 surface area:
 *   - BlockchainReadService: ethers-backed view-call wrapper across
 *     every active chain (#33).
 *   - CircleContractService: write path through Circle SCP, signed by
 *     the treasury wallet (#67). Bull workers call into it.
 *   - EventPublishProcessor: consumes `event-publish` jobs, runs
 *     createTicket on the Diamond, writes back the on-chain ticketId
 *     to the originating TicketType (#34).
 *   - BlockchainHealthIndicator: per-chain RPC liveness for /health.
 *   - MintQueueService: stub kept until #35 wires the real queue.
 */
@Module({
  imports: [
    CircleModule,
    TerminusModule,
    // EventsModule registers this queue for the producer side; this
    // re-registration is the consumer side. BullMQ treats registerQueue
    // as idempotent so both modules can share the queue cleanly.
    BullModule.registerQueue({ name: 'event-publish' }),
  ],
  providers: [
    BlockchainReadService,
    BlockchainHealthIndicator,
    CircleContractService,
    EventPublishProcessor,
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
