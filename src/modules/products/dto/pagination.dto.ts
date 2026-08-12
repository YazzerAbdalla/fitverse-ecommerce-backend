import { ArgsType, Field, Int } from '@nestjs/graphql';
import { Min, IsOptional } from 'class-validator';

@ArgsType()
export class PaginationArgs {
  @Field(() => Int, { defaultValue: 1, nullable: true })
  @Min(1)
  @IsOptional()
  page?: number = 1;

  @Field(() => Int, { defaultValue: 10, nullable: true })
  @Min(1)
  @IsOptional()
  limit?: number = 10;
}
