import slugify from 'slugify';
import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { CreateProductInput } from './dto/create-product.input';
import { UpdateProductInput } from './dto/update-product.input';
import { InjectRepository } from '@nestjs/typeorm';
import { Product } from './entities/product.entity';
import { Repository, MoreThan, In, DataSource } from 'typeorm';
import { CACHE_MANAGER, Cache } from '@nestjs/cache-manager';
import { ManyPartialProducts } from './types';

@Injectable()
export class ProductsService {
  constructor(
    @InjectRepository(Product)
    private readonly productsRepo: Repository<Product>,
    @Inject(CACHE_MANAGER) private readonly cacheManager: Cache,
    private readonly logger: Logger,
    private readonly dataSource: DataSource,
  ) {}

  async create(createProductInput: CreateProductInput) {
    // Make slug for the product for the frontend url
    // Check the name and slug if are they already existed or not

    const { name } = createProductInput;

    const slug = slugify(name, {
      lower: true,
      strict: true,
    });

    const isProductExist = await this.productsRepo.findOne({
      where: [{ name }, { slug }],
    });

    if (isProductExist) {
      throw new ConflictException('Product with same name already exist');
    }

    return this.productsRepo.save(createProductInput);
  }

  async createMany(createProductInputs: CreateProductInput[]) {
    const newProducts = this.productsRepo.create(createProductInputs);

    const uniqueNamesInRequest = new Set<string>();
    const uniqueSlugs = new Set<string>();

    for (const product of newProducts) {
      if (uniqueNamesInRequest.has(product.name)) {
        throw new BadRequestException(
          `Duplicate product ${product.name} in request`,
        );
      }

      uniqueNamesInRequest.add(product.name);

      product.slug = this.generateSlug(product.name);
      uniqueSlugs.add(product.slug);
    }

    const names = [...uniqueNamesInRequest];

    const existingProducts = await this.productsRepo.find({
      where: [{ name: In(names) }, { slug: In([...uniqueSlugs]) }],
    });

    if (!existingProducts || existingProducts.length === 0)
      return this.productsRepo.save(newProducts);

    const existingNames = new Set<string>(existingProducts.map((p) => p.name));
    const existingSlugs = new Set<string>(existingProducts.map((p) => p.slug));
    const filteredUniqueProducts = newProducts.filter(
      ({ name, slug }) => !existingNames.has(name) && !existingSlugs.has(slug),
    );

    if (filteredUniqueProducts.length === 0) {
      throw new BadRequestException(
        'All the input products names or slugs are exists.',
      );
    }

    return this.productsRepo.save(filteredUniqueProducts);
  }

  async findAll() {
    const key = 'prodcuts';
    const cachedProdcuts = await this.cacheManager.get(key);

    if (cachedProdcuts) {
      this.logger.log('Hit all products from cache');

      return cachedProdcuts;
    }

    this.logger.log('Miss all products in the cache');

    const dbProducts = await this.productsRepo.find({
      where: { stock: MoreThan(0) },
    });

    await this.cacheManager.set(key, dbProducts);

    return dbProducts;
  }

  async findOne(id: string) {
    return this.productsRepo.findOne({ where: { id } });
  }

  async update(id: string, updateProductInput: UpdateProductInput) {
    const product = await this.productsRepo.findOneBy({ id });

    if (!product)
      throw new NotFoundException(`This product with id ${id} is unavailable`);

    Object.assign(product, updateProductInput);

    return this.productsRepo.save(product);
  }

  async updateMany(
    manyPartialProducts: ManyPartialProducts,
  ): Promise<{ message: string; data: Product[] }> {
    // Check if there no products sent
    if (!manyPartialProducts || manyPartialProducts.length === 0) {
      return { message: 'No products provided for update', data: [] };
    }

    // Collect the ids in array
    const productIds = manyPartialProducts.map((p) => p.id);

    // Start the transaction process
    return await this.dataSource.transaction(async (manager) => {
      // Fetch all existing products at once using In() helper
      const existingProducts = await manager.find(Product, {
        where: { id: In(productIds) },
        lock: {
          mode: 'pessimistic_write',
        },
      });

      // Throw notfound exception for missed products
      if (existingProducts.length !== manyPartialProducts.length) {
        const foundIds = existingProducts.map((p) => p.id);
        const missingIds = productIds.filter((id) => !foundIds.includes(id));
        throw new NotFoundException(
          `Update failed. Products with IDs [${missingIds.join(', ')}] were not found.`,
        );
      }

      // Loop on the existing products and merge them with the new over writen props and return updated array
      const productsToSave = existingProducts.map((existingProduct) => {
        const partialData = manyPartialProducts.find(
          (p) => p.id === existingProduct.id,
        );

        return manager.merge(Product, existingProduct, partialData!);
      });

      // Save the updated array to db
      const updatedProducts = await manager.save(Product, productsToSave);

      return {
        message: 'The products updated successfully',
        data: updatedProducts,
      };
    });
  }

  remove(id: string) {
    return this.productsRepo.delete(id);
  }

  async resetAll() {
    return this.productsRepo.deleteAll();
  }

  private generateSlug(name: string) {
    return slugify(name, { lower: true, strict: true });
  }
}
