import { IsNotEmpty, IsString, Length, Matches } from 'class-validator';

/**
 * Body for `POST /api/organizer/providers/paystack/enable`.
 *
 * Today this is NG-shaped (BVN + 3-digit bank code + 10-digit NUBAN)
 * because Paystack-NG is the only Paystack lane HostIT is wired to. The
 * day we enable Paystack for GH/KE/ZA, this DTO splits per-country or
 * grows a `country` discriminator.
 */
export class EnablePaystackDto {
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
