import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsEnum, IsOptional, Matches } from 'class-validator';
import { OtpPurpose } from '../entities/otp-verification.entity';

export class RequestOtpDto {
  @Matches(/^\+[1-9]\d{1,14}$/)
  @ApiProperty({ example: '+201012345678' })
  @IsOptional()
  phoneNumber?: string;

  @IsOptional()
  @IsEnum(OtpPurpose)
  @ApiPropertyOptional({ enum: OtpPurpose, default: OtpPurpose.Login })
  purpose?: OtpPurpose;
}
