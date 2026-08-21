import { IsInt, Min } from 'class-validator';
import { Type } from 'class-transformer';

export class IncreaseStockDto {
  @Type(() => Number)
  @IsInt()
  @Min(1)
  quantity!: number;
}
