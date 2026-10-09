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
 * Minimal shape of a cache store capable of listing keys by pattern.
 * Declared structurally so any store (single, multi, or test double) offering
 * `keys(pattern)` qualifies without coupling to a vendor-specific store type.
 */
interface KeyPatternLister {
  keys: (keyPattern: string) => Promise<unknown>;
}

/**
 * Checks whether a value offers pattern-based key listing.
 * @param candidateStore - Value to inspect (typically a cache store field).
 * @returns True when the value is an object exposing a callable `keys` function.
 */
function canListKeysByPattern(
  candidateStore: unknown,
): candidateStore is KeyPatternLister {
  return (
    typeof candidateStore === 'object' &&
    candidateStore !== null &&
    'keys' in candidateStore &&
    typeof candidateStore.keys === 'function'
  );
}

/**
 * Checks whether a cached value is a product snapshot written by this service.
 * Only `Product` rows are ever stored under `product:{id}` keys, so a shape
 * check on the identity fields is sufficient to trust a hit.
 * @param cachedValue - Value read from the cache (unknown origin).
 * @returns True when the value is a non-null object with string `id` and `name`.
 */
function isCachedProductSnapshot(cachedValue: unknown): cachedValue is Product {
  return (
    typeof cachedValue === 'object' &&
    cachedValue !== null &&
    'id' in cachedValue &&
    typeof cachedValue.id === 'string' &&
    'name' in cachedValue &&
    typeof cachedValue.name === 'string'
  );
}

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
   * Cache key of the list-generation counter used when key listing is unavailable.
   * Bumping it orphans stale versioned list keys (they expire via TTL).
   */
  private readonly LIST_VERSION_KEY = 'products:cache-version';

  /**
   * TTL for the list-generation counter in ms.
   * Outlives list entries (60s) so a reset version can never resurrect stale keys.
   */
  private readonly LIST_VERSION_TTL_MS = 7 * 24 * 3600 * 1000;

  /**
   * Builds a versioned cache key for paginated product listing.
   * The version segment lets invalidation orphan keys without flushing the shared store.
   * @param productListVersion - Current list generation (from `resolveProductListVersion`).
   * @param page - Page number (1-indexed).
   * @param limit - Items per page.
   * @returns Cache key `products:list:v{version}:{page}:{limit}`.
   */
  private buildProductListKey(
    productListVersion: number,
    page: number | undefined,
    limit: number | undefined,
  ): string {
    return `products:list:v${productListVersion}:${page}:${limit}`;
  }

  /**
   * Resolves the current product-list generation, defaulting to 1 when missing or unreadable.
   * Fail-open: a cache failure must never break catalog reads.
   * @returns Current list generation (>= 1).
   */
  private async resolveProductListVersion(): Promise<number> {
    try {
      const storedVersion = await this.cacheManager.get<number | string>(
        this.LIST_VERSION_KEY,
      );
      // Keyv preserves JSON primitives: accept finite numbers >= 1 and numeric strings
      if (typeof storedVersion === 'number') {
        if (Number.isFinite(storedVersion) && storedVersion >= 1) {
          return Math.floor(storedVersion);
        }
        return 1;
      }
      if (typeof storedVersion === 'string') {
        const parsedVersion = parseInt(storedVersion, 10);
        if (Number.isFinite(parsedVersion) && parsedVersion >= 1) {
          return parsedVersion;
        }
      }
    } catch (resolveError: unknown) {
      this.logger.warn(
        `Cache GET failed for key ${this.LIST_VERSION_KEY}: ${this.toCacheLogMessage(resolveError)}`,
      );
    }
    return 1;
  }

  /**
   * Bumps the product-list generation so versioned list keys go stale without a store flush.
   * Fail-open: logs and swallows cache failures.
   */
  private async bumpProductListVersion(): Promise<void> {
    try {
      const currentVersion = await this.resolveProductListVersion();
      const nextVersion = currentVersion + 1;
      await this.cacheManager.set(
        this.LIST_VERSION_KEY,
        nextVersion,
        this.LIST_VERSION_TTL_MS,
      );
      this.logger.debug(`Cache list generation bumped to ${nextVersion}`);
    } catch (bumpError: unknown) {
      this.logger.warn(
        `Cache list-generation bump failed: ${this.toCacheLogMessage(bumpError)}`,
      );
    }
  }

  /**
   * Extracts a log-safe message from a caught value.
   * @param caughtError - Value caught by a catch clause.
   * @returns The error message when available, otherwise the stringified value.
   */
  private toCacheLogMessage(caughtError: unknown): string {
    return caughtError instanceof Error
      ? caughtError.message
      : String(caughtError);
  }

  /**
   * Deletes cache keys best-effort, logging (not throwing) per-key failures.
   * @param cacheKeysToDelete - Keys to delete.
   */
  private async deleteCacheKeysBestEffort(
    cacheKeysToDelete: string[],
  ): Promise<void> {
    await Promise.all(
      cacheKeysToDelete.map((keyToDelete) =>
        this.cacheManager.del(keyToDelete).catch((deleteError: unknown) => {
          this.logger.warn(
            `Cache DEL failed for key ${keyToDelete}: ${this.toCacheLogMessage(deleteError)}`,
          );
        }),
      ),
    );
  }

  /**
   * Lists cached keys matching a pattern via the underlying store(s).
   * Probes single-store then multi-store shapes; never touches the `Cache` facade typing.
   * @param keyPattern - Pattern such as `products:list:*`.
   * @returns Matching keys, empty array when none, null when no store supports listing.
   */
  private async findCacheKeysByPattern(
    keyPattern: string,
  ): Promise<string[] | null> {
    const cacheHolder: unknown = this.cacheManager;
    // Non-object holders cannot expose stores; treat as unsupported listing
    if (typeof cacheHolder !== 'object' || cacheHolder === null) {
      return null;
    }
    if ('store' in cacheHolder && canListKeysByPattern(cacheHolder.store)) {
      return this.readPatternKeys(cacheHolder.store, keyPattern);
    }
    if ('stores' in cacheHolder && Array.isArray(cacheHolder.stores)) {
      for (const candidateStore of cacheHolder.stores) {
        if (canListKeysByPattern(candidateStore)) {
          return this.readPatternKeys(candidateStore, keyPattern);
        }
      }
    }
    return null;
  }

  /**
   * Reads keys from a listing-capable store and keeps string entries only.
   * @param keyLister - Store confirmed to offer `keys(pattern)` by `canListKeysByPattern`.
   * @param keyPattern - Pattern such as `products:list:*`.
   * @returns String keys, or null when the store answered with a non-array payload.
   */
  private async readPatternKeys(
    keyLister: KeyPatternLister,
    keyPattern: string,
  ): Promise<string[] | null> {
    const listedKeys: unknown = await keyLister.keys(keyPattern);
    // Guard the store contract: only arrays qualify, only string entries survive
    if (!Array.isArray(listedKeys)) {
      return null;
    }
    return listedKeys.filter(
      (listedEntry: unknown): listedEntry is string =>
        typeof listedEntry === 'string',
    );
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
   * Unit is milliseconds (cache-manager/keyv convention, shared with rate-limit and OTP stores).
   * @returns TTL ms for `products:list:*` (default 60000, min 5000).
   */
  private getListTtlMs(): number {
    const raw = this.configService.get<string>('PRODUCT_LIST_CACHE_TTL_MS');
    return this.parseTtlMs(raw, 60_000, 5_000);
  }

  /**
   * Returns TTL for single product cache via ConfigService.
   * Unit is milliseconds (cache-manager/keyv convention, shared with rate-limit and OTP stores).
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
    } catch (deleteError: unknown) {
      this.logger.warn(
        `Cache DEL failed for key ${key}: ${this.toCacheLogMessage(deleteError)}`,
      );
    }
  }

  /**
   * Invalidates all product list caches without ever flushing the shared store.
   * Deletes discoverable keys, then bumps the list generation so undiscoverable
   * or concurrently-created keys go stale. Fail-open: logs and swallows failures.
   */
  private async invalidateAllLists(): Promise<void> {
    try {
      const discoverableKeys =
        await this.findCacheKeysByPattern('products:list:*');
      if (discoverableKeys && discoverableKeys.length > 0) {
        await this.deleteCacheKeysBestEffort(discoverableKeys);
        this.logger.debug(
          `Cache invalidate lists: ${discoverableKeys.length} keys`,
        );
      } else if (discoverableKeys) {
        this.logger.debug('Cache invalidate lists: no keys found');
      } else {
        this.logger.debug(
          'Cache invalidate lists: key listing unavailable, version bump only',
        );
      }
      // Generation bump covers keys created between listing and delete, and is the
      // sole mechanism when the store cannot list keys. Never cacheManager.clear():
      // the store is shared with rate-limit, expiration, and dedup namespaces.
      await this.bumpProductListVersion();
    } catch (invalidateError: unknown) {
      this.logger.warn(
        `Cache invalidateAllLists failed: ${this.toCacheLogMessage(invalidateError)}`,
      );
      await this.bumpProductListVersion();
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
    } catch (cachesError: unknown) {
      this.logger.warn(
        `Cache invalidateProductCaches failed: ${this.toCacheLogMessage(cachesError)}`,
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

    const { name, stock, description, price } = createProductInput;

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

    // Product row persists catalog columns only; stock is seeded into Inventory below
    const productToSave = this.productsRepo.create({
      name,
      slug,
      description,
      price,
    });

    const savedProduct = await this.productsRepo.save(productToSave);

    // Input validation requires stock, but treat a missing value as zero stock
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
      const { stock, ...rest } = input;
      return { rest, stock };
    });

    const productEntities = inputsWithStock.map(({ rest }) =>
      this.productsRepo.create(rest),
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

    const productListVersion = await this.resolveProductListVersion();
    const key = this.buildProductListKey(productListVersion, page, limit);
    let cachedProducts: unknown = undefined;
    try {
      cachedProducts = await this.cacheManager.get(key);
    } catch (getError: unknown) {
      this.logger.warn(
        `Cache GET failed for key ${key}: ${this.toCacheLogMessage(getError)}`,
      );
      cachedProducts = undefined;
    }

    // HIT only if cached and not null; null means not found (do not treat empty as miss if valid)
    if (cachedProducts !== undefined && cachedProducts !== null) {
      this.logger.debug(`Cache HIT: ${key}`);

      return cachedProducts;
    }

    this.logger.debug(`Cache MISS: ${key}`);

    // Pagination offset for the requested page (1-indexed input)
    const skip = (page! - 1) * limit!;

    // TODO: Add the search and filters in the future
    // Deterministic order keeps pages stable across cache miss/hit and invalidation
    const [data, total] = await this.productsRepo.findAndCount({
      take: limit,
      skip,
      order: { created_at: 'ASC', id: 'ASC' },
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
    } catch (setError: unknown) {
      this.logger.warn(
        `Cache SET failed for key ${key}: ${this.toCacheLogMessage(setError)}`,
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
    } catch (getError: unknown) {
      this.logger.warn(
        `Cache GET failed for key ${key}: ${this.toCacheLogMessage(getError)}`,
      );
      cached = undefined;
    }

    // HIT only if cached and not null; null means not found (do not cache negative)
    if (isCachedProductSnapshot(cached)) {
      this.logger.debug(`Cache HIT: ${key}`);
      return cached;
    }

    this.logger.debug(`Cache MISS: ${key}`);

    const product = await this.productsRepo.findOne({ where: { id } });

    if (!product) {
      return product;
    }

    const ttl = this.getSingleTtlMs();
    try {
      await this.cacheManager.set(key, product, ttl);
    } catch (setError: unknown) {
      this.logger.warn(
        `Cache SET failed for key ${key}: ${this.toCacheLogMessage(setError)}`,
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

    // Stock is owned by Inventory: strip it so the Product row never persists stock
    const { stock: ignoredStockField, ...productOnlyPatch } =
      updateProductInput;
    void ignoredStockField;

    this.productsRepo.merge(product, productOnlyPatch);

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
        // Length + membership checks above guarantee a match; fail loudly instead of merging undefined
        if (partialData === undefined) {
          throw new NotFoundException(
            `Update failed. Product with ID [${existingProduct.id}] was not found.`,
          );
        }
        // Stock is owned by Inventory: strip it so the Product row never persists stock
        const { stock: ignoredStockField, ...sanitizedPatch } = partialData;
        void ignoredStockField;
        return manager.merge(Product, existingProduct, sanitizedPatch);
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
   * Deletes all products, then invalidates product caches without a store flush.
   * Undiscoverable single-product keys expire via TTL; the list generation bump
   * covers them immediately.
   * @returns Delete result.
   */
  async resetAll() {
    const result = await this.productsRepo.deleteAll();
    // Clear all product-related caches (lists + discoverable singles, never clear())
    try {
      await this.invalidateAllLists();
      const singleProductKeys = await this.findCacheKeysByPattern('product:*');
      if (singleProductKeys && singleProductKeys.length > 0) {
        await this.deleteCacheKeysBestEffort(singleProductKeys);
      } else if (!singleProductKeys) {
        this.logger.debug(
          'Cache resetAll: single-key listing unavailable, TTL expiry heals undiscoverable singles',
        );
      }
    } catch (resetError: unknown) {
      this.logger.warn(
        `Cache invalidate resetAll failed: ${this.toCacheLogMessage(resetError)}`,
      );
    }
    return result;
  }

  private generateSlug(name: string) {
    return slugify(name, { lower: true, strict: true });
  }
}
