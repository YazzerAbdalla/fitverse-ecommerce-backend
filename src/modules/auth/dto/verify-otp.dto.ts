import { ApiProperty } from '@nestjs/swagger';
import { IsEnum, IsOptional, Length, Matches } from 'class-validator';
import { OtpPurpose } from '../entities/otp-verification.entity';

export class VerifyOtpDto {
  @Matches(/^\+[1-9]\d{1,14}$/)
  @ApiProperty({ example: '+201012345678' })
  phoneNumber!: string;

  @Length(6, 6)
  @ApiProperty({ example: '123456' })
  otp!: string;

  @IsOptional()
  @IsEnum(OtpPurpose)
  @ApiProperty({ enum: OtpPurpose, default: OtpPurpose.Login })
  purpose?: OtpPurpose;
}
