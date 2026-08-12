import { ObjectType, Field, Int } from '@nestjs/graphql';
import { CartItem } from 'src/modules/cart/entities/cart-items.entity';
import { OrderItem } from 'src/modules/order/entities/order-items.entity';
import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
  Unique,
  Check,
  OneToMany,
} from 'typeorm';

@ObjectType()
@Entity()
@Index(['name'])
@Unique(['name'])
@Check(`"stock" >= 0`)
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
  stock!: number;

  @Field(() => Int)
  @Column()
  price!: number;

  @Field(() => Date)
  @CreateDateColumn()
  created_at!: Date;

  @OneToMany(() => OrderItem, (orderItem) => orderItem.product_id)
  order_items!: OrderItem[];

  @OneToMany(() => CartItem, (cartItem) => cartItem.product)
  cart_items!: CartItem[];
}
