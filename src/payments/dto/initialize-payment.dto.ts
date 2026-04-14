import {
  IsEmail,
  IsEnum,
  IsInt,
  IsNotEmpty,
  IsObject,
  IsOptional,
  IsString,
  IsUrl,
  Min,
} from 'class-validator';
import { PaymentProvider } from '@prisma/client';

export class InitializePaymentDto {
  @IsEnum(PaymentProvider)
  provider: PaymentProvider;

  /** Amount in NGN (whole naira, not kobo). */
  @IsInt()
  @Min(1)
  amount: number;

  @IsEmail()
  email: string;

  @IsString()
  @IsNotEmpty()
  reference: string;

  @IsUrl({ require_tld: false })
  callbackUrl: string;

  @IsOptional()
  @IsObject()
  metadata?: Record<string, any>;
}
