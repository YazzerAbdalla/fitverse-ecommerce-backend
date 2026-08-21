import { Product } from 'src/modules/products/entities/product.entity';
import {
  Column,
  Entity,
  ManyToOne,
  PrimaryGeneratedColumn,
  Unique,
} from 'typeorm';
import { Cart } from './cart.entity';

@Entity()
@Unique(['id'])
export class CartItem {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @ManyToOne(() => Cart, (cart) => cart.cart_items)
  cart!: Cart;

  @ManyToOne(() => Product, (product) => product.cart_items, { eager: true })
  product!: Product;

  @Column()
  quantity!: number;
}
