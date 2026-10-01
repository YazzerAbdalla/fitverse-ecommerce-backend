import { ApiProperty } from '@nestjs/swagger';
import { IsEmail } from 'class-validator';

/**
 * This DTO validates resend-verification requests.
 * It handles anti-enumeration input (same 200 shape whether or not the email exists).
 */
export class ResendVerificationDto {
  @ApiProperty({ example: 'yasser@gmail.com' })
  @IsEmail()
  email!: string;
}
