import { IsNumber, Max, Min } from 'class-validator';

/**
 * New face price (NGN) for a ticket type. Converted to the on-chain USDC
 * fee (6-dp) the same way publish does. Paid-event bounds mirror event
 * creation (>= 500, <= 500000).
 */
export class UpdateTicketFeeDto {
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(500)
  @Max(500000)
  priceNgn: number;
}
