import { IsNotEmpty, IsString, Length, Matches } from 'class-validator';

/**
 * Body for `PUT /api/organizer/bank-details`. Mirrors the bank fields of
 * the provider-enable DTOs: a 3-digit-ish NUBAN bank code and a 10-digit
 * account number. The account name is resolved from Paystack, never
 * trusted from the client.
 */
export class UpdateBankDetailsDto {
  @IsString()
  @IsNotEmpty()
  bankCode: string;

  @IsString()
  @IsNotEmpty()
  @Length(10, 10, { message: 'Account number must be exactly 10 digits' })
  @Matches(/^\d{10}$/, { message: 'Account number must contain only digits' })
  accountNumber: string;
}
