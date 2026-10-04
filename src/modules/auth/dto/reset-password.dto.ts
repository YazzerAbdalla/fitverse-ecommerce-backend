import { ApiProperty } from '@nestjs/swagger';
import {
  IsEmail,
  IsString,
  Length,
  Matches,
  MaxLength,
  MinLength,
} from 'class-validator';

/**
 * Single-use password reset (token consumed under FOR UPDATE; 8-72 chars).
 * The token floor matches VerifyEmailDto: 64-hex only, so garbage 400s at
 * validation instead of reaching the service lookup.
 */
export class ResetPasswordDto {
  @IsEmail()
  @ApiProperty({ example: 'alice@example.com' })
  email!: string;

  @IsString()
  @Length(64, 64)
  @Matches(/^[0-9a-f]{64}$/)
  @ApiProperty({
    example: 'a'.repeat(64),
    description: 'Raw 64-hex reset token from the email link',
  })
  token!: string;

  @IsString()
  @MinLength(8)
  @MaxLength(72)
  @ApiProperty({ example: 'NewStrong123!' })
  newPassword!: string;
}
