import { IsOptional, IsString, Matches, MinLength } from 'class-validator';
import { PHONE_REGEX } from '../../common/constants';

export class UpdateProfileDto {
  @IsOptional()
  @IsString()
  @MinLength(2)
  firstName?: string;

  @IsOptional()
  @IsString()
  @MinLength(2)
  lastName?: string;

  @IsOptional()
  @IsString()
  @Matches(PHONE_REGEX, {
    message: 'Phone must be in +234XXXXXXXXXX format',
  })
  phone?: string;
}
