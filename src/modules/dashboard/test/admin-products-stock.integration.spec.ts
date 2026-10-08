/**
 * Admin stock adjustment on real PostgreSQL (019 US3, T017).
 * Proves adjust up/down, 409-with-stock-unchanged, and concurrent
 * same-product adjusts keep guards intact with no reservedAmount
 * corruption (both 200; no exact final-stock assertion — lock-free
 * delegates are last-writer-wins by design, research D3).
 * Skips cleanly without PG; CI with infra up provides the live proof.
 */
import * as dotenv from 'dotenv';
import { DataSource } from 'typeorm';
import { RefreshToken } from '../../auth/entities/refresh-token.entity';
import { Cart } from '../../cart/entities/cart.entity';
import { CartItem } from '../../cart/entities/cart-items.entity';
import { Product } from '../../products/entities/product.entity';
import { Inventory } from '../../inventory/entities/inventory.entity';
import { InventoryService } from '../../inventory/inventory.service';
import { Order } from '../../order/entities/order.entity';
import { OrderItem } from '../../order/entities/order-items.entity';
import { ProductsService } from '../../products/products.service';
import { Reservation } from '../../reservation/entities/reservation.entity';
import { ReservationItem } from '../../reservation/entities/reservation-item.entity';
import User from '../../users/entity/user.entity';

dotenv.config();

describe('AdminProducts stock adjust (real PostgreSQL)', () => {
  let dashboardDataSource: DataSource;
  let inventoryService: InventoryService;
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
      inventoryService = new InventoryService(
        dashboardDataSource.getRepository(Inventory),
        {} as ProductsService,
      );
    } catch (integrationError) {
      testsEnabled = false;
      console.warn(
        'AdminProducts stock integration tests skipped — PG not available',
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

  /** Seeds one product with fixed stock and reserved hold. */
  async function seedStock(
    label: string,
    stock: number,
    reservedAmount: number,
  ): Promise<string> {
    const productRepo = dashboardDataSource.getRepository(Product);
    const inventoryRepo = dashboardDataSource.getRepository(Inventory);
    const suffix = `${Date.now()}-${createdProductIds.length}`;
    const product = await productRepo.save({
      name: `${label}-${suffix}`,
      slug: `admin-stock-${label.toLowerCase()}-${suffix}`,
      description: `${label} fixture`,
      price: 100,
    });
    createdProductIds.push(product.id);
    await inventoryRepo.save({
      productId: product.id,
      stock,
      reservedAmount,
    });
    return product.id;
  }

  async function readStock(productId: string): Promise<Inventory> {
    return dashboardDataSource
      .getRepository(Inventory)
      .findOneByOrFail({ productId });
  }

  it('adjusts up and down with recalculated availability', async () => {
    if (!testsEnabled) return;
    const productId = await seedStock('Adjust', 10, 2);

    const up = await inventoryService.adjustStockByDelta(productId, 5);
    expect(up.stock).toBe(15);
    expect(up.available).toBe(13);

    const down = await inventoryService.adjustStockByDelta(productId, -3);
    expect(down.stock).toBe(12);
    expect(down.available).toBe(10);
  });

  it('rejects below-reserved and below-zero adjusts with stock unchanged', async () => {
    if (!testsEnabled) return;
    const productId = await seedStock('Guarded', 5, 5);

    await expect(
      inventoryService.adjustStockByDelta(productId, -1),
    ).rejects.toMatchObject({ status: 409 });
    expect((await readStock(productId)).stock).toBe(5);

    await expect(
      inventoryService.adjustStockByDelta(productId, -999),
    ).rejects.toMatchObject({ status: 409 });
    expect((await readStock(productId)).stock).toBe(5);
  });

  it('keeps guards intact under concurrent same-product adjusts', async () => {
    if (!testsEnabled) return;
    const productId = await seedStock('Racy', 10, 2);

    const outcomes = await Promise.all([
      inventoryService.adjustStockByDelta(productId, 4),
      inventoryService.adjustStockByDelta(productId, 4),
    ]);

    // Both writes succeed (last-writer-wins); neither corrupts the hold.
    expect(outcomes).toHaveLength(2);
    const final = await readStock(productId);
    expect(final.reservedAmount).toBe(2);
    expect(final.stock).toBeGreaterThanOrEqual(10);
    expect(final.stock - final.reservedAmount).toBeGreaterThanOrEqual(0);
  });
});
