import { ObjectType, Field, Int } from '@nestjs/graphql';
import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
  Unique,
} from 'typeorm';

@ObjectType()
@Entity()
@Index(['name'])
@Unique(['name'])
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
}
