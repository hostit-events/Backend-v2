import { Type } from 'class-transformer';
import { IsEnum, IsOptional, Max } from 'class-validator';
import { EventStatus } from '@prisma/client';
import { PaginationDto } from '../../common/dto/pagination.dto';

/**
 * Query for `GET /api/organizer/events`. Extends the shared pagination
 * DTO but caps limit at 50; status optionally filters the events list
 * (the top-level summary is always computed across all of the
 * organizer's events).
 */
export class QueryOrganizerEventsDto extends PaginationDto {
  @IsOptional()
  @Type(() => Number)
  @Max(50)
  declare limit: number;

  @IsOptional()
  @IsEnum(EventStatus)
  status?: EventStatus;
}
