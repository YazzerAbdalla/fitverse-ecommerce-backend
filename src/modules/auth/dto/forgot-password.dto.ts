import { ApiProperty } from '@nestjs/swagger';
import { IsEmail } from 'class-validator';

/**
 * Password-reset request (anti-enumeration: always 200, even for unknown emails).
 */
export class ForgotPasswordDto {
  @IsEmail()
  @ApiProperty({ example: 'alice@example.com' })
  email!: string;
}
