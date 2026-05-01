import { IsNotEmpty, IsString, Length, Matches } from 'class-validator';

/**
 * Body for `POST /api/organizer/providers/monnify/enable`.
 *
 * Monnify is NG-only by design — they do not serve other markets. If
 * the country expands, this DTO doesn't change; we just stop offering
 * Monnify enable as an option for non-NG organizers.
 */
export class EnableMonnifyDto {
  @IsString()
  @IsNotEmpty()
  @Length(11, 11, { message: 'BVN must be exactly 11 digits' })
  @Matches(/^\d{11}$/, { message: 'BVN must contain only digits' })
  bvn: string;

  @IsString()
  @IsNotEmpty()
  bankCode: string;

  @IsString()
  @IsNotEmpty()
  @Length(10, 10, { message: 'Account number must be exactly 10 digits' })
  @Matches(/^\d{10}$/, { message: 'Account number must contain only digits' })
  accountNumber: string;
}
