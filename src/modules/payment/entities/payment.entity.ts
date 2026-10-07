import {
  Check,
  Column,
  CreateDateColumn,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
  Unique,
  UpdateDateColumn,
} from 'typeorm';
import { Order } from '../../order/entities/order.entity';
import User from '../../users/entity/user.entity';
import { PaymentStatus } from './payment-status.enum';

/**
 * This entity represents a simulated payment attempt for exactly one order.
 * It stores the server-copied amount and the simulation outcome; no real provider is involved.
 */
@Entity()
@Check(`"amount" >= 0`)
@Unique(['orderId'])
@Index(['userId', 'status'])
@Index(['status', 'createdAt'])
export class Payment {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ type: 'uuid' })
  orderId!: string;

  @Column({ type: 'uuid' })
  userId!: string;

  @Column({ type: 'int', default: 0 })
  amount!: number;

  @Column({ type: 'varchar', length: 3, default: 'usd' })
  currency!: string;

  @Column({ type: 'enum', enum: PaymentStatus, default: PaymentStatus.PENDING })
  @Index()
  status!: PaymentStatus;

  @Column({ type: 'varchar', default: 'simulation' })
  provider!: string;

  @Column({ type: 'varchar', nullable: true })
  failureReason!: string | null;

  @CreateDateColumn()
  createdAt!: Date;

  @UpdateDateColumn()
  updatedAt!: Date;

  @ManyToOne(() => Order, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'orderId' })
  order!: Order;

  @ManyToOne(() => User, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'userId' })
  user!: User;
}
