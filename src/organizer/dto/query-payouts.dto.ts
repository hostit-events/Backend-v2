import { IsEnum, IsOptional } from 'class-validator';
import { PayoutStatus } from '@prisma/client';
import { PaginationDto } from '../../common/dto/pagination.dto';

/**
 * Query for `GET /organizer/payouts`. Paginated; `status` optionally
 * filters the list. The summary is always computed across ALL of the
 * organizer's payouts, independent of the filter.
 */
export class QueryPayoutsDto extends PaginationDto {
  @IsOptional()
  @IsEnum(PayoutStatus)
  status?: PayoutStatus;
}
