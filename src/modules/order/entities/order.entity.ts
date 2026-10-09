import {
  Check,
  Column,
  CreateDateColumn,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  OneToMany,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';
import { OrderStatus } from '../order-status.enum';
import User from 'src/modules/users/entity/user.entity';
import { OrderItem } from './order-items.entity';

/**
 * This entity represents an Order.
 * It handles the persisted order with total and status.
 * Total is non-negative by DB backstop; owner and revenue-window reads are
 * index-backed (`userId + created_at`, `status + created_at`).
 */
@Entity()
@Check(`"total" >= 0`)
@Index(['userId'])
@Index(['status'])
@Index('IDX_order_status_createdAt', ['status', 'created_at'])
@Index('IDX_order_userId_createdAt', ['userId', 'created_at'])
export class Order {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ type: 'uuid' })
  userId!: string;

  @Column({ type: 'enum', enum: OrderStatus, default: OrderStatus.PENDING })
  status!: OrderStatus;

  @Column({ type: 'int', default: 0 })
  total!: number;

  @CreateDateColumn()
  created_at!: Date;

  @UpdateDateColumn()
  updated_at!: Date;

  @ManyToOne(() => User, (user) => user.orders, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'userId' })
  user!: User;

  @OneToMany(() => OrderItem, (item) => item.order, { cascade: true })
  orderItems!: OrderItem[];

  /** @deprecated legacy ManyToMany - removed, use orderItems */
  order_items?: OrderItem[];
}
