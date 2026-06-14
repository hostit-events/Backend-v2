import { Type } from 'class-transformer';
import {
  IsEnum,
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  Max,
  Min,
} from 'class-validator';
import { TicketStatus } from '@prisma/client';
import { PaginationDto } from '../../common/dto/pagination.dto';

/**
 * Query for `GET /api/organizer/events/:id/attendees`. Attendee lists use
 * a higher default page size (50) and ceiling (200) than the standard
 * pagination DTO — event-day rosters are long.
 */
export class QueryAttendeesDto extends PaginationDto {
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(200)
  limit: number = 50;

  @IsOptional()
  @IsEnum(TicketStatus)
  status?: TicketStatus;

  @IsOptional()
  @IsUUID()
  ticketTypeId?: string;

  @IsOptional()
  @IsString()
  search?: string;
}
