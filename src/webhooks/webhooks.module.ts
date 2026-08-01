import { Module } from '@nestjs/common';
import { BullModule } from '@nestjs/bullmq';
import { PaymentsModule } from '../payments/payments.module';
import { BlockchainModule } from '../blockchain/blockchain.module';
import { CircleModule } from '../circle/circle.module';
import { CIRCLE_WEBHOOK_QUEUE } from '../blockchain/circle-webhook.queue';
import { WebhooksController } from './webhooks.controller';
import { SettlementController } from './settlement.controller';
import { WebhooksService } from './webhooks.service';
import { MonnifyIpGuard } from './guards/monnify-ip.guard';
import { CircleIpGuard } from './guards/circle-ip.guard';

@Module({
  imports: [
    PaymentsModule,
    BlockchainModule,
    // CircleWebhookService (signature verification).
    CircleModule,
    // Producer side of the Circle webhook queue (consumer is in
    // BlockchainModule); registerQueue is idempotent.
    BullModule.registerQueue({ name: CIRCLE_WEBHOOK_QUEUE }),
  ],
  // SettlementController serves `/payments/*`, not `/webhooks/*`. It
  // lives here because it reuses WebhooksService for settlement — see
  // the class doc for why it cannot sit in PaymentsModule.
  controllers: [WebhooksController, SettlementController],
  providers: [WebhooksService, MonnifyIpGuard, CircleIpGuard],
})
export class WebhooksModule {}
