import slugify from 'slugify';
import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
  forwardRef,
} from '@nestjs/common';
import { CreateProductInput } from './dto/create-product.input';
import { UpdateProductInput } from './dto/update-product.input';
import { InjectRepository } from '@nestjs/typeorm';
import { Product } from './entities/product.entity';
import { Repository, In, DataSource } from 'typeorm';
import { CACHE_MANAGER, Cache } from '@nestjs/cache-manager';
import { ManyPartialProducts } from './types';
import { PaginationArgs } from './dto/pagination.dto';
import { InventoryService } from '../inventory/inventory.service';

@Injectable()
export class ProductsService {
  constructor(
    @InjectRepository(Product)
    private readonly productsRepo: Repository<Product>,
    @Inject(CACHE_MANAGER) private readonly cacheManager: Cache,
    private readonly logger: Logger,
    private readonly dataSource: DataSource,
    @Inject(forwardRef(() => InventoryService))
    private readonly inventoryService: InventoryService,
  ) {}

  async create(createProductInput: CreateProductInput) {
    // Make slug for the product for the frontend url
    // Check the name and slug if are they already existed or not

    const { name, stock, ...rest } =
      createProductInput as CreateProductInput & {
        stock?: number;
      };

    const slug = slugify(name, {
      lower: true,
      strict: true,
    });

    const isProductExist = await this.productsRepo.findOne({
      where: [{ name }, { slug }],
    });

    if (isProductExist) {
      throw new ConflictException(
        'Product with same name or slug already exist',
      );
    }

    const productToSave = this.productsRepo.create({
      ...rest,
      name,
      slug,
    } as Partial<Product>);

    const savedProduct = await this.productsRepo.save(productToSave);

    const initialStock =
      typeof stock === 'number' && Number.isFinite(stock) ? stock : 0;

    await this.inventoryService.createForProduct(savedProduct.id, initialStock);

    return savedProduct;
  }

  async createMany(createProductInputs: CreateProductInput[]) {
    // Extract stock from inputs; product entity no longer stores it
    const inputsWithStock = createProductInputs.map((input) => {
      const { stock, ...rest } = input as CreateProductInput & {
        stock?: number;
      };
      return { rest, stock };
    });

    const productEntities = inputsWithStock.map(({ rest }) =>
      this.productsRepo.create(rest as Partial<Product>),
    );

    const uniqueNamesInRequest = new Set<string>();
    const uniqueSlugs = new Set<string>();

    for (const product of productEntities) {
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

    let toSave: Product[];

    if (!existingProducts || existingProducts.length === 0) {
      toSave = productEntities;
    } else {
      const existingNames = new Set<string>(
        existingProducts.map((p) => p.name),
      );
      const existingSlugs = new Set<string>(
        existingProducts.map((p) => p.slug),
      );
      toSave = productEntities.filter(
        ({ name, slug }) =>
          !existingNames.has(name) && !existingSlugs.has(slug),
      );

      if (toSave.length === 0) {
        throw new BadRequestException(
          'All the input products names or slugs are exists.',
        );
      }
    }

    const saved = await this.productsRepo.save(toSave);

    // Create inventory for each newly created product, preserving original stock
    for (let i = 0; i < saved.length; i++) {
      const savedProduct = saved[i];
      // Find original input matching saved product by name
      const original = inputsWithStock.find(
        ({ rest }) => rest.name === savedProduct.name,
      );
      const initialStock =
        original &&
        typeof original.stock === 'number' &&
        Number.isFinite(original.stock)
          ? original.stock
          : 0;
      await this.inventoryService.createForProduct(
        savedProduct.id,
        initialStock,
      );
    }

    return saved;
  }

  async findAll(paginationArgs: PaginationArgs) {
    const { page, limit } = paginationArgs;

    const key = `products:list:${page}:${limit}`;
    const cachedProducts = await this.cacheManager.get(key);

    if (cachedProducts) {
      this.logger.debug(`Cache HIT: ${key}`);

      return cachedProducts;
    }

    this.logger.debug(`Cache MISS: ${key}`);

    const skip = (page! - 1) * limit!;

    // TODO: Add the search and filters in the future
    const [data, total] = await this.productsRepo.findAndCount({
      take: limit,
      skip,
    });

    const result = {
      data,
      meta: {
        totalItems: total,
        itemCount: data.length,
        itemsPerPage: limit,
        totalPages: Math.ceil(total / limit!),
        currentPage: page,
      },
    };

    await this.cacheManager.set(key, result);

    return result;
  }

  async findOne(id: string) {
    return this.productsRepo.findOne({ where: { id } });
  }

  async update(id: string, updateProductInput: UpdateProductInput) {
    const product = await this.productsRepo.findOneBy({ id });

    if (!product)
      throw new NotFoundException(
        `Trying to update a product that doesn't exist`,
      );

    const { stock: _stock, ...restInput } =
      updateProductInput as UpdateProductInput & { stock?: number };

    this.productsRepo.merge(product, restInput);

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
        const { stock: _stock, ...sanitized } =
          (partialData as Record<string, unknown>) || {};
        return manager.merge(Product, existingProduct, sanitized);
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
