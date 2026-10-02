import { ApiProperty } from '@nestjs/swagger';
import { IsEmail, IsOptional, IsString, MaxLength } from 'class-validator';

/**
 * This DTO carries an admin test-email request.
 * It handles recipient + optional subject/body so SMTP config can be verified without a business flow.
 */
export class TestEmailDto {
  /** Recipient address (the inbox to check for delivery). */
  @ApiProperty({ example: 'you@example.com' })
  @IsEmail()
  to!: string;

  /** Optional subject line (defaults to a config-probe subject). */
  @ApiProperty({ required: false, example: 'Mini E-Commerce SMTP test' })
  @IsOptional()
  @IsString()
  @MaxLength(200)
  subject?: string;

  /** Optional plain-text body. */
  @ApiProperty({ required: false })
  @IsOptional()
  @IsString()
  @MaxLength(2000)
  body?: string;
}
