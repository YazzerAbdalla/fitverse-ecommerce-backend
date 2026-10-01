import { ApiProperty } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  IsBoolean,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  Max,
  Min,
} from 'class-validator';

/**
 * This DTO validates notification history listing query params.
 * It handles owner pagination plus optional isRead/channel/type filters (Admin may scope another userId).
 */
export class NotificationHistoryQueryDto {
  @ApiProperty({ required: false, default: 1 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page?: number = 1;

  @ApiProperty({ required: false, default: 20 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  limit?: number = 20;

  @ApiProperty({ required: false })
  @IsOptional()
  @Type(() => Boolean)
  @IsBoolean()
  isRead?: boolean;

  @ApiProperty({
    required: false,
    enum: ['SYSTEM', 'EMAIL', 'system', 'email'],
  })
  @IsOptional()
  @IsString()
  @IsIn(['SYSTEM', 'EMAIL', 'system', 'email'])
  channel?: string;

  @ApiProperty({ required: false })
  @IsOptional()
  @IsString()
  type?: string;

  @ApiProperty({
    required: false,
    description: 'Admin-only scope for another user',
  })
  @IsOptional()
  @IsUUID()
  userId?: string;
}
