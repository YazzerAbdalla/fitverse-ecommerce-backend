import { Product } from 'src/modules/products/entities/product.entity';
import {
  Check,
  Column,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
  Unique,
} from 'typeorm';
import { Order } from './order.entity';

/**
 * This entity represents an OrderItem with historical price snapshot.
 * It handles quantity and unit_price immutability.
 */
@Entity()
@Unique(['orderId', 'productId'])
@Check(`"quantity" > 0`)
@Check(`"unit_price" >= 0`)
@Index(['orderId'])
@Index(['productId'])
export class OrderItem {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ type: 'uuid' })
  orderId!: string;

  @Column({ type: 'uuid' })
  productId!: string;

  @ManyToOne(() => Order, (order) => order.orderItems, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'orderId' })
  order!: Order;

  @ManyToOne(() => Product, (product) => product.order_items, {
    onDelete: 'RESTRICT',
  })
  @JoinColumn({ name: 'productId' })
  product!: Product;

  /** Legacy alias for backwards compatibility */
  get product_id(): Product {
    return this.product;
  }
  set product_id(v: Product) {
    this.product = v;
  }

  get order_id(): Order {
    return this.order;
  }
  set order_id(v: Order) {
    this.order = v;
  }

  @Column({ type: 'int' })
  quantity!: number;

  @Column({ type: 'int', name: 'unit_price' })
  unit_price!: number;

  /** Alias for unit_price - exposed as unitPrice in API */
  get unitPrice(): number {
    return this.unit_price;
  }
  set unitPrice(v: number) {
    this.unit_price = v;
  }

  @Column({ type: 'varchar', nullable: true })
  productNameSnapshot!: string | null;

  @Column({
    type: 'int',
    asExpression: 'quantity * unit_price',
    generatedType: 'STORED',
    nullable: true,
  })
  subtotal!: number;
}
