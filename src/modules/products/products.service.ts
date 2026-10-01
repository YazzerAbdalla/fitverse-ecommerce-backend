import slugify from 'slugify';
import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
  Optional,
  forwardRef,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { CreateProductInput } from './dto/create-product.input';
import { UpdateProductInput } from './dto/update-product.input';
import { InjectRepository } from '@nestjs/typeorm';
import { Product } from './entities/product.entity';
import { Repository, In, DataSource } from 'typeorm';
import { CACHE_MANAGER, Cache } from '@nestjs/cache-manager';
import { ManyPartialProducts } from './types';
import { PaginationArgs } from './dto/pagination.dto';
import { InventoryService } from '../inventory/inventory.service';
import { NotificationService } from '../notifications/notification.service';

/**
 * This service is responsible for product catalog and product-cache (cache-aside).
 * It handles product CRUD, paginated listing, and Redis caching for products only.
 * It enforces that Redis is never authoritative for inventory/reservation/order
 * and that every product mutation invalidates caches after DB commit (fail-open).
 */
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
    private readonly configService: ConfigService,
    // Optional to avoid a hard requirement in unit tests and to keep product
    // creation available when the notification queue is not wired.
    @Optional()
    private readonly notificationService?: NotificationService,
  ) {
    // Log TTLs on init (after construction, config available)
    const listTtl = this.getListTtlMs();
    const singleTtl = this.getSingleTtlMs();
    this.logger.log(`Product cache TTLs: list=${listTtl} single=${singleTtl}`);
    this.logger.log(
      'Cache strategy: product catalog only (inventory/reservation/order never cached)',
    );
  }

  /**
   * Builds cache key for paginated product listing.
   * @param page - Page number (1-indexed).
   * @param limit - Items per page.
   * @returns Cache key `products:list:{page}:{limit}`.
   */
  private buildKeyList(
    page: number | undefined,
    limit: number | undefined,
  ): string {
    return `products:list:${page}:${limit}`;
  }

  /**
   * Builds cache key for single product.
   * @param id - Product UUID.
   * @returns Cache key `product:{id}`.
   */
  private buildKeySingle(id: string): string {
    return `product:${id}`;
  }

  /**
   * Parses TTL env value with clamp and fallback.
   * @param raw - Raw string from ConfigService.
   * @param fallback - Default TTL ms.
   * @param min - Minimum allowed TTL ms.
   * @returns Parsed TTL ms clamped to min or fallback if NaN/invalid.
   */
  private parseTtlMs(
    raw: string | undefined,
    fallback: number,
    min: number,
  ): number {
    if (raw === undefined || raw === null || raw === '') return fallback;
    const parsed = parseInt(raw, 10);
    if (!Number.isFinite(parsed) || parsed < min) {
      this.logger.warn(
        `Invalid TTL config value "${raw}", fallback to ${fallback} (min ${min})`,
      );
      return fallback;
    }
    return parsed;
  }

  /**
   * Returns TTL for list cache via ConfigService.
   * @returns TTL ms for `products:list:*` (default 60000, min 5000).
   */
  private getListTtlMs(): number {
    const raw = this.configService.get<string>('PRODUCT_LIST_CACHE_TTL_MS');
    return this.parseTtlMs(raw, 60_000, 5_000);
  }

  /**
   * Returns TTL for single product cache via ConfigService.
   * @returns TTL ms for `product:{id}` (default 300000, min 30000).
   */
  private getSingleTtlMs(): number {
    const raw = this.configService.get<string>('PRODUCT_SINGLE_CACHE_TTL_MS');
    return this.parseTtlMs(raw, 300_000, 30_000);
  }

  /**
   * Invalidates single product cache entry (fail-open).
   * @param id - Product id whose `product:{id}` key to delete.
   */
  private async invalidateSingle(id: string): Promise<void> {
    const key = this.buildKeySingle(id);
    try {
      await this.cacheManager.del(key);
      this.logger.debug(`Cache DEL: ${key}`);
    } catch (e) {
      this.logger.warn(
        `Cache DEL failed for key ${key}: ${(e as Error).message}`,
      );
    }
  }

  /**
   * Invalidates all product list caches (fail-open).
   * Uses store.keys('products:list:*') selective delete; fallback to clear() if keys unsupported.
   */
  private async invalidateAllLists(): Promise<void> {
    try {
      const store: unknown = (
        this.cacheManager as unknown as { store?: unknown }
      ).store;
      const maybeKeys = (
        store as { keys?: (pattern: string) => Promise<string[]> }
      )?.keys;
      if (typeof maybeKeys === 'function') {
        const keys: string[] = await maybeKeys.call(store, 'products:list:*');
        if (keys && keys.length > 0) {
          await Promise.all(
            keys.map((k) =>
              (this.cacheManager.del(k) as Promise<unknown>).catch(
                (err: unknown) =>
                  this.logger.warn(
                    `Cache DEL failed for key ${k}: ${(err as Error).message}`,
                  ),
              ),
            ),
          );
          this.logger.debug(`Cache invalidate lists: ${keys.length} keys`);
        } else {
          this.logger.debug('Cache invalidate lists: no keys found');
        }
        return;
      }
      // Also try cacheManager store via any with prefix scan
      const cacheStore = (
        this.cacheManager as unknown as { stores?: unknown[] }
      ).stores;
      if (Array.isArray(cacheStore)) {
        // fallback: iterate stores
        for (const s of cacheStore as Array<{
          keys?: (p: string) => Promise<string[]>;
          del?: (k: string) => Promise<unknown>;
        }>) {
          if (typeof s.keys === 'function') {
            const keys = await s.keys('products:list:*');
            if (keys.length > 0) {
              await Promise.all(
                keys.map((k) =>
                  this.cacheManager
                    .del(k)
                    .catch((err: unknown) =>
                      this.logger.warn(
                        `Cache DEL failed for key ${k}: ${(err as Error).message}`,
                      ),
                    ),
                ),
              );
              this.logger.debug(
                `Cache invalidate lists via stores: ${keys.length} keys`,
              );
              return;
            }
          }
        }
      }
      // Fallback to clear if keys not exposed
      this.logger.warn(
        'Fallback clear() invoked for products:list:* invalidation, store.keys not available',
      );
      await this.cacheManager.clear();
    } catch (e) {
      this.logger.warn(
        `Cache invalidateAllLists failed: ${(e as Error).message}`,
      );
    }
  }

  /**
   * Invalidates product caches for given ids (singles + all lists) after commit.
   * @param ids - Product ids to invalidate.
   */
  private async invalidateProductCaches(ids: string[]): Promise<void> {
    try {
      if (ids.length > 0) {
        await Promise.all(ids.map((id) => this.invalidateSingle(id)));
      }
      await this.invalidateAllLists();
    } catch (e) {
      this.logger.warn(
        `Cache invalidateProductCaches failed: ${(e as Error).message}`,
      );
    }
  }

  /**
   * Creates a single product and its inventory, then invalidates list caches.
   * @param createProductInput - Product creation data.
   * @returns Saved Product.
   * @throws ConflictException if name or slug already exists.
   */
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

    // Invalidate after DB commit (post-save, outside transaction)
    await this.invalidateAllLists();

    // Fire-and-forget fan-out AFTER commit: never inside a transaction, never
    // blocks product creation (onProductCreated logs instead of throwing).
    if (this.notificationService) {
      void this.notificationService.onProductCreated({
        id: savedProduct.id,
        name: savedProduct.name,
        price: savedProduct.price,
      });
    }

    return savedProduct;
  }

  /**
   * Creates many products in bulk, then invalidates list caches.
   * @param createProductInputs - Array of product creation data.
   * @returns Saved products.
   * @throws BadRequestException if duplicate names in request or all names exist.
   */
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

    // Invalidate after commit
    await this.invalidateAllLists();

    return saved;
  }

  /**
   * Lists products with pagination via cache-aside (fail-open).
   * @param paginationArgs - Pagination args {page, limit}.
   * @returns Paginated envelope {data, meta}.
   */
  async findAll(paginationArgs: PaginationArgs) {
    const { page, limit } = paginationArgs;

    const key = this.buildKeyList(page, limit);
    let cachedProducts: unknown = undefined;
    try {
      cachedProducts = await this.cacheManager.get(key);
    } catch (e) {
      this.logger.warn(
        `Cache GET failed for key ${key}: ${(e as Error).message}`,
      );
      cachedProducts = undefined;
    }

    // HIT only if cached and not null; null means not found (do not treat empty as miss if valid)
    if (cachedProducts !== undefined && cachedProducts !== null) {
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

    const ttl = this.getListTtlMs();
    try {
      await this.cacheManager.set(key, result, ttl);
    } catch (e) {
      this.logger.warn(
        `Cache SET failed for key ${key}: ${(e as Error).message}`,
      );
    }

    return result;
  }

  /**
   * Retrieves single product via cache-aside (fail-open, no negative cache).
   * @param id - Product UUID.
   * @returns Product or null if not found.
   */
  async findOne(id: string) {
    const key = this.buildKeySingle(id);
    let cached: unknown = undefined;
    try {
      cached = await this.cacheManager.get(key);
    } catch (e) {
      this.logger.warn(
        `Cache GET failed for key ${key}: ${(e as Error).message}`,
      );
      cached = undefined;
    }

    // HIT only if cached and not null; null means not found (do not cache negative)
    if (cached !== undefined && cached !== null) {
      this.logger.debug(`Cache HIT: ${key}`);
      return cached as Product;
    }

    this.logger.debug(`Cache MISS: ${key}`);

    const product = await this.productsRepo.findOne({ where: { id } });

    if (!product) {
      return product;
    }

    const ttl = this.getSingleTtlMs();
    try {
      await this.cacheManager.set(key, product, ttl);
    } catch (e) {
      this.logger.warn(
        `Cache SET failed for key ${key}: ${(e as Error).message}`,
      );
    }

    return product;
  }

  /**
   * Updates a single product, then invalidates its single key + all lists.
   * @param id - Product id.
   * @param updateProductInput - Patch data.
   * @returns Saved product.
   * @throws NotFoundException if product not found.
   */
  async update(id: string, updateProductInput: UpdateProductInput) {
    const product = await this.productsRepo.findOneBy({ id });

    if (!product)
      throw new NotFoundException(
        `Trying to update a product that doesn't exist`,
      );

    const { stock: _stock, ...restInput } =
      updateProductInput as UpdateProductInput & { stock?: number };

    this.productsRepo.merge(product, restInput);

    const saved = await this.productsRepo.save(product);

    // Invalidate after commit
    await this.invalidateProductCaches([id]);

    return saved;
  }

  /**
   * Bulk updates products transactionally with pessimistic locking, then invalidates.
   * @param manyPartialProducts - Array of partial products with id + patch.
   * @returns Message and updated products.
   * @throws NotFoundException if any id missing.
   */
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
    const result = await this.dataSource.transaction(async (manager) => {
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

    // Invalidate after commit (outside transaction)
    await this.invalidateProductCaches(productIds);

    return result;
  }

  /**
   * Deletes a product by id, then invalidates its cache entries.
   * @param id - Product id.
   * @returns Delete result.
   */
  async remove(id: string) {
    const result = await this.productsRepo.delete(id);
    // Invalidate after commit (best-effort, fail-open)
    await this.invalidateProductCaches([id]);
    return result;
  }

  /**
   * Deletes all products, then clears product caches.
   * @returns Delete result.
   */
  async resetAll() {
    const result = await this.productsRepo.deleteAll();
    // Clear all product-related caches (lists + singles via clear or selective)
    try {
      // Prefer selective invalidation for products:lists plus clear singles
      await this.invalidateAllLists();
      // If store supports keys for product:*, clear singles selectively as fallback
      const store: unknown = (
        this.cacheManager as unknown as { store?: unknown }
      ).store;
      const maybeKeys = (store as { keys?: (p: string) => Promise<string[]> })
        ?.keys;
      if (typeof maybeKeys === 'function') {
        try {
          const prodKeys: string[] = await maybeKeys.call(store, 'product:*');
          await Promise.all(
            prodKeys.map((k) =>
              this.cacheManager.del(k).catch(() => undefined),
            ),
          );
        } catch {
          // fallback to clear singles via clear if needed
        }
      } else {
        // Fallback: clear all (only products are cached globally per SC-008, but warn)
        try {
          await this.cacheManager.clear();
        } catch (e) {
          this.logger.warn(
            `Cache clear failed for resetAll: ${(e as Error).message}`,
          );
        }
      }
    } catch (e) {
      this.logger.warn(
        `Cache invalidate resetAll failed: ${(e as Error).message}`,
      );
    }
    return result;
  }

  private generateSlug(name: string) {
    return slugify(name, { lower: true, strict: true });
  }
}
