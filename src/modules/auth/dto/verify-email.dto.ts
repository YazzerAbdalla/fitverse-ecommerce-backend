import { ApiProperty } from '@nestjs/swagger';
import { IsEmail, IsString, Length, Matches } from 'class-validator';

/**
 * This DTO validates email verification by link or body.
 * It handles both GET query (?token&email) and POST body reuse with the same rules.
 */
export class VerifyEmailDto {
  @ApiProperty({ example: 'yasser@gmail.com' })
  @IsEmail()
  email!: string;

  @ApiProperty({
    example: 'a'.repeat(64),
    description: 'Raw 64-hex verification token from the email link',
  })
  @IsString()
  @Length(64, 64)
  @Matches(/^[0-9a-f]{64}$/)
  token!: string;
}
