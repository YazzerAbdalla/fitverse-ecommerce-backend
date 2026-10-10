import { ObjectType, Field, Int } from '@nestjs/graphql';
import { CartItem } from 'src/modules/cart/entities/cart-items.entity';
import { OrderItem } from 'src/modules/order/entities/order-items.entity';
import {
  Check,
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
  Unique,
  OneToMany,
  OneToOne,
} from 'typeorm';
import { Inventory } from 'src/modules/inventory/entities/inventory.entity';

/**
 * This entity represents a catalog product.
 * It owns catalog columns only (name, slug, description, price); stock state
 * lives in Inventory. Price is non-negative by DB backstop.
 */
@ObjectType()
@Entity()
@Index(['name'])
@Unique(['name'])
@Check('CHK_product_price_non_negative', '"price" >= 0')
export class Product {
  @Field()
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Field()
  @Column()
  name!: string;

  @Field()
  @Column({ nullable: true })
  slug!: string;

  @Field()
  @Column()
  description!: string;

  @Field(() => Int)
  @Column()
  price!: number;

  @Field(() => Date)
  @CreateDateColumn()
  created_at!: Date;

  @OneToMany(() => OrderItem, (orderItem) => orderItem.product)
  order_items!: OrderItem[];

  @OneToMany(() => CartItem, (cartItem) => cartItem.product)
  cart_items!: CartItem[];

  @OneToOne(() => Inventory, (inventory) => inventory.product)
  inventory!: Inventory;
}
