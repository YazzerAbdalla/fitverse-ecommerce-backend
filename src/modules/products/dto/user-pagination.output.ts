import { ObjectType, Field, Int } from '@nestjs/graphql';
import User from 'src/modules/users/entity/user.entity';
import { Product } from '../entities/product.entity';

@ObjectType()
export class PaginationMeta {
  @Field(() => Int)
  totalItems!: number;

  @Field(() => Int)
  itemCount!: number;

  @Field(() => Int)
  itemsPerPage!: number;

  @Field(() => Int)
  totalPages!: number;

  @Field(() => Int)
  currentPage!: number;
}

@ObjectType()
export class ProductPagination {
  @Field(() => [Product])
  data!: Product[];

  @Field(() => PaginationMeta)
  meta!: PaginationMeta;
}
