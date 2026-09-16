import { ApiProperty } from '@nestjs/swagger';
import { IsEmail, IsString } from 'class-validator';

export class ValidateResetTokenDto {
  @IsEmail()
  @ApiProperty({ example: 'alice@example.com' })
  email!: string;

  @IsString()
  @ApiProperty({ example: 'a3f...64hex' })
  token!: string;
}
