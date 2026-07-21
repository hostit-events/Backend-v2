import { IsEmail, IsOptional, IsString, MinLength } from 'class-validator';

/**
 * Query for `GET /organizer/users/lookup`, used by the mobile Check-in
 * team screen to resolve a teammate before granting ticket-admin.
 *
 * Provide exactly one of:
 *  - `email` — exact, case-insensitive match → a single user (or 404).
 *  - `q` — prefix/substring across email + name → up to 10 users, for
 *    type-ahead. Min length guards against broad enumeration.
 */
export class LookupUserDto {
  @IsOptional()
  @IsEmail()
  email?: string;

  @IsOptional()
  @IsString()
  @MinLength(2)
  q?: string;
}
