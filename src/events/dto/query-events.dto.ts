import { Type } from 'class-transformer';
import {
  IsBoolean,
  IsDateString,
  IsEnum,
  IsIn,
  IsOptional,
  IsString,
  Max,
} from 'class-validator';
import { EventCategory } from '@prisma/client';
import { PaginationDto } from '../../common/dto/pagination.dto';

export class QueryEventsDto extends PaginationDto {
  @IsOptional()
  @Type(() => Number)
  @Max(50)
  declare limit: number;

  @IsOptional()
  @IsString()
  search?: string;

  @IsOptional()
  @IsEnum(EventCategory)
  category?: EventCategory;

  @IsOptional()
  @IsString()
  location?: string;

  @IsOptional()
  @Type(() => Boolean)
  @IsBoolean()
  isFree?: boolean;

  @IsOptional()
  @IsDateString()
  startDate?: string;

  @IsOptional()
  @IsDateString()
  endDate?: string;

  @IsOptional()
  @IsIn(['startTime', 'createdAt', 'name'])
  sort?: string = 'startTime';

  @IsOptional()
  @IsIn(['asc', 'desc'])
  order?: 'asc' | 'desc' = 'asc';
}
