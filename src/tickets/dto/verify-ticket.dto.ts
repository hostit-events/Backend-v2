import { IsNotEmpty, IsUUID } from 'class-validator';

/**
 * Body for `POST /api/tickets/:reference/verify`. The eventId pins the
 * verification to a specific event so a ticket from a different event
 * can't be waved through at the wrong door.
 */
export class VerifyTicketDto {
  @IsUUID()
  @IsNotEmpty()
  eventId: string;
}
