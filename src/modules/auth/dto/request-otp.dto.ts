import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsEnum, IsOptional, Matches } from 'class-validator';
import { OtpPurpose } from '../entities/otp-verification.entity';

/**
 * WhatsApp OTP request (deferred: controller returns 501 until provider setup).
 * Phone is optional only for authenticated callers (falls back to their own).
 */
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
