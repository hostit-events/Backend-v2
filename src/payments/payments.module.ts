import { Module } from '@nestjs/common';
import { PaymentsController } from './payments.controller';
import { PaymentsService } from './payments.service';
import { MonnifyProvider } from './providers/monnify.provider';
import { PaystackProvider } from './providers/paystack.provider';

/**
 * Phase 5 payments module. Provider implementations are added in
 * follow-up PRs and registered with `PaymentsService` here.
 */
@Module({
  controllers: [PaymentsController],
  providers: [PaymentsService, PaystackProvider, MonnifyProvider],
  exports: [PaymentsService, PaystackProvider, MonnifyProvider],
})
export class PaymentsModule {}
