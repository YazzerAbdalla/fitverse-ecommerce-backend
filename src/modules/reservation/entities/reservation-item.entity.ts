import {
  Check,
  Column,
  CreateDateColumn,
  Entity,
  Index,
  ManyToOne,
  PrimaryGeneratedColumn,
  Unique,
  UpdateDateColumn,
} from 'typeorm';
import { Reservation } from './reservation.entity';
import { Inventory } from '../../inventory/entities/inventory.entity';

@Entity()
@Unique(['reservationId', 'inventoryId'])
@Check('"quantity" > 0')
export class ReservationItem {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ type: 'uuid' })
  @Index()
  reservationId!: string;

  @Column({ type: 'uuid' })
  @Index()
  inventoryId!: string;

  @Column({ type: 'int' })
  quantity!: number;

  @CreateDateColumn()
  createdAt!: Date;

  @UpdateDateColumn()
  updatedAt!: Date;

  @ManyToOne(() => Reservation, (r) => r.items, { onDelete: 'CASCADE' })
  reservation!: Reservation;

  @ManyToOne(() => Inventory, { onDelete: 'CASCADE' })
  inventory!: Inventory;
}
