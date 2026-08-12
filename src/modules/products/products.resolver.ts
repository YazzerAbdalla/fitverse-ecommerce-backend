import { Args, Mutation, Query, Resolver } from '@nestjs/graphql';
import { CreateProductInput } from './dto/create-product.input';
import { DeleteResponse } from './dto/delete-reponse.output';
import { PaginationArgs } from './dto/pagination.dto';
import { UpdateProductInput } from './dto/update-product.input';
import { ProductPagination } from './dto/user-pagination.output';
import { Product } from './entities/product.entity';
import { ProductsService } from './products.service';

@Resolver(() => Product)
export class ProductsResolver {
  constructor(private readonly productsService: ProductsService) {}

  @Mutation(() => Product)
  createProduct(
    @Args('createProductInput') createProductInput: CreateProductInput,
  ) {
    return this.productsService.create(createProductInput);
  }

  @Mutation(() => [Product])
  createManyProducts(
    @Args('createProductInputs', { type: () => [CreateProductInput] })
    createProductInputs: CreateProductInput[],
  ) {
    return this.productsService.createMany(createProductInputs);
  }

  @Query(() => ProductPagination, { name: 'products' })
  findAll(@Args() PaginationArgs: PaginationArgs) {
    return this.productsService.findAll(PaginationArgs);
  }

  @Query(() => Product, { name: 'product' })
  findOne(@Args('id') id: string) {
    return this.productsService.findOne(id);
  }

  @Mutation(() => Product)
  updateProduct(
    @Args('id') id: string,
    @Args('updateProductInput') updateProductInput: UpdateProductInput,
  ) {
    return this.productsService.update(id, updateProductInput);
  }

  @Mutation(() => Product)
  removeProduct(@Args('id') id: string) {
    return this.productsService.remove(id);
  }

  @Mutation(() => DeleteResponse)
  async removeAllProducts() {
    const result = await this.productsService.resetAll();

    return {
      affected: result.affected ?? 0,
    };
  }
}
