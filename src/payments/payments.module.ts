import { Module } from '@nestjs/common';
import { PaymentsService } from './payments.service';

/**
 * Phase 5 payments module. Provider implementations are added in
 * follow-up PRs and registered with `PaymentsService` here.
 */
@Module({
  providers: [PaymentsService],
  exports: [PaymentsService],
})
export class PaymentsModule {}
