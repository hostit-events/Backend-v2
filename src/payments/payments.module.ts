import { Module } from '@nestjs/common';
import { PaymentsService } from './payments.service';
import { PaystackProvider } from './providers/paystack.provider';

/**
 * Phase 5 payments module. Provider implementations are added in
 * follow-up PRs and registered with `PaymentsService` here.
 */
@Module({
  providers: [PaymentsService, PaystackProvider],
  exports: [PaymentsService, PaystackProvider],
})
export class PaymentsModule {}
