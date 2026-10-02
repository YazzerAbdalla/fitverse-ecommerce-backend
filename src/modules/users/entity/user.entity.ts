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
import { RefreshToken } from 'src/modules/auth/entities/refresh-token.entity';

export enum AuthProvider {
  Local = 'local',
  Google = 'google',
}

/**
 * This entity represents an application user.
 * It handles identity, credentials, verification flags and notification preferences.
 */
@Entity()
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

  @Column({ type: 'varchar', nullable: true })
  password!: string | null;

  @Column({ type: 'varchar', nullable: true })
  @Index('IDX_user_phoneNumber')
  phoneNumber!: string | null;

  @Column({ default: false })
  phoneVerified!: boolean;

  @Column({ type: 'varchar', nullable: true })
  @Index('IDX_user_googleId')
  googleId!: string | null;

  @Column({ type: 'enum', enum: AuthProvider, default: AuthProvider.Local })
  provider!: AuthProvider;

  @Column({ default: 0 })
  tokenVersion!: number;

  @Column({ type: 'timestamptz', nullable: true })
  passwordChangedAt!: Date | null;

  @Column({ default: false })
  emailVerified!: boolean;

  @Column({ default: false })
  marketingOptIn!: boolean;

  @Column({ default: true })
  emailOptIn!: boolean;

  @OneToMany(() => Order, (order) => order.user)
  orders!: Order[];

  @OneToOne(() => Cart, (cart) => cart.user)
  cart!: Cart;

  @OneToMany(() => RefreshToken, (rt) => rt.user)
  refreshTokens!: RefreshToken[];
}
