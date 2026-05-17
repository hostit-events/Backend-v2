import { Module } from '@nestjs/common';
import { BullModule } from '@nestjs/bullmq';
import { TerminusModule } from '@nestjs/terminus';
import { CircleModule } from '../circle/circle.module';
import { NotificationsModule } from '../notifications/notifications.module';
import { TicketsModule } from '../tickets/tickets.module';
import { BlockchainHealthIndicator } from './blockchain-health.indicator';
import { BlockchainReadService } from './blockchain-read.service';
import { CircleContractService } from './circle-contract.service';
import { EventPublishProcessor } from './event-publish.processor';
import { MintQueueService, TICKET_MINT_QUEUE } from './mint-queue.service';
import { MintTicketProcessor } from './mint-ticket.processor';

/**
 * Phase 6 surface area:
 *   - BlockchainReadService: ethers-backed view-call wrapper across
 *     every active chain (#33).
 *   - CircleContractService: write path through Circle SCP, signed by
 *     the treasury wallet (#67). Bull workers call into it.
 *   - EventPublishProcessor: consumes `event-publish` jobs, runs
 *     createTicket on the Diamond, writes back the on-chain ticketId
 *     to the originating TicketType (#34).
 *   - MintTicketProcessor: consumes `ticket-mint` jobs, runs
 *     mintTicket on the Diamond, persists tokenId, issues QR, and
 *     enqueues the ticket-confirmation email (#35).
 *   - BlockchainHealthIndicator: per-chain RPC liveness for /health.
 */
@Module({
  imports: [
    CircleModule,
    TerminusModule,
    // Pulled in for QrCodeService (issued from the mint worker) and
    // NotificationsService (TICKET_CONFIRMATION email). Neither module
    // depends on Blockchain, so no cycle is introduced.
    TicketsModule,
    NotificationsModule,
    // EventsModule registers `event-publish` for the producer side;
    // this re-registration is the consumer side. BullMQ treats
    // registerQueue as idempotent so both modules can share cleanly.
    BullModule.registerQueue({ name: 'event-publish' }),
    BullModule.registerQueue({ name: TICKET_MINT_QUEUE }),
  ],
  providers: [
    BlockchainReadService,
    BlockchainHealthIndicator,
    CircleContractService,
    EventPublishProcessor,
    MintQueueService,
    MintTicketProcessor,
  ],
  exports: [
    BlockchainReadService,
    BlockchainHealthIndicator,
    CircleContractService,
    MintQueueService,
  ],
})
export class BlockchainModule {}
