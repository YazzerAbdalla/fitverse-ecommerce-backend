import { ApiProperty } from '@nestjs/swagger';
import { IsInt, IsNotEmpty, IsUUID, Min } from 'class-validator';

export class AddCartItemDto {
  @ApiProperty({
    description: 'The id of the product to add to the cart.',
    example: '5c56d218-1fbe-4e27-b432-28c8b5e5efbc',
  })
  @IsUUID()
  @IsNotEmpty()
  productId!: string;

  @ApiProperty({
    description: 'The quantity of the product to add.',
    example: 2,
    default: 1,
    minimum: 1,
  })
  @IsInt()
  @Min(1)
  @IsNotEmpty()
  quantity!: number;
}
