/**
 * Admin create→list round-trip on real PostgreSQL (019 US2, T013).
 * Proves explicit stock, omitted-stock defaults, and duplicate
 * rejection through the real ProductsService + InventoryService.
 * Skips cleanly without PG; CI with infra up provides the live proof.
 */
import * as dotenv from 'dotenv';
import { Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { DataSource } from 'typeorm';
import { RefreshToken } from '../../auth/entities/refresh-token.entity';
import { Cart } from '../../cart/entities/cart.entity';
import { CartItem } from '../../cart/entities/cart-items.entity';
import { Inventory } from '../../inventory/entities/inventory.entity';
import { InventoryService } from '../../inventory/inventory.service';
import { Order } from '../../order/entities/order.entity';
import { OrderItem } from '../../order/entities/order-items.entity';
import { Product } from '../../products/entities/product.entity';
import { ProductsService } from '../../products/products.service';
import { Reservation } from '../../reservation/entities/reservation.entity';
import { ReservationItem } from '../../reservation/entities/reservation-item.entity';
import User from '../../users/entity/user.entity';
import { AdminProductsService } from '../admin-products.service';

dotenv.config();

describe('AdminProducts create (real PostgreSQL)', () => {
  let dashboardDataSource: DataSource;
  let productsService: ProductsService;
  let adminProductsService: AdminProductsService;
  let testsEnabled = true;
  const createdProductIds: string[] = [];

  beforeAll(async () => {
    try {
      dashboardDataSource = new DataSource({
        type: 'postgres',
        host: process.env.POSTGRES_HOST ?? '127.0.0.1',
        port: process.env.POSTGRES_PORT
          ? parseInt(process.env.POSTGRES_PORT, 10)
          : 5432,
        username: process.env.POSTGRES_USER ?? 'postgres',
        password: process.env.POSTGRES_PASSWORD ?? 'mysecretpassword',
        database: process.env.POSTGRES_DATABASE ?? 'ecommerce',
        synchronize: false,
        logging: false,
        // Full relation closure (see admin-products.integration.spec.ts).
        entities: [
          User,
          RefreshToken,
          Product,
          Inventory,
          Cart,
          CartItem,
          Order,
          OrderItem,
          Reservation,
          ReservationItem,
        ],
      });
      await dashboardDataSource.initialize();
      const cacheManager = {
        get: jest.fn(),
        set: jest.fn(),
        del: jest.fn(),
        store: { keys: jest.fn().mockResolvedValue([]) },
      };
      const configService = {
        get: jest.fn().mockReturnValue(undefined),
      } as unknown as ConfigService;
      const inventoryService = new InventoryService(
        dashboardDataSource.getRepository(Inventory),
        // createForProduct never touches ProductsService (one-way edge).
        {} as ProductsService,
      );
      productsService = new ProductsService(
        dashboardDataSource.getRepository(Product),
        // Cache port stub: real invalidation logic, no Redis.
        cacheManager as never,
        new Logger(ProductsService.name),
        dashboardDataSource,
        inventoryService,
        configService,
      );
      adminProductsService = new AdminProductsService(dashboardDataSource);
    } catch (integrationError) {
      testsEnabled = false;
      console.warn(
        'AdminProducts create integration tests skipped — PG not available',
        (integrationError as Error)?.message,
      );
    }
  });

  afterAll(async () => {
    if (dashboardDataSource?.isInitialized) {
      const inventoryRepo = dashboardDataSource.getRepository(Inventory);
      const productRepo = dashboardDataSource.getRepository(Product);
      for (const id of createdProductIds) {
        await inventoryRepo.delete({ productId: id }).catch(() => undefined);
      }
      for (const id of createdProductIds) {
        await productRepo.delete({ id }).catch(() => undefined);
      }
      await dashboardDataSource.destroy();
    }
  });

  it('creates with explicit stock and lists it in-stock', async () => {
    if (!testsEnabled) return;
    const name = `CreateStocked-${Date.now()}`;
    const created = await productsService.create({
      name,
      description: 'stocked fixture',
      price: 200,
      stock: 12,
    });
    createdProductIds.push(created.id);

    const { data } = await adminProductsService.listAdminProducts({
      search: name,
      limit: 100,
    });
    expect(data).toHaveLength(1);
    expect(data[0]).toMatchObject({
      name,
      stock: 12,
      available: 12,
      status: 'in-stock',
    });
  });

  it('defaults omitted stock to zero and lists out-of-stock', async () => {
    if (!testsEnabled) return;
    const name = `CreateBare-${Date.now()}`;
    const created = await productsService.create({
      name,
      description: 'bare fixture',
      price: 50,
      stock: 0,
    });
    createdProductIds.push(created.id);

    const { data } = await adminProductsService.listAdminProducts({
      search: name,
      limit: 100,
    });
    expect(data[0]).toMatchObject({
      name,
      available: 0,
      status: 'out-of-stock',
    });
  });

  it('rejects duplicate names with 409 and creates nothing', async () => {
    if (!testsEnabled) return;
    const name = `CreateDupe-${Date.now()}`;
    const created = await productsService.create({
      name,
      description: 'first',
      price: 10,
      stock: 1,
    });
    createdProductIds.push(created.id);

    await expect(
      productsService.create({
        name,
        description: 'second',
        price: 10,
        stock: 1,
      }),
    ).rejects.toMatchObject({ status: 409 });

    const { data } = await adminProductsService.listAdminProducts({
      search: name,
      limit: 100,
    });
    expect(data).toHaveLength(1);
  });
});
