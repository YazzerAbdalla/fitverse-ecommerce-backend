/**
 * Admin product list round-trip on real PostgreSQL (019 US1, T008).
 * Seeds products at every stock level (plus one orphan with no
 * inventory row) and proves threshold override, combined filters,
 * status-filter totalItems, case-insensitive search, and meta.
 * Skips cleanly without PG (docker daemon down locally); CI with
 * infra up provides the live proof.
 */
import * as dotenv from 'dotenv';
import { DataSource } from 'typeorm';
import { Product } from '../../products/entities/product.entity';
import { Inventory } from '../../inventory/entities/inventory.entity';
import { AdminProductsService } from '../admin-products.service';

dotenv.config();

describe('AdminProducts list (real PostgreSQL)', () => {
  let dashboardDataSource: DataSource;
  let service: AdminProductsService;
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
        entities: [Product, Inventory],
      });
      await dashboardDataSource.initialize();
      service = new AdminProductsService(dashboardDataSource);
    } catch (integrationError) {
      testsEnabled = false;
      console.warn(
        'AdminProducts integration tests skipped — PG not available',
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

  /** Seeds one product with fixed inventory (reserved 0 unless given). */
  async function seedProduct(
    name: string,
    price: number,
    stock: number | null,
    reservedAmount = 0,
  ): Promise<string> {
    const productRepo = dashboardDataSource.getRepository(Product);
    const inventoryRepo = dashboardDataSource.getRepository(Inventory);
    const suffix = `${Date.now()}-${createdProductIds.length}`;
    const product = await productRepo.save({
      name: `${name}-${suffix}`,
      slug: `admin-list-${name.toLowerCase()}-${suffix}`,
      description: `${name} fixture`,
      price,
    });
    createdProductIds.push(product.id);
    if (stock !== null) {
      await inventoryRepo.save({
        productId: product.id,
        stock,
        reservedAmount,
      });
    }
    return product.name;
  }

  it('lists every stock level with correct statuses', async () => {
    if (!testsEnabled) return;
    const plenty = await seedProduct('Plenty', 100, 10);
    const low = await seedProduct('Lowish', 100, 3);
    const gone = await seedProduct('Gone', 100, 0);
    const orphan = await seedProduct('Orphan', 100, null);

    const { data } = await service.listAdminProducts({
      search: 'plenty-',
      limit: 100,
    });
    expect(data).toHaveLength(1);
    expect(data[0]).toMatchObject({ name: plenty, status: 'in-stock' });

    const lowRows = await service.listAdminProducts({
      search: low,
      limit: 100,
    });
    expect(lowRows.data[0]).toMatchObject({
      available: 3,
      status: 'low-stock',
    });

    const goneRows = await service.listAdminProducts({
      search: gone,
      limit: 100,
    });
    expect(goneRows.data[0]).toMatchObject({
      available: 0,
      status: 'out-of-stock',
    });

    const orphanRows = await service.listAdminProducts({
      search: orphan,
      limit: 100,
    });
    expect(orphanRows.data[0]).toMatchObject({
      stock: 0,
      reservedAmount: 0,
      available: 0,
      status: 'out-of-stock',
    });
  });

  it('honors the threshold override and status filter with correct totals', async () => {
    if (!testsEnabled) return;
    await seedProduct('ThreshA', 50, 3);
    await seedProduct('ThreshB', 50, 10);

    const strict = await service.listAdminProducts({
      search: 'thresha-',
      lowThreshold: 2,
      limit: 100,
    });
    expect(strict.data[0]?.status).toBe('in-stock');

    const filtered = await service.listAdminProducts({
      status: 'low-stock',
      minPrice: 0,
      maxPrice: 60,
      limit: 100,
    });
    expect(filtered.data.every((row) => row.status === 'low-stock')).toBe(true);
    expect(filtered.meta.totalItems).toBe(filtered.data.length);
  });

  it('searches case-insensitively and paginates with meta', async () => {
    if (!testsEnabled) return;
    const name = await seedProduct('CaseMix', 20, 8);

    const upper = await service.listAdminProducts({
      search: name.toUpperCase().slice(0, 12),
      limit: 100,
    });
    expect(upper.data.length).toBeGreaterThanOrEqual(1);

    const paged = await service.listAdminProducts({ page: 1, limit: 1 });
    expect(paged.meta).toMatchObject({
      itemCount: 1,
      itemsPerPage: 1,
      currentPage: 1,
    });
    expect(paged.meta.totalItems).toBeGreaterThanOrEqual(1);
    expect(paged.meta.totalPages).toBe(paged.meta.totalItems);
  });
});
