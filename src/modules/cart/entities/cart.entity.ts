import User from 'src/modules/users/entity/user.entity';
import {
  Entity,
  JoinColumn,
  OneToMany,
  OneToOne,
  PrimaryGeneratedColumn,
} from 'typeorm';
import { CartItem } from './cart-items.entity';

@Entity()
export class Cart {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @OneToOne(() => User, (user) => user.cart)
  @JoinColumn()
  user!: User;

  @OneToMany(() => CartItem, (cartItem) => cartItem.cart)
  cart_items!: CartItem[];
}
