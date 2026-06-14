import { forwardRef, Module } from '@nestjs/common';
import { BullModule } from '@nestjs/bullmq';
import { TerminusModule } from '@nestjs/terminus';
import { CircleModule } from '../circle/circle.module';
import { NotificationsModule } from '../notifications/notifications.module';
import { TicketsModule } from '../tickets/tickets.module';
import { BlockchainHealthIndicator } from './blockchain-health.indicator';
import { BlockchainReadService } from './blockchain-read.service';
import { CircleContractService } from './circle-contract.service';
import {
  CheckinQueueService,
  TICKET_CHECKIN_QUEUE,
} from './checkin-queue.service';
import { CircleWebhookProcessor } from './circle-webhook.processor';
import { CIRCLE_WEBHOOK_QUEUE } from './circle-webhook.queue';
import { EventPublishProcessor } from './event-publish.processor';
import { MintFinalizerService } from './mint-finalizer.service';
import { MintQueueService, TICKET_MINT_QUEUE } from './mint-queue.service';
import { MintTicketProcessor } from './mint-ticket.processor';
import { TicketCheckinProcessor } from './ticket-checkin.processor';

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
    // NotificationsService (TICKET_CONFIRMATION email). TicketsModule now
    // depends back on this module (CheckinQueueService for #24 check-in),
    // so the edge is circular — broken with forwardRef on both sides.
    forwardRef(() => TicketsModule),
    NotificationsModule,
    // EventsModule registers `event-publish` for the producer side;
    // this re-registration is the consumer side. BullMQ treats
    // registerQueue as idempotent so both modules can share cleanly.
    BullModule.registerQueue({ name: 'event-publish' }),
    BullModule.registerQueue({ name: TICKET_MINT_QUEUE }),
    BullModule.registerQueue({ name: TICKET_CHECKIN_QUEUE }),
    // Consumer side of the Circle webhook queue. The WebhooksModule
    // registers the producer side; registerQueue is idempotent.
    BullModule.registerQueue({ name: CIRCLE_WEBHOOK_QUEUE }),
  ],
  providers: [
    BlockchainReadService,
    BlockchainHealthIndicator,
    CircleContractService,
    EventPublishProcessor,
    MintFinalizerService,
    MintQueueService,
    MintTicketProcessor,
    CheckinQueueService,
    TicketCheckinProcessor,
    CircleWebhookProcessor,
  ],
  exports: [
    BlockchainReadService,
    BlockchainHealthIndicator,
    CircleContractService,
    MintFinalizerService,
    MintQueueService,
    CheckinQueueService,
  ],
})
export class BlockchainModule {}
