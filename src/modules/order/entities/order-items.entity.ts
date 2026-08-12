import { Product } from 'src/modules/products/entities/product.entity';
import {
  Column,
  Entity,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
} from 'typeorm';
import { Order } from './order.entity';

@Entity()
export class OrderItem {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @ManyToOne(() => Order, (order) => order.order_items)
  order_id!: Order;

  @ManyToOne(() => Product, (product) => product.order_items)
  @JoinColumn()
  product_id!: Product;

  @Column('decimal')
  quantity!: number;

  @Column('decimal')
  unit_price!: number;

  @Column({
    type: 'decimal',
    asExpression: 'quantity * unit_price',
    generatedType: 'STORED',
  })
  subtotal!: number;
}
