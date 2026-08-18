import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsInt, IsNotEmpty, IsOptional, IsUUID, Min } from 'class-validator';

export class UpdateCartItemQuantityDto {
  @ApiProperty({
    description: 'The id of the product whose quantity should be updated.',
    example: '5c56d218-1fbe-4e27-b432-28c8b5e5efbc',
  })
  @IsUUID()
  @IsNotEmpty()
  productId!: string;

  @ApiPropertyOptional({
    description: 'The amount to increase or decrease the quantity by.',
    example: 1,
    default: 1,
    minimum: 1,
  })
  @IsInt()
  @Min(1)
  @IsOptional()
  quantity?: number;
}
