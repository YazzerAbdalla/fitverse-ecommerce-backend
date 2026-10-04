import { ApiProperty } from '@nestjs/swagger';
import { IsEmail, IsString, Length, Matches } from 'class-validator';

/**
 * Advisory reset-token pre-check (UX only; resetPassword revalidates as authority per S-2).
 * Same 64-hex token floor as ResetPasswordDto so both endpoints agree on shape.
 */
export class ValidateResetTokenDto {
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
}
