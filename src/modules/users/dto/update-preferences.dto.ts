import { ApiProperty } from '@nestjs/swagger';
import { IsBoolean, IsOptional } from 'class-validator';

/**
 * This DTO validates user notification preference updates.
 * It handles either-or updates (either flag may be omitted, at least one applies).
 */
export class UpdatePreferencesDto {
  @ApiProperty({ required: false, example: true })
  @IsOptional()
  @IsBoolean()
  marketingOptIn?: boolean;

  @ApiProperty({ required: false, example: true })
  @IsOptional()
  @IsBoolean()
  emailOptIn?: boolean;
}
