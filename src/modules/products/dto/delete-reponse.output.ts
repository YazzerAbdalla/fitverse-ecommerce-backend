import { Field, Int, ObjectType } from '@nestjs/graphql';

@ObjectType()
export class DeleteResponse {
  @Field(() => Int)
  affected!: number;
}
