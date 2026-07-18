import { Module } from '@nestjs/common';
import { CircleModule } from '../circle/circle.module';
import { PaymentsController } from './payments.controller';
import { PaymentsService } from './payments.service';
import { CryptoCheckoutService } from './crypto-checkout.service';
import { MonnifyProvider } from './providers/monnify.provider';
import { PaystackProvider } from './providers/paystack.provider';

/**
 * Phase 5 payments module. Provider implementations are added in
 * follow-up PRs and registered with `PaymentsService` here.
 */
@Module({
  imports: [CircleModule],
  controllers: [PaymentsController],
  providers: [
    PaymentsService,
    CryptoCheckoutService,
    PaystackProvider,
    MonnifyProvider,
  ],
  exports: [
    PaymentsService,
    CryptoCheckoutService,
    PaystackProvider,
    MonnifyProvider,
  ],
})
export class PaymentsModule {}
