import { ApiProperty } from '@nestjs/swagger';
import { IsEmail, IsNotEmpty, MaxLength, MinLength } from 'class-validator';

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
  @MinLength(4)
  @ApiProperty({ example: 'Yasser@123' })
  password!: string;
}
