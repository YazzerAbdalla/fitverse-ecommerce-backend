import { Cart } from 'src/modules/cart/entities/cart.entity';
import { Order } from 'src/modules/order/entities/order.entity';
import {
  Column,
  Entity,
  Index,
  OneToMany,
  OneToOne,
  PrimaryGeneratedColumn,
} from 'typeorm';
import { UserRoles } from '../enum/roles';

@Entity()
@Index(['email'])
export default class User {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column()
  firstName!: string;

  @Column()
  lastName!: string;

  @Column()
  email!: string;

  @Column({ type: 'enum', enum: UserRoles, default: UserRoles.User })
  roles!: UserRoles;

  @Column()
  password!: string;

  @OneToMany(() => Order, (order) => order.user)
  orders!: Order[];

  @OneToOne(() => Cart, (cart) => cart.user)
  cart!: Cart;
}
