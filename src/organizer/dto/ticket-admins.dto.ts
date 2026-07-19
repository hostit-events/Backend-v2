import { ArrayMaxSize, ArrayMinSize, IsArray, IsUUID } from 'class-validator';

/**
 * Users to grant/revoke as on-chain ticket admins (check-in delegates)
 * for an event. Each id is a HostIT user whose wallet on the event's
 * chain receives (or loses) the ticketAdmin role.
 */
export class TicketAdminsDto {
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(20)
  @IsUUID('4', { each: true })
  userIds: string[];
}
