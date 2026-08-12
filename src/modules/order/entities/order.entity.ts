import {
  Column,
  CreateDateColumn,
  Entity,
  JoinTable,
  ManyToMany,
  ManyToOne,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';
import { OrderStatus } from '../order.enum';
import User from 'src/modules/users/entity/user.entity';
import { OrderItem } from './order-items.entity';

@Entity()
export class Order {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ type: 'enum', enum: OrderStatus, default: OrderStatus.PENDING })
  status!: OrderStatus;

  @Column({ type: 'bigint' })
  total_price!: number;

  @CreateDateColumn()
  created_at!: Date;
  @UpdateDateColumn()
  updated_at!: Date;

  @ManyToOne(() => User, (user) => user.orders)
  user!: User;

  @ManyToMany(() => OrderItem)
  @JoinTable()
  order_items!: OrderItem[];
}
