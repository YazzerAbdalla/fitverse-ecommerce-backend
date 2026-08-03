// login.dto.ts
import { IsEmail, IsString } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';

export class LoginDto {
  @ApiProperty({
    example: 'yasser@gmail.com',
  })
  @IsEmail()
  email!: string;

  @ApiProperty({
    example: 'Yasser@123',
  })
  @IsString()
  password!: string;
}
