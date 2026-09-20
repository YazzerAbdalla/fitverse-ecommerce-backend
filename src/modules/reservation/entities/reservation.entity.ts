import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  ManyToOne,
  OneToMany,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';
import User from '../../users/entity/user.entity';
import { Order } from '../../order/entities/order.entity';
import { ReservationItem } from './reservation-item.entity';
import { ReservationStatus } from './reservation-status.enum';

@Entity()
@Index(['userId'])
@Index(['status'])
@Index(['expiresAt'])
@Index(['status', 'expiresAt'])
export class Reservation {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ type: 'uuid' })
  userId!: string;

  @Column({ type: 'uuid', nullable: true })
  @Index()
  orderId!: string | null;

  @Column({
    type: 'enum',
    enum: ReservationStatus,
    default: ReservationStatus.RESERVED,
  })
  status!: ReservationStatus;

  @Column({ type: 'timestamptz' })
  expiresAt!: Date;

  @CreateDateColumn()
  createdAt!: Date;

  @UpdateDateColumn()
  updatedAt!: Date;

  @ManyToOne(() => User, { onDelete: 'CASCADE' })
  user!: User;

  @ManyToOne(() => Order, { nullable: true, onDelete: 'SET NULL' })
  order!: Order | null;

  @OneToMany(() => ReservationItem, (item) => item.reservation, {
    cascade: true,
  })
  items!: ReservationItem[];
}
