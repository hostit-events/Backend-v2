import { Module } from '@nestjs/common';
import { PaymentsModule } from '../payments/payments.module';
import { BlockchainModule } from '../blockchain/blockchain.module';
import { WebhooksController } from './webhooks.controller';
import { WebhooksService } from './webhooks.service';
import { MonnifyIpGuard } from './guards/monnify-ip.guard';

@Module({
  imports: [PaymentsModule, BlockchainModule],
  controllers: [WebhooksController],
  providers: [WebhooksService, MonnifyIpGuard],
})
export class WebhooksModule {}
