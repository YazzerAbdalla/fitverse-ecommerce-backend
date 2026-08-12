import { Column, Entity, ManyToOne, PrimaryGeneratedColumn } from 'typeorm';
import { Cart } from './cart.entity';
import { Product } from 'src/modules/products/entities/product.entity';

@Entity()
export class CartItem {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @ManyToOne(() => Cart, (cart) => cart.cart_items)
  cart!: Cart;

  @ManyToOne(() => Product, (product) => product.cart_items)
  product!: Product;

  @Column()
  quantity!: number;
}
