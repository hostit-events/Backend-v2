import { Module } from '@nestjs/common';
import { PaymentsModule } from '../payments/payments.module';
import { WalletsModule } from '../wallets/wallets.module';
import { QrCodeService } from './qr-code.service';
import { TicketsController } from './tickets.controller';
import { TicketsService } from './tickets.service';

@Module({
  imports: [PaymentsModule, WalletsModule],
  controllers: [TicketsController],
  providers: [TicketsService, QrCodeService],
  exports: [TicketsService, QrCodeService],
})
export class TicketsModule {}
