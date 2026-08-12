import { IsNotEmpty, IsNumber } from 'class-validator';

export class AddCartItem {
  @IsNotEmpty()
  productId!: string;

  @IsNotEmpty()
  @IsNumber()
  quantity!: number;
}
