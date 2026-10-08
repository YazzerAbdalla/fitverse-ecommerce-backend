import { Type } from 'class-transformer';
import { IsInt, NotEquals } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';

/**
 * Signed stock adjustment. Delta-only by design (Q2/C): positive
 * restocks, negative draws down. Zero and non-integers are rejected
 * before the service; absolute-set mode intentionally absent.
 */
export class AdjustStockDto {
  @ApiProperty({
    description: 'Signed stock adjustment (positive adds, negative subtracts)',
    example: 10,
  })
  @Type(() => Number)
  @IsInt()
  @NotEquals(0)
  delta!: number;
}
