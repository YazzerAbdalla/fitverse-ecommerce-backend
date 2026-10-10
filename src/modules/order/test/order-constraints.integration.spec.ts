import { DataSource } from 'typeorm';
import { OrderStatus } from '../order-status.enum';
import { Order } from '../entities/order.entity';
import { Product } from '../../products/entities/product.entity';
import { Inventory } from '../../inventory/entities/inventory.entity';
import User, { AuthProvider } from '../../users/entity/user.entity';
import { UserRoles } from '../../users/enum/roles';

/**
 * Database backstop proofs for 020-cache-constraints-indexes on real PostgreSQL.
 * Verifies the new `Product.price` check, re-proves neighboring checks, and
 * asserts the audit-approved indexes exist and serve the hot paths.
 * Skips gracefully when PostgreSQL is unreachable.
 */
describe('Order constraints integration (real PostgreSQL)', () => {
  let dataSource: DataSource;
  let pgAvailable = false;

  const uniqueSuffix = (): string =>
    `020${Date.now().toString(36)}${Math.floor(Math.random() * 1e6)}`;

  beforeAll(async () => {
    dataSource = new DataSource({
      type: 'postgres',
      host: process.env.POSTGRES_HOST || '127.0.0.1',
      port: process.env.POSTGRES_PORT
        ? parseInt(process.env.POSTGRES_PORT, 10)
        : 5432,
      username: process.env.POSTGRES_USER || 'postgres',
      password: process.env.POSTGRES_PASSWORD || 'mysecretpassword',
      database: process.env.POSTGRES_DATABASE || 'ecommerce',
      synchronize: false,
      logging: false,
      entities: [User, Product, Inventory, Order],
    });
    try {
      await dataSource.initialize();
      pgAvailable = true;
    } catch (initializationError: unknown) {
      pgAvailable = false;
      const reason =
        initializationError instanceof Error
          ? initializationError.message
          : String(initializationError);
      console.warn(
        'Order constraints integration tests skipped — PG not available',
        reason,
      );
    }
  });

  afterAll(async () => {
    if (dataSource?.isInitialized) {
      await dataSource.destroy();
    }
  });

  it('rejects negative product price with no partial row (T017 SC-003)', async () => {
    if (!pgAvailable) return;
    const productName = `NegPrice-${uniqueSuffix()}`;
    await expect(
      dataSource.getRepository(Product).save({
        name: productName,
        slug: productName.toLowerCase(),
        description: 'negative price probe',
        price: -1,
      }),
    ).rejects.toMatchObject({ code: '23514' });
    const persisted = await dataSource
      .getRepository(Product)
      .findOne({ where: { name: productName } });
    expect(persisted).toBeNull();
  });

  it('rejects negative order total and negative stock with no partial rows (T017 SC-003)', async () => {
    if (!pgAvailable) return;
    const email = `neg-total-${uniqueSuffix()}@test.com`;
    const owner = await dataSource.getRepository(User).save({
      firstName: 'Neg',
      lastName: 'Total',
      email,
      password: 'Password123!',
      role: UserRoles.User,
      provider: AuthProvider.Local,
    });
    try {
      await expect(
        dataSource.getRepository(Order).save({
          userId: owner.id,
          status: OrderStatus.PENDING,
          total: -5,
        }),
      ).rejects.toMatchObject({ code: '23514' });

      const stockProductName = `NegStock-${uniqueSuffix()}`;
      const stockProduct = await dataSource.getRepository(Product).save({
        name: stockProductName,
        slug: stockProductName.toLowerCase(),
        description: 'stock probe',
        price: 10,
      });
      try {
        await expect(
          dataSource.getRepository(Inventory).save({
            productId: stockProduct.id,
            stock: -1,
            reservedAmount: 0,
          }),
        ).rejects.toMatchObject({ code: '23514' });
      } finally {
        await dataSource.getRepository(Product).delete(stockProduct.id);
      }
    } finally {
      await dataSource.getRepository(User).delete(owner.id);
    }
  });

  it('audit-approved indexes exist on order + reservation (T018 SC-004)', async () => {
    if (!pgAvailable) return;
    const indexRows: Array<{ indexname: string }> = await dataSource.query(
      `SELECT indexname FROM pg_indexes WHERE tablename IN ('order', 'reservation', 'inventory')`,
    );
    const indexNames = indexRows.map((indexRow) => indexRow.indexname);
    expect(indexNames).toEqual(
      expect.arrayContaining([
        'IDX_order_status_createdAt',
        'IDX_order_userId_createdAt',
      ]),
    );
  });

  it('hot paths use the supporting indexes (T018 SC-004)', async () => {
    if (!pgAvailable) return;
    const revenuePlan: Array<{ [planLine: string]: string }> =
      await dataSource.transaction(async (manager) => {
        // Force index consideration: dev/CI tables are tiny enough for seq scans otherwise
        await manager.query('SET LOCAL enable_seqscan = off');
        return manager.query(
          `EXPLAIN SELECT * FROM "order" WHERE status = 'COMPLETED'
           AND created_at BETWEEN NOW() - INTERVAL '30 days' AND NOW()`,
        );
      });
    const revenuePlanText = JSON.stringify(revenuePlan);
    expect(revenuePlanText).toContain('IDX_order_status_createdAt');

    const ownerPlan: Array<{ [planLine: string]: string }> =
      await dataSource.transaction(async (manager) => {
        await manager.query('SET LOCAL enable_seqscan = off');
        return manager.query(
          `EXPLAIN SELECT * FROM "order" WHERE "userId" = '00000000-0000-0000-0000-000000000000'
           ORDER BY created_at DESC LIMIT 10`,
        );
      });
    expect(JSON.stringify(ownerPlan)).toContain('IDX_order_userId_createdAt');
  });
});
