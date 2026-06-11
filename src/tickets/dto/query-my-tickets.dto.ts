import { Type } from 'class-transformer';
import { IsEnum, IsOptional, IsUUID, Max } from 'class-validator';
import { TicketStatus } from '@prisma/client';
import { PaginationDto } from '../../common/dto/pagination.dto';

/**
 * Query for `GET /api/tickets/mine`. Extends the shared pagination DTO
 * but caps limit at 50 (a buyer's ticket list is small; no need for the
 * default 100 ceiling). Status / eventId are optional filters.
 */
export class QueryMyTicketsDto extends PaginationDto {
  @IsOptional()
  @Type(() => Number)
  @Max(50)
  declare limit: number;

  @IsOptional()
  @IsEnum(TicketStatus)
  status?: TicketStatus;

  @IsOptional()
  @IsUUID()
  eventId?: string;
}
