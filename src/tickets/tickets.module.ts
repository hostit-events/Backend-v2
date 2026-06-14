import { forwardRef, Module } from '@nestjs/common';
import { BlockchainModule } from '../blockchain/blockchain.module';
import { PaymentsModule } from '../payments/payments.module';
import { WalletsModule } from '../wallets/wallets.module';
import { QrCodeService } from './qr-code.service';
import { TicketsController } from './tickets.controller';
import { TicketsService } from './tickets.service';

@Module({
  // forwardRef: BlockchainModule imports TicketsModule (for QrCodeService),
  // and TicketsService needs CheckinQueueService from BlockchainModule for
  // the check-in flow (#24) — a circular module dependency.
  imports: [PaymentsModule, WalletsModule, forwardRef(() => BlockchainModule)],
  controllers: [TicketsController],
  providers: [TicketsService, QrCodeService],
  exports: [TicketsService, QrCodeService],
})
export class TicketsModule {}
