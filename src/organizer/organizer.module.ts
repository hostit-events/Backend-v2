import { Module } from '@nestjs/common';
import { PaymentsModule } from '../payments/payments.module';
import { PaystackModule } from '../paystack/paystack.module';
import { BlockchainModule } from '../blockchain/blockchain.module';
import { WalletsModule } from '../wallets/wallets.module';
import { OrganizerController } from './organizer.controller';
import { OrganizerService } from './organizer.service';
import { TicketAdminsService } from './ticket-admins.service';
import { TicketFeesService } from './ticket-fees.service';

/**
 * Organizer-side post-onboarding flows. The role flip itself stays in
 * AuthService.becomeOrganizer (no KYC required); this module handles
 * everything that comes after — currently just per-provider fiat
 * enablement, with Stripe/Flutterwave/etc. landing here when added.
 */
@Module({
  imports: [PaystackModule, PaymentsModule, BlockchainModule, WalletsModule],
  controllers: [OrganizerController],
  providers: [OrganizerService, TicketAdminsService, TicketFeesService],
  exports: [OrganizerService],
})
export class OrganizerModule {}
