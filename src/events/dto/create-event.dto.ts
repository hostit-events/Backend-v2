import { Type } from 'class-transformer';
import {
  IsArray,
  IsBoolean,
  IsDateString,
  IsEnum,
  IsInt,
  IsNotEmpty,
  IsNumber,
  IsOptional,
  IsString,
  IsUrl,
  Max,
  MaxLength,
  Min,
  ValidateNested,
  ArrayMinSize,
  ArrayMaxSize,
} from 'class-validator';
import { EventCategory } from '@prisma/client';

export class CreateTicketTypeDto {
  @IsString()
  @IsNotEmpty()
  name: string;

  @IsOptional()
  @IsString()
  description?: string;

  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0)
  @Max(500000)
  price: number;

  @IsInt()
  @Min(1)
  @Max(50000)
  quantity: number;

  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(10)
  maxPerUser?: number;

  @IsOptional()
  @IsDateString()
  salesStartDate?: string;

  @IsOptional()
  @IsDateString()
  salesEndDate?: string;
}

export class CreateEventDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(100)
  name: string;

  @IsString()
  @IsNotEmpty()
  @MaxLength(1000)
  description: string;

  @IsString()
  @IsNotEmpty()
  @MaxLength(200)
  venue: string;

  @IsString()
  @IsNotEmpty()
  location: string;

  @IsEnum(EventCategory)
  category: EventCategory;

  @IsOptional()
  @IsUrl()
  coverImage?: string;

  @IsDateString()
  startTime: string;

  @IsDateString()
  endTime: string;

  @IsDateString()
  purchaseStartTime: string;

  @IsOptional()
  @IsBoolean()
  isFree?: boolean;

  @IsOptional()
  @IsBoolean()
  isRefundable?: boolean;

  /**
   * Settlement chain for the event's on-chain ticket entries. Must be one
   * of the server's active chains (see GET /events/chains). Omit to use the
   * server default. Immutable after creation.
   */
  @IsOptional()
  @IsString()
  @IsNotEmpty()
  chain?: string;

  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(5)
  @ValidateNested({ each: true })
  @Type(() => CreateTicketTypeDto)
  ticketTypes: CreateTicketTypeDto[];
}
