import { ApiProperty } from '@nestjs/swagger';
import { IsEmail, IsString, MaxLength, MinLength } from 'class-validator';

/**
 * Single-use password reset (token consumed under FOR UPDATE; 8-72 chars).
 */
export class ResetPasswordDto {
  @IsEmail()
  @ApiProperty({ example: 'alice@example.com' })
  email!: string;

  @IsString()
  @ApiProperty({ example: 'a3f...64hex' })
  token!: string;

  @IsString()
  @MinLength(8)
  @MaxLength(72)
  @ApiProperty({ example: 'NewStrong123!' })
  newPassword!: string;
}
