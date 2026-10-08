import { Type } from 'class-transformer';
import {
  IsInt,
  IsOptional,
  IsString,
  MaxLength,
  Min,
  MinLength,
} from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

/**
 * Body for admin product creation. Maps field-by-field onto
 * CreateProductInput in the controller (never passed straight through:
 * slug is server-derived). Unknown fields are rejected by the global
 * ValidationPipe (forbidNonWhitelisted).
 */
export class AdminCreateProductDto {
  @ApiProperty({ description: 'Product name (unique)', maxLength: 100 })
  @IsString()
  @MinLength(1)
  @MaxLength(100)
  name!: string;

  @ApiProperty({ description: 'Product description', maxLength: 250 })
  @IsString()
  @MinLength(1)
  @MaxLength(250)
  description!: string;

  @ApiProperty({ description: 'Price (integer, never negative)', minimum: 0 })
  @Type(() => Number)
  @IsInt()
  @Min(0)
  price!: number;

  @ApiPropertyOptional({
    description: 'Initial stock (omitted defaults to zero → out-of-stock)',
    minimum: 0,
  })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  stock?: number;
}
