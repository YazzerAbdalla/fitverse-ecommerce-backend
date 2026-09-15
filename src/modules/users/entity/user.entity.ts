import { Cart } from 'src/modules/cart/entities/cart.entity';
import { Order } from 'src/modules/order/entities/order.entity';
import {
  Check,
  Column,
  Entity,
  Index,
  OneToMany,
  OneToOne,
  PrimaryGeneratedColumn,
  Unique,
} from 'typeorm';
import { UserRoles } from '../enum/roles';

export enum AuthProvider {
  Local = 'local',
  Google = 'google',
}

@Entity()
@Index(['email'])
@Unique(['email'])
@Check(`"provider" IN ('local','google')`)
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
  role!: UserRoles;

  @Column({ nullable: true })
  password!: string | null;

  @Column({ nullable: true })
  @Index()
  phoneNumber!: string | null;

  @Column({ default: false })
  phoneVerified!: boolean;

  @Column({ nullable: true })
  @Index()
  googleId!: string | null;

  @Column({ type: 'enum', enum: AuthProvider, default: AuthProvider.Local })
  provider!: AuthProvider;

  @Column({ default: 0 })
  tokenVersion!: number;

  @Column({ type: 'timestamptz', nullable: true })
  passwordChangedAt!: Date | null;

  @Column({ default: false })
  emailVerified!: boolean;

  @OneToMany(() => Order, (order) => order.user)
  orders!: Order[];

  @OneToOne(() => Cart, (cart) => cart.user)
  cart!: Cart;
}
