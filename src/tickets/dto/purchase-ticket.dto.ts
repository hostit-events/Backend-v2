import {
  IsEmail,
  IsEnum,
  IsInt,
  IsNotEmpty,
  IsOptional,
  IsString,
  IsUUID,
  Matches,
  Max,
  Min,
} from 'class-validator';
import { DeliveryChannel, PaymentProvider } from '@prisma/client';

export class PurchaseTicketDto {
  @IsUUID()
  eventId: string;

  @IsUUID()
  ticketTypeId: string;

  @IsInt()
  @Min(1)
  @Max(10)
  quantity: number;

  @IsEmail()
  buyerEmail: string;

  @IsString()
  @IsNotEmpty()
  buyerName: string;

  @IsOptional()
  @IsString()
  @Matches(/^\+234\d{10}$/, {
    message: 'buyerPhone must be in +234XXXXXXXXXX format',
  })
  buyerPhone?: string;

  @IsEnum(DeliveryChannel)
  deliveryChannel: DeliveryChannel;

  @IsEnum(PaymentProvider)
  paymentProvider: PaymentProvider;
}
