import { Module } from '@nestjs/common';
import { PaymentsModule } from '../payments/payments.module';
import { QrCodeService } from './qr-code.service';
import { TicketsController } from './tickets.controller';
import { TicketsService } from './tickets.service';

@Module({
  imports: [PaymentsModule],
  controllers: [TicketsController],
  providers: [TicketsService, QrCodeService],
  exports: [TicketsService, QrCodeService],
})
export class TicketsModule {}
