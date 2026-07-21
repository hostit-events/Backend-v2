import { IsUUID } from 'class-validator';

/**
 * Body for `POST /organizer/payouts/request`. Crypto-only in this slice:
 * the payout withdraws the event's on-chain USDC escrow, so no provider
 * or destination is taken — funds go to the organizer's Circle wallet.
 */
export class RequestPayoutDto {
  @IsUUID()
  eventId: string;
}
