import { Type } from 'class-transformer';
import {
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
} from 'class-validator';
import { ApiPropertyOptional } from '@nestjs/swagger';

/**
 * Query parameters for the admin product list.
 * Own REST bounds (do NOT extend the GraphQL PaginationArgs —
 * wrong transport, no upper bound); aligns with the CC-B shared
 * PaginationQueryDto when it lands.
 */
export class AdminProductListQueryDto {
  @ApiPropertyOptional({
    description: 'Partial case-insensitive product name match',
    maxLength: 100,
  })
  @IsOptional()
  @IsString()
  @MaxLength(100)
  search?: string;

  @ApiPropertyOptional({
    enum: ['in-stock', 'low-stock', 'out-of-stock'],
    description: 'Stock-status filter (applied in SQL before pagination)',
  })
  @IsOptional()
  @IsIn(['in-stock', 'low-stock', 'out-of-stock'])
  status?: 'in-stock' | 'low-stock' | 'out-of-stock';

  @ApiPropertyOptional({ description: 'Minimum price (inclusive)', minimum: 0 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  minPrice?: number;

  @ApiPropertyOptional({ description: 'Maximum price (inclusive)', minimum: 0 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  maxPrice?: number;

  @ApiPropertyOptional({
    description:
      'Low-stock threshold override (default 5, never persisted per product)',
    minimum: 0,
    maximum: 1000,
    default: 5,
  })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  @Max(1000)
  lowThreshold?: number;

  @ApiPropertyOptional({ description: 'Page number (1-indexed)', default: 1 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page?: number;

  @ApiPropertyOptional({
    description: 'Items per page (cap 100)',
    default: 20,
  })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  limit?: number;
}
