import { ApiProperty } from '@nestjs/swagger';
import {
  IsBoolean,
  IsEmail,
  IsNotEmpty,
  IsOptional,
  MaxLength,
  MinLength,
} from 'class-validator';

/**
 * This DTO validates user registration input.
 * It handles optional notification opt-in flags stored directly on User.
 */
export class UserRegisterDto {
  @IsNotEmpty()
  @MaxLength(30)
  @ApiProperty({ example: 'Yasser' })
  firstName!: string;

  @IsNotEmpty()
  @MaxLength(30)
  @ApiProperty({ example: 'Abdalla' })
  lastName!: string;

  @IsEmail()
  @ApiProperty({ example: 'yasser@gmail.com' })
  email!: string;

  @IsNotEmpty()
  @MinLength(8)
  @ApiProperty({ example: 'Yasser@123' })
  password!: string;

  @IsOptional()
  @IsBoolean()
  @ApiProperty({ example: false, required: false, default: false })
  marketingOptIn?: boolean;

  @IsOptional()
  @IsBoolean()
  @ApiProperty({ example: true, required: false, default: true })
  emailOptIn?: boolean;
}
