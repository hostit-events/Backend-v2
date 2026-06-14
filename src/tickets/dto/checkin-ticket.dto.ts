import { IsNotEmpty, IsUUID } from 'class-validator';

/**
 * Body for `POST /api/tickets/:reference/checkin`. The eventId pins the
 * check-in to a specific event so a ticket from a different event can't
 * be admitted at the wrong door.
 */
export class CheckInTicketDto {
  @IsUUID()
  @IsNotEmpty()
  eventId: string;
}
