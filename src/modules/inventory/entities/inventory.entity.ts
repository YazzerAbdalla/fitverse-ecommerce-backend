import {
  Check,
  Column,
  CreateDateColumn,
  Entity,
  Index,
  JoinColumn,
  OneToOne,
  PrimaryGeneratedColumn,
  Unique,
  UpdateDateColumn,
} from 'typeorm';
import { Product } from '../../products/entities/product.entity';

/**
 * This entity represents inventory stock for a product.
 * It enforces DB checks stock>=0, reservedAmount>=0, reservedAmount<=stock and derives available = stock - reservedAmount.
 * Only InventoryService may mutate stock/reservedAmount inside FOR UPDATE transactions.
 */
@Entity()
@Unique(['productId'])
@Index(['productId'])
@Check(`"stock" >= 0`)
@Check(`"reservedAmount" >= 0`)
@Check(`"reservedAmount" <= "stock"`)
export class Inventory {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ type: 'uuid' })
  productId!: string;

  @OneToOne(() => Product, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'productId' })
  product!: Product;

  @Column({ type: 'int', default: 0 })
  stock!: number;

  @Column({ type: 'int', default: 0 })
  reservedAmount!: number;

  @CreateDateColumn()
  createdAt!: Date;

  @UpdateDateColumn()
  updatedAt!: Date;

  get available(): number {
    return this.stock - this.reservedAmount;
  }
}
