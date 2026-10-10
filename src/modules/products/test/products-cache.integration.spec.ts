import { Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { CACHE_MANAGER, CacheModule } from '@nestjs/cache-manager';
import { createKeyv } from '@keyv/redis';
import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import type { Cache } from 'cache-manager';
import { InventoryService } from '../../inventory/inventory.service';
import { Product } from '../entities/product.entity';
import { ProductsService } from '../products.service';

const REDIS_URL = process.env.REDIS_URL || 'redis://localhost:6379';
const LIST_VERSION_KEY = 'products:cache-version';

/**
 * Live-cache proofs for 020-cache-constraints-indexes on real Redis.
 * Uses a mocked product repository (persistence is covered by unit + PG suites)
 * with the real cache manager, so key shapes, version bumps, TTLs, and
 * namespace isolation are proven against actual Redis behavior.
 * Skips gracefully when Redis is unreachable.
 */
describe('Products cache integration (real Redis)', () => {
  let service: ProductsService;
  let cache: Cache;
  let productsRepo: Record<string, jest.Mock>;
  let redisAvailable = false;
  let moduleRef: TestingModule;

  const mockProduct = (
    productId: string,
    productName: string,
  ): Partial<Product> => ({
    id: productId,
    name: productName,
    slug: productName.toLowerCase(),
    description: 'desc',
    price: 100,
  });

  const currentListVersion = async (): Promise<number> => {
    const storedVersion = await cache.get<number | string>(LIST_VERSION_KEY);
    return typeof storedVersion === 'number' ? storedVersion : 1;
  };

  const deleteProductKeys = async (): Promise<void> => {
    const version = await currentListVersion();
    await cache.del(LIST_VERSION_KEY);
    await cache.del(`products:list:v${version}:1:10`);
    await cache.del(`products:list:v${version}:2:10`);
    await cache.del('product:live-1');
  };

  beforeAll(async () => {
    productsRepo = {
      findOne: jest.fn(),
      findOneBy: jest.fn(),
      create: jest.fn((entity: Partial<Product>) => entity),
      save: jest.fn((entity: Partial<Product>) => Promise.resolve(entity)),
      find: jest.fn(),
      findAndCount: jest.fn(),
      delete: jest.fn().mockResolvedValue({ affected: 1 }),
      deleteAll: jest.fn().mockResolvedValue({ affected: 1 }),
      merge: jest.fn((current: Partial<Product>, patch: Partial<Product>) => ({
        ...current,
        ...patch,
      })),
    };
    const inventoryDouble = {
      createForProduct: jest.fn().mockResolvedValue(undefined),
    };
    try {
      moduleRef = await Test.createTestingModule({
        imports: [
          CacheModule.register({
            stores: [createKeyv(REDIS_URL)],
            ttl: 60 * 1000,
          }),
        ],
        providers: [
          ProductsService,
          { provide: getRepositoryToken(Product), useValue: productsRepo },
          { provide: Logger, useValue: new Logger('test') },
          { provide: ConfigService, useValue: new ConfigService() },
          { provide: InventoryService, useValue: inventoryDouble },
        ],
      }).compile();
      service = moduleRef.get<ProductsService>(ProductsService);
      cache = moduleRef.get<Cache>(CACHE_MANAGER);
      await cache.set('020:ping', 'pong', 5000);
      const pong = await cache.get<string>('020:ping');
      redisAvailable = pong === 'pong';
      await cache.del('020:ping');
    } catch {
      redisAvailable = false;
    }
  });

  afterEach(async () => {
    if (redisAvailable) {
      await deleteProductKeys();
    }
  });

  afterAll(async () => {
    if (moduleRef) {
      await moduleRef.close();
    }
  });

  it('live miss -> hit -> mutate -> miss with version bump (T009 SC-001)', async () => {
    if (!redisAvailable) return;
    const liveProduct = mockProduct('live-1', 'Live');
    productsRepo.findAndCount.mockResolvedValue([[liveProduct], 1]);
    const first = await service.findAll({ page: 1, limit: 10 });
    expect(productsRepo.findAndCount).toHaveBeenCalledTimes(1);
    const second = await service.findAll({ page: 1, limit: 10 });
    expect(second).toEqual(first);
    expect(productsRepo.findAndCount).toHaveBeenCalledTimes(1);

    productsRepo.findOne.mockResolvedValue(null);
    productsRepo.save.mockResolvedValue({ ...liveProduct, price: 150 });
    await service.update('live-1', { price: 150 });
    await service.findAll({ page: 1, limit: 10 });
    // Post-mutation read missed (new generation) and reloaded from the source
    expect(productsRepo.findAndCount).toHaveBeenCalledTimes(2);
    expect(await currentListVersion()).toBeGreaterThanOrEqual(2);
  });

  it('invalidation preserves foreign namespaces on every path (T011 SC-002)', async () => {
    if (!redisAvailable) return;
    const foreignKeys = [
      'rl:TEST-020',
      'expiration:tick:lock',
      'expiration:poison:count:020',
      'notification:processed:020',
      'resend:cooldown:020@test.com',
    ];
    for (const foreignKey of foreignKeys) {
      await cache.set(foreignKey, 'sentinel', 60000);
    }
    const liveProduct = mockProduct('live-1', 'Live');
    productsRepo.findAndCount.mockResolvedValue([[liveProduct], 1]);
    await service.findAll({ page: 1, limit: 10 });

    productsRepo.findOne.mockResolvedValue(null);
    productsRepo.save.mockResolvedValue(liveProduct);
    await service.create({
      name: 'Live2',
      description: 'd',
      price: 10,
      stock: 0,
    });
    productsRepo.findOneBy.mockResolvedValue(liveProduct);
    await service.update('live-1', { price: 120 });
    await service.remove('live-1');
    await service.resetAll();

    for (const foreignKey of foreignKeys) {
      expect(await cache.get(foreignKey)).toBe('sentinel');
    }
    for (const foreignKey of foreignKeys) {
      await cache.del(foreignKey);
    }
  });

  it('resetAll never flushes: foreign keys survive full reset (T013)', async () => {
    if (!redisAvailable) return;
    await cache.set('rl:TEST-020-reset', 'sentinel', 60000);
    await service.resetAll();
    expect(await cache.get('rl:TEST-020-reset')).toBe('sentinel');
    await cache.del('rl:TEST-020-reset');
  });

  it('cached envelopes carry no stock fields; dead Redis still serves DB (T019 SC-005)', async () => {
    if (!redisAvailable) return;
    const liveProduct = mockProduct('live-1', 'Live');
    productsRepo.findAndCount.mockResolvedValue([[liveProduct], 1]);
    const envelope: unknown = await service.findAll({ page: 1, limit: 10 });
    const serializedEnvelope = JSON.stringify(envelope);
    expect(serializedEnvelope).not.toContain('"stock"');
    expect(serializedEnvelope).not.toContain('reservedAmount');
    expect(serializedEnvelope).not.toContain('"available"');

    const deadModule = await Test.createTestingModule({
      imports: [
        CacheModule.register({
          stores: [createKeyv('redis://127.0.0.1:6399')],
          ttl: 60 * 1000,
        }),
      ],
      providers: [
        ProductsService,
        { provide: getRepositoryToken(Product), useValue: productsRepo },
        { provide: Logger, useValue: new Logger('test-dead') },
        { provide: ConfigService, useValue: new ConfigService() },
        {
          provide: InventoryService,
          useValue: { createForProduct: jest.fn() },
        },
      ],
    }).compile();
    try {
      const deadService = deadModule.get<ProductsService>(ProductsService);
      productsRepo.findAndCount.mockResolvedValue([[liveProduct], 1]);
      const served = await deadService.findAll({ page: 2, limit: 10 });
      expect(served).toEqual(
        expect.objectContaining({
          meta: expect.objectContaining({ totalItems: 1 }),
        }),
      );
    } finally {
      await deadModule.close();
    }
  });
});
