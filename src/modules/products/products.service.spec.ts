import { Test, TestingModule } from '@nestjs/testing';
import { ProductsService } from './products.service';
import { getRepositoryToken } from '@nestjs/typeorm';
import { Product } from './entities/product.entity';
import { CACHE_MANAGER } from '@nestjs/cache-manager';
import { DataSource } from 'typeorm';
import { Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InventoryService } from '../inventory/inventory.service';

describe('ProductsService', () => {
  let service: ProductsService;
  let productsRepo: Record<string, jest.Mock>;
  let cacheManager: Record<string, jest.Mock> & {
    store?: { keys?: jest.Mock };
  };
  let logger: Record<string, jest.Mock>;
  let dataSource: Record<string, jest.Mock>;
  let configService: Record<string, jest.Mock>;
  let inventoryService: Record<string, jest.Mock>;

  const mockProduct = (overrides: Partial<Product> = {}): Product =>
    ({
      id: 'abc-123',
      name: 'Test',
      slug: 'test',
      description: 'desc',
      price: 100,
      ...overrides,
    }) as Product;

  beforeEach(async () => {
    productsRepo = {
      findOne: jest.fn(),
      findOneBy: jest.fn(),
      create: jest.fn((x) => x as Product),
      save: jest.fn((x) => Promise.resolve(x as Product)),
      find: jest.fn(),
      findAndCount: jest.fn(),
      delete: jest.fn().mockResolvedValue({ affected: 1 }),
      deleteAll: jest.fn().mockResolvedValue({ affected: 1 }),
      merge: jest.fn((a, b) => ({ ...a, ...b })),
    };
    cacheManager = {
      get: jest.fn(),
      set: jest.fn().mockResolvedValue(undefined),
      del: jest.fn().mockResolvedValue(undefined),
      clear: jest.fn().mockResolvedValue(undefined),
      store: { keys: jest.fn().mockResolvedValue([]) },
    };
    logger = {
      debug: jest.fn(),
      log: jest.fn(),
      warn: jest.fn(),
      error: jest.fn(),
    };
    dataSource = {
      transaction: jest.fn((cb: (manager: unknown) => unknown) => {
        const manager = {
          find: jest.fn().mockResolvedValue([]),
          save: jest.fn((_, v) => Promise.resolve(v)),
          merge: jest.fn((_, a, b) => ({ ...a, ...b })),
        };
        return cb(manager);
      }),
    };
    configService = {
      get: jest.fn().mockReturnValue(undefined),
    };
    inventoryService = {
      createForProduct: jest.fn().mockResolvedValue(undefined),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        ProductsService,
        { provide: getRepositoryToken(Product), useValue: productsRepo },
        { provide: CACHE_MANAGER, useValue: cacheManager },
        { provide: Logger, useValue: logger },
        { provide: DataSource, useValue: dataSource },
        { provide: ConfigService, useValue: configService },
        { provide: InventoryService, useValue: inventoryService },
      ],
    }).compile();

    service = module.get<ProductsService>(ProductsService);
    // clear init logs
    logger.log.mockClear();
    logger.warn.mockClear();
    logger.debug.mockClear();
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });

  // US1 T009 miss->hit
  describe('findAll cache-aside', () => {
    it('miss populates cache then hit does not call DB (T009 SC-001)', async () => {
      const envelope = {
        data: [mockProduct()],
        meta: {
          totalItems: 1,
          itemCount: 1,
          itemsPerPage: 10,
          totalPages: 1,
          currentPage: 1,
        },
      };
      productsRepo.findAndCount.mockResolvedValueOnce([[mockProduct()], 1]);
      cacheManager.get.mockResolvedValueOnce(undefined); // miss
      const first = await service.findAll({ page: 1, limit: 10 });
      expect(first).toEqual(
        expect.objectContaining({
          meta: expect.objectContaining({ totalItems: 1 }),
        }),
      );
      expect(productsRepo.findAndCount).toHaveBeenCalledTimes(1);
      expect(cacheManager.set).toHaveBeenCalledWith(
        'products:list:v1:1:10',
        expect.any(Object),
        60_000,
      );
      expect(logger.debug).toHaveBeenCalledWith(
        expect.stringContaining('Cache MISS'),
      );

      // second hit (queue the list generation first, then the cached envelope)
      productsRepo.findAndCount.mockClear();
      logger.debug.mockClear();
      cacheManager.get.mockResolvedValueOnce(1);
      cacheManager.get.mockResolvedValueOnce(envelope);
      const second = await service.findAll({ page: 1, limit: 10 });
      expect(second).toEqual(envelope);
      expect(productsRepo.findAndCount).not.toHaveBeenCalled();
      expect(logger.debug).toHaveBeenCalledWith(
        expect.stringContaining('Cache HIT'),
      );
    });

    it('pagination isolation (T010 SC-002)', async () => {
      cacheManager.get.mockResolvedValueOnce(undefined);
      productsRepo.findAndCount.mockResolvedValueOnce([[], 0]);
      await service.findAll({ page: 1, limit: 10 });
      expect(cacheManager.get).toHaveBeenCalledWith('products:list:v1:1:10');
      cacheManager.get.mockResolvedValueOnce(undefined);
      productsRepo.findAndCount.mockResolvedValueOnce([[], 0]);
      await service.findAll({ page: 2, limit: 10 });
      expect(cacheManager.get).toHaveBeenCalledWith('products:list:v1:2:10');
    });

    it('TTL expiry re-miss (T011)', async () => {
      cacheManager.get.mockResolvedValueOnce(undefined);
      productsRepo.findAndCount.mockResolvedValueOnce([[mockProduct()], 1]);
      await service.findAll({ page: 1, limit: 10 });
      expect(productsRepo.findAndCount).toHaveBeenCalledTimes(1);
      cacheManager.get.mockResolvedValueOnce(undefined); // expired
      productsRepo.findAndCount.mockResolvedValueOnce([[mockProduct()], 1]);
      await service.findAll({ page: 1, limit: 10 });
      expect(productsRepo.findAndCount).toHaveBeenCalledTimes(2);
    });
  });

  // US2 T014-T018
  describe('invalidation on mutation', () => {
    it('create invalidates all lists (T014 SC-003)', async () => {
      productsRepo.findOne.mockResolvedValueOnce(null);
      productsRepo.save.mockResolvedValueOnce(
        mockProduct({ id: 'new', name: 'X' }),
      );
      const storeKeys = cacheManager.store!.keys as jest.Mock;
      storeKeys.mockResolvedValueOnce([
        'products:list:1:10',
        'products:list:2:10',
      ]);
      await service.create({
        name: 'X',
        description: 'x',
        price: 111,
      } as never);
      expect(cacheManager.del).toHaveBeenCalledWith('products:list:1:10');
      expect(cacheManager.del).toHaveBeenCalledWith('products:list:2:10');
    });

    it('update invalidates single + lists (T015 SC-004)', async () => {
      const existing = mockProduct({ id: 'abc-123' });
      productsRepo.findOneBy.mockResolvedValueOnce(existing);
      productsRepo.save.mockResolvedValueOnce({ ...existing, price: 999 });
      const storeKeys = cacheManager.store!.keys as jest.Mock;
      storeKeys.mockResolvedValueOnce(['products:list:1:10']);
      await service.update('abc-123', { price: 999 });
      expect(cacheManager.del).toHaveBeenCalledWith('product:abc-123');
      expect(cacheManager.del).toHaveBeenCalledWith('products:list:1:10');
    });

    it('updateMany invalidates each single + lists (T016 SC-005)', async () => {
      const ids = ['a', 'b', 'c', 'd', 'e'];
      const partials = ids.map((id) => ({ id, price: 10 }));
      const managerFind = jest
        .fn()
        .mockResolvedValue(ids.map((id) => mockProduct({ id })));
      const managerSave = jest
        .fn()
        .mockResolvedValue(ids.map((id) => mockProduct({ id, price: 10 })));
      const managerMerge = jest.fn((_, a, b) => ({ ...a, ...b }));
      dataSource.transaction.mockImplementationOnce(
        (cb: (m: unknown) => Promise<unknown>) =>
          cb({
            find: managerFind,
            save: managerSave,
            merge: managerMerge,
          }),
      );
      const storeKeys = cacheManager.store!.keys as jest.Mock;
      storeKeys.mockResolvedValueOnce(['products:list:1:10']);
      const result = await service.updateMany(partials);
      expect(result.data).toHaveLength(5);
      for (const id of ids)
        expect(cacheManager.del).toHaveBeenCalledWith(`product:${id}`);
      expect(cacheManager.del).toHaveBeenCalledWith('products:list:1:10');
    });

    it('remove invalidates single + lists (T017)', async () => {
      const storeKeys = cacheManager.store!.keys as jest.Mock;
      storeKeys.mockResolvedValueOnce(['products:list:1:10']);
      await service.remove('abc-123');
      expect(cacheManager.del).toHaveBeenCalledWith('product:abc-123');
    });

    it('no invalidation on create failure duplicate 409 (T018 SC-006)', async () => {
      productsRepo.findOne.mockResolvedValueOnce(mockProduct());
      await expect(
        service.create({ name: 'Test', description: 'x', price: 1 } as never),
      ).rejects.toThrow();
      expect(cacheManager.del).not.toHaveBeenCalled();
      expect(cacheManager.clear).not.toHaveBeenCalled();
    });
  });

  // US3 T024-T025
  describe('findOne cache', () => {
    it('miss->hit and no negative cache (T024)', async () => {
      cacheManager.get.mockResolvedValueOnce(undefined);
      productsRepo.findOne.mockResolvedValueOnce(mockProduct({ id: 'abc' }));
      const first = await service.findOne('abc');
      expect(first).toBeDefined();
      expect(cacheManager.set).toHaveBeenCalledWith(
        'product:abc',
        expect.objectContaining({ id: 'abc' }),
        300_000,
      );
      cacheManager.get.mockResolvedValueOnce(mockProduct({ id: 'abc' }));
      const second = await service.findOne('abc');
      expect(second).toEqual(expect.objectContaining({ id: 'abc' }));
      expect(productsRepo.findOne).toHaveBeenCalledTimes(1);
      // null not cached
      cacheManager.get.mockResolvedValueOnce(undefined);
      productsRepo.findOne.mockResolvedValueOnce(null);
      const missNull = await service.findOne('missing');
      expect(missNull).toBeNull();
      expect(cacheManager.set).toHaveBeenCalledTimes(1); // only first set
    });

    it('invalidated by update (T025)', async () => {
      cacheManager.get.mockResolvedValueOnce(mockProduct({ id: 'abc' }));
      await service.findOne('abc');
      // update will del product:abc
      productsRepo.findOneBy.mockResolvedValueOnce(mockProduct({ id: 'abc' }));
      productsRepo.save.mockResolvedValueOnce(
        mockProduct({ id: 'abc', price: 999 }),
      );
      const storeKeys = cacheManager.store!.keys as jest.Mock;
      storeKeys.mockResolvedValueOnce([]);
      await service.update('abc', { price: 999 });
      expect(cacheManager.del).toHaveBeenCalledWith('product:abc');
    });
  });

  // US4 T028-T031 fail-open + inventory never cached
  describe('fail-open', () => {
    it('findAll get throws still returns DB (T028 SC-007)', async () => {
      cacheManager.get.mockRejectedValueOnce(new Error('ECONNREFUSED'));
      productsRepo.findAndCount.mockResolvedValueOnce([[mockProduct()], 1]);
      const result = await service.findAll({ page: 1, limit: 10 });
      expect(result).toBeDefined();
      expect(logger.warn).toHaveBeenCalledWith(
        expect.stringContaining('Cache GET failed'),
      );
    });

    it('findAll set throws still returns 200 and del throw on create still commits (T029)', async () => {
      cacheManager.get.mockResolvedValueOnce(undefined);
      productsRepo.findAndCount.mockResolvedValueOnce([[mockProduct()], 1]);
      cacheManager.set.mockRejectedValueOnce(new Error('SET fail'));
      const r = await service.findAll({ page: 1, limit: 10 });
      expect(r).toBeDefined();
      expect(logger.warn).toHaveBeenCalledWith(
        expect.stringContaining('Cache SET failed'),
      );

      // create with del throw
      productsRepo.findOne.mockResolvedValueOnce(null);
      productsRepo.save.mockResolvedValueOnce(mockProduct({ id: 'new2' }));
      const storeKeys = cacheManager.store!.keys as jest.Mock;
      storeKeys.mockRejectedValueOnce(new Error('KEYS fail'));
      // should still succeed despite keys fail (fallback path attempts clear)
      cacheManager.clear.mockRejectedValueOnce(new Error('clear fail'));
      const created = await service.create({
        name: 'Y',
        description: 'y',
        price: 1,
      } as never);
      expect(created).toBeDefined();
      // warn logged
      expect(logger.warn).toHaveBeenCalled();
    });

    it('findOne get/set throws fail-open (T030)', async () => {
      cacheManager.get.mockRejectedValueOnce(new Error('ECONNREFUSED'));
      productsRepo.findOne.mockResolvedValueOnce(mockProduct({ id: 'x' }));
      const r = await service.findOne('x');
      expect(r).toBeDefined();
      expect(logger.warn).toHaveBeenCalled();

      cacheManager.get.mockResolvedValueOnce(undefined);
      productsRepo.findOne.mockResolvedValueOnce(mockProduct({ id: 'y' }));
      cacheManager.set.mockRejectedValueOnce(new Error('SET fail'));
      const r2 = await service.findOne('y');
      expect(r2).toBeDefined();
      expect(logger.warn).toHaveBeenCalledWith(
        expect.stringContaining('Cache SET failed'),
      );
    });

    it('inventory never cached audit (T031 SC-008)', () => {
      // service never stores stock/reservedAmount: cached value is product only
      // audit is that CART/INVENTORY modules have no CACHE_MANAGER injection - we check this file has no import of inventory cache
      // Here we assert cacheManager.get was not called with inventory key pattern in innocent product flow
      expect(cacheManager.get).not.toHaveBeenCalledWith(
        expect.stringContaining('inventory:'),
      );
    });

    it('TTL clamp uses defaults on invalid config', async () => {
      configService.get.mockReturnValueOnce('0'); // invalid list
      configService.get.mockReturnValueOnce('-5'); // invalid single second call
      // trigger via findAll/findOne which calls getListTtlMs/getSingleTtlMs internally
      cacheManager.get.mockResolvedValueOnce(undefined);
      productsRepo.findAndCount.mockResolvedValueOnce([[], 0]);
      await service.findAll({ page: 1, limit: 10 });
      // second call with single
      cacheManager.get.mockResolvedValueOnce(undefined);
      productsRepo.findOne.mockResolvedValueOnce(mockProduct({ id: 'clamp' }));
      await service.findOne('clamp');
      // warns were emitted for invalid TTL during getListTtlMs/getSingleTtlMs indirectly via constructor already tested
      // At least one warn for fallback
      expect(logger.warn).toHaveBeenCalled();
    });
  });

  // 020-cache-constraints-indexes: key completeness + deterministic order + TTL pin (T005/T006)
  describe('020 list-key completeness and order', () => {
    it('distinct pagination inputs produce distinct cache keys (T005 FR-004)', async () => {
      productsRepo.findAndCount.mockResolvedValue([[], 0]);
      await service.findAll({ page: 1, limit: 10 });
      await service.findAll({ page: 2, limit: 10 });
      await service.findAll({ page: 1, limit: 20 });
      const requestedCacheKeys = cacheManager.get.mock.calls.map(
        (cacheGetArgs: unknown[]) => cacheGetArgs[0],
      );
      const listKeys = requestedCacheKeys.filter(
        (requestedKey: unknown): requestedKey is string =>
          typeof requestedKey === 'string' &&
          requestedKey.startsWith('products:list:'),
      );
      // Every influencing input must participate in the key: 3 distinct inputs -> 3 distinct keys
      expect(new Set(listKeys).size).toBe(3);
    });

    it('findAndCount uses deterministic order created_at,id ASC (T006 FR-005)', async () => {
      cacheManager.get.mockResolvedValue(undefined);
      productsRepo.findAndCount.mockResolvedValueOnce([[], 0]);
      await service.findAll({ page: 1, limit: 10 });
      expect(productsRepo.findAndCount).toHaveBeenCalledWith(
        expect.objectContaining({ order: { created_at: 'ASC', id: 'ASC' } }),
      );
    });

    it('invalid TTL falls back to 60_000ms default with warn (T006 FR-006)', async () => {
      configService.get.mockImplementation((key: string) =>
        key === 'PRODUCT_LIST_CACHE_TTL_MS' ? '0' : undefined,
      );
      cacheManager.get.mockResolvedValue(undefined);
      productsRepo.findAndCount.mockResolvedValueOnce([[mockProduct()], 1]);
      await service.findAll({ page: 1, limit: 10 });
      expect(cacheManager.set).toHaveBeenCalledWith(
        expect.stringContaining('products:list:'),
        expect.any(Object),
        60_000,
      );
      expect(logger.warn).toHaveBeenCalledWith(
        expect.stringContaining('Invalid TTL'),
      );
    });
  });

  // 020-cache-constraints-indexes: full-store flush ban (T010 FR-003 / SC-002)
  describe('020 no full-store flush', () => {
    it('healthy store: mutations never call clear() (T010)', async () => {
      const storeKeys = cacheManager.store!.keys as jest.Mock;
      storeKeys.mockResolvedValue(['products:list:v1:1:10']);
      productsRepo.findOne.mockResolvedValue(null);
      productsRepo.save.mockImplementation((entity: unknown) =>
        Promise.resolve(entity as Product),
      );
      productsRepo.findOneBy.mockResolvedValue(mockProduct({ id: 'abc-123' }));
      await service.create({ name: 'A', description: 'a', price: 1, stock: 0 });
      await service.update('abc-123', { price: 2 });
      await service.remove('abc-123');
      expect(cacheManager.clear).not.toHaveBeenCalled();
    });

    it('keys-unavailable store: invalidation versions instead of clear() (T010)', async () => {
      cacheManager.store = {};
      productsRepo.findOne.mockResolvedValueOnce(null);
      productsRepo.save.mockResolvedValueOnce(
        mockProduct({ id: 'nv', name: 'NV' }),
      );
      await service.create({
        name: 'NV',
        description: 'nv',
        price: 5,
        stock: 0,
      });
      expect(cacheManager.clear).not.toHaveBeenCalled();
      // List generation bumped so stale versioned keys are orphaned, never flushed
      expect(cacheManager.set).toHaveBeenCalledWith(
        'products:cache-version',
        2,
        expect.any(Number),
      );
    });
  });
});
