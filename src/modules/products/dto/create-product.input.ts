import { InputType, Int, Field } from '@nestjs/graphql';
import { IsNotEmpty, IsNumber, MaxLength } from 'class-validator';

@InputType()
export class CreateProductInput {
  @Field()
  @IsNotEmpty()
  @MaxLength(100)
  name!: string;

  @Field()
  @IsNotEmpty()
  @MaxLength(250)
  description!: string;

  @Field(() => Int)
  @IsNotEmpty()
  @IsNumber()
  stock!: number;

  @Field(() => Int)
  @IsNotEmpty()
  @IsNotEmpty()
  price!: number;
}
