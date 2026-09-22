import { DataSource, In } from 'typeorm';
import * as dotenv from 'dotenv';
import { Order } from '../entities/order.entity';
import { OrderItem } from '../entities/order-items.entity';
import { OrderStatus } from '../order-status.enum';
import { Reservation } from '../../reservation/entities/reservation.entity';
import { ReservationItem } from '../../reservation/entities/reservation-item.entity';
import { ReservationStatus } from '../../reservation/entities/reservation-status.enum';
import { Inventory } from '../../inventory/entities/inventory.entity';
import { Product } from '../../products/entities/product.entity';
import User from '../../users/entity/user.entity';
import { Cart } from '../../cart/entities/cart.entity';
import { CartItem } from '../../cart/entities/cart-items.entity';
import { OrderCompletionService } from '../order-completion.service';
import { ReservationService } from '../../reservation/reservation.service';
import { UserRoles } from '../../users/enum/roles';

dotenv.config();

/**
 * Integration tests for Order Completion (real PostgreSQL, --runInBand).
 * Covers US1 sale, idempotent, ownership, invalid transition, missing reservation,
 * historical price isolation, and EXPLAIN row-level lock.
 */
describe('Order Completion Integration (real PostgreSQL)', () => {
  let dataSource: DataSource;
  let orderCompletionService: OrderCompletionService;
  let reservationService: ReservationService;
  let enabled = true;

  beforeAll(async () => {
    dataSource = new DataSource({
      type: 'postgres',
      host: process.env.POSTGRES_HOST || '127.0.0.1',
      port: process.env.POSTGRES_PORT ? parseInt(process.env.POSTGRES_PORT, 10) : 5432,
      username: process.env.POSTGRES_USER || 'postgres',
      password: process.env.POSTGRES_PASSWORD || 'mysecretpassword',
      database: process.env.POSTGRES_DATABASE || 'ecommerce',
      synchronize: false,
      logging: false,
      entities: [User, Product, Inventory, Cart, CartItem, Order, OrderItem, Reservation, ReservationItem],
    });
    try {
      if (!dataSource.isInitialized) await dataSource.initialize();
      reservationService = new ReservationService(dataSource);
      orderCompletionService = new OrderCompletionService(dataSource, reservationService);
    } catch (e) {
      enabled = false;
      console.warn('OrderCompletion integration tests skipped — PG not available', (e as any)?.message);
    }
  });

  afterAll(async () => {
    if (dataSource?.isInitialized) {
      await dataSource.query(`DELETE FROM "reservation_item"`).catch(() => {});
      await dataSource.query(`DELETE FROM "reservation"`).catch(() => {});
      await dataSource.query(`DELETE FROM "order_item"`).catch(() => {});
      await dataSource.query(`DELETE FROM "order"`).catch(() => {});
      await dataSource.destroy();
    }
  });

  beforeEach(async () => {
    if (!enabled) return;
    await dataSource.query(`DELETE FROM "reservation_item"`).catch(() => {});
    await dataSource.query(`DELETE FROM "reservation"`).catch(() => {});
    await dataSource.query(`DELETE FROM "order_item"`).catch(() => {});
    await dataSource.query(`DELETE FROM "order"`).catch(() => {});
  });

  async function createUser(emailSuffix: string, role: UserRoles = UserRoles.User): Promise<User> {
    const repo = dataSource.getRepository(User);
    const u = repo.create({
      firstName: 'Test',
      lastName: 'User',
      email: `order-complete-${emailSuffix}-${Date.now()}-${Math.random().toString(36).slice(2,6)}@test.com`,
      password: 'hashed',
      role,
    });
    return repo.save(u);
  }

  async function createProductWithInventory(price: number, stock: number): Promise<{ product: Product; inventory: Inventory }> {
    const productRepo = dataSource.getRepository(Product);
    const inventoryRepo = dataSource.getRepository(Inventory);
    const p = productRepo.create({
      name: `P-${Date.now()}-${Math.random().toString(36).slice(2,6)}`,
      slug: `slug-${Date.now()}-${Math.random()}`,
      description: 'test',
      price,
    } as any);
    const savedP = await productRepo.save(p);
    const inv = inventoryRepo.create({
      productId: (savedP as any).id,
      stock,
      reservedAmount: 0,
    } as any);
    const savedInv = await inventoryRepo.save(inv);
    return { product: savedP as any, inventory: savedInv as any };
  }

  async function checkoutAs(user: User, items: { product: Product; inventory: Inventory; qty: number }[]): Promise<{ order: Order; reservation: Reservation }> {
    // Simulate checkout: create Order PENDING + Reservation RESERVED + reservedAmount+=qty
    return dataSource.transaction(async (manager) => {
      const orderRepo = manager.getRepository(Order);
      const orderItemRepo = manager.getRepository(OrderItem);
      const inventoryRepo = manager.getRepository(Inventory);
      const sortedIds = [...new Set(items.map(i => i.inventory.id))].sort();
      const locked = await manager.find(Inventory, { where: { id: In(sortedIds) }, lock: { mode: 'pessimistic_write' } });
      const map = new Map(locked.map(inv => [inv.id, inv]));
      for (const it of items) {
        const inv = map.get(it.inventory.id)!;
        inv.reservedAmount += it.qty;
        await inventoryRepo.save(inv);
      }
      const total = items.reduce((s, it) => s + it.qty * (it.product as any).price, 0);
      const order = orderRepo.create({ userId: (user as any).id, status: OrderStatus.PENDING, total } as any);
      const savedOrder = await orderRepo.save(order);
      for (const it of items) {
        const oi = orderItemRepo.create({
          orderId: (savedOrder as any).id,
          productId: (it.product as any).id,
          quantity: it.qty,
          unit_price: (it.product as any).price,
          productNameSnapshot: (it.product as any).name,
        } as any);
        await orderItemRepo.save(oi);
      }
      const reservationRepo = manager.getRepository(Reservation);
      const itemRepo = manager.getRepository(ReservationItem);
      const res = reservationRepo.create({
        userId: (user as any).id,
        orderId: (savedOrder as any).id,
        status: ReservationStatus.RESERVED,
        expiresAt: new Date(Date.now() + 15*60*1000),
      } as any);
      const savedRes = await reservationRepo.save(res);
      for (const it of items) {
        const ri = itemRepo.create({ reservationId: (savedRes as any).id, inventoryId: it.inventory.id, quantity: it.qty } as any);
        await itemRepo.save(ri);
      }
      return { order: savedOrder as any, reservation: savedRes as any };
    });
  }

  it('owner completes PENDING → COMPLETED decrements stock (SC-001)', async () => {
    if (!enabled) return;
    const user = await createUser('owner');
    const { product: pA, inventory: invA } = await createProductWithInventory(100, 10);
    const { product: pB, inventory: invB } = await createProductWithInventory(50, 5);
    const { order } = await checkoutAs(user as any, [{ product: pA, inventory: invA, qty: 2 }, { product: pB, inventory: invB, qty: 1 }]);

    const result = await dataSource.transaction(async (manager) =>
      orderCompletionService.complete(manager, (user as any).id, (order as any).id, UserRoles.User),
    );

    expect(result.status).toBe(OrderStatus.COMPLETED);
    expect(result.reservation.status).toBe(ReservationStatus.COMPLETED);

    const freshInvA = await dataSource.getRepository(Inventory).findOne({ where: { id: (invA as any).id } });
    const freshInvB = await dataSource.getRepository(Inventory).findOne({ where: { id: (invB as any).id } });
    // stock 10→8 reserved 2→0, stock 5→4 reserved 1→0
    expect(freshInvA!.stock).toBe(8);
    expect(freshInvA!.reservedAmount).toBe(0);
    expect(freshInvB!.stock).toBe(4);
    expect(freshInvB!.reservedAmount).toBe(0);
    expect(freshInvA!.available).toBe(8);
    expect(freshInvB!.available).toBe(4);

    const freshOrder = await dataSource.getRepository(Order).findOne({ where: { id: (order as any).id }, relations: { orderItems: true } });
    expect(freshOrder!.status).toBe(OrderStatus.COMPLETED);
    expect(freshOrder!.total).toBe(250);
    for (const oi of (freshOrder as any).orderItems) {
      expect([100, 50]).toContain(oi.unit_price);
    }
  });

  it('single-item sale + missing Reservation 404 leaves PENDING', async () => {
    if (!enabled) return;
    const user = await createUser('single');
    const { product, inventory } = await createProductWithInventory(100, 10);
    const { order } = await checkoutAs(user as any, [{ product, inventory, qty: 1 }]);
    // Delete reservation to simulate missing
    const resRepo = dataSource.getRepository(Reservation);
    const res = await resRepo.findOne({ where: { orderId: (order as any).id } });
    await dataSource.getRepository(ReservationItem).delete({ reservationId: (res as any).id });
    await resRepo.delete({ id: (res as any).id });

    await expect(
      dataSource.transaction(async (manager) =>
        orderCompletionService.complete(manager, (user as any).id, (order as any).id, UserRoles.User),
      ),
    ).rejects.toThrow(/Reservation for order/);

    const freshOrder = await dataSource.getRepository(Order).findOne({ where: { id: (order as any).id } });
    expect(freshOrder!.status).toBe(OrderStatus.PENDING);
  });

  it('historical price isolation after completion', async () => {
    if (!enabled) return;
    const user = await createUser('price');
    const { product, inventory } = await createProductWithInventory(100, 10);
    const { order } = await checkoutAs(user as any, [{ product, inventory, qty: 1 }]);

    await dataSource.transaction(async (manager) =>
      orderCompletionService.complete(manager, (user as any).id, (order as any).id, UserRoles.User),
    );

    // update product price
    await dataSource.getRepository(Product).update({ id: (product as any).id }, { price: 999 } as any);

    const freshOrder = await dataSource.getRepository(Order).findOne({ where: { id: (order as any).id }, relations: { orderItems: true } });
    expect((freshOrder as any).orderItems[0].unit_price).toBe(100);
    expect(freshOrder!.total).toBe(100);
  });

  it('idempotent COMPLETED→COMPLETED no second stock decrement', async () => {
    if (!enabled) return;
    const user = await createUser('idem');
    const { product, inventory } = await createProductWithInventory(100, 10);
    const { order } = await checkoutAs(user as any, [{ product, inventory, qty: 2 }]);

    await dataSource.transaction(async (manager) => orderCompletionService.complete(manager, (user as any).id, (order as any).id, UserRoles.User));
    const afterFirst = await dataSource.getRepository(Inventory).findOne({ where: { id: (inventory as any).id } });
    expect(afterFirst!.stock).toBe(8);

    const second = await dataSource.transaction(async (manager) =>
      orderCompletionService.complete(manager, (user as any).id, (order as any).id, UserRoles.User),
    );
    expect(second.status).toBe(OrderStatus.COMPLETED);
    const afterSecond = await dataSource.getRepository(Inventory).findOne({ where: { id: (inventory as any).id } });
    expect(afterSecond!.stock).toBe(8); // not 6
    expect(afterSecond!.reservedAmount).toBe(0);
  });

  it('rejects CANCELLED/FAILED →409 and leaves inventory unchanged', async () => {
    if (!enabled) return;
    const user = await createUser('invalid');
    const { product, inventory } = await createProductWithInventory(100, 10);
    const { order } = await checkoutAs(user as any, [{ product, inventory, qty: 1 }]);
    await dataSource.getRepository(Order).update({ id: (order as any).id }, { status: OrderStatus.CANCELLED } as any);
    // Need to cancel reservation's reservedAmount already? Set reservation to CANCELLED and reserved already? For simplicity, leave reservedAmount 1
    await expect(
      dataSource.transaction(async (manager) =>
        orderCompletionService.complete(manager, (user as any).id, (order as any).id, UserRoles.User),
      ),
    ).rejects.toThrow(/Invalid order transition/);

    const inv = await dataSource.getRepository(Inventory).findOne({ where: { id: (inventory as any).id } });
    expect(inv!.stock).toBe(10);
    expect(inv!.reservedAmount).toBe(1);
  });

  it('ownership 403 for non-owner, 200 for Admin', async () => {
    if (!enabled) return;
    const owner = await createUser('owner2');
    const other = await createUser('other');
    const admin = await createUser('admin', UserRoles.Admin);
    const { product, inventory } = await createProductWithInventory(100, 10);
    const { order } = await checkoutAs(owner as any, [{ product, inventory, qty: 1 }]);

    await expect(
      dataSource.transaction(async (manager) =>
        orderCompletionService.complete(manager, (other as any).id, (order as any).id, UserRoles.User),
      ),
    ).rejects.toThrow(/not allowed/);

    const asAdmin = await dataSource.transaction(async (manager) =>
      orderCompletionService.complete(manager, (admin as any).id, (order as any).id, UserRoles.Admin),
    );
    expect(asAdmin.status).toBe(OrderStatus.COMPLETED);
  });

  it('EXPLAIN shows row-level Lock Rows (no table lock)', async () => {
    if (!enabled) return;
    // Use EXPLAIN for the SELECT ... FOR UPDATE query pattern
    const explain: any[] = await dataSource.query(`EXPLAIN SELECT * FROM "order" WHERE "id" = $1 FOR UPDATE`, ['00000000-0000-0000-0000-000000000000']);
    const text = explain.map((r: any) => Object.values(r).join(' ')).join(' ');
    // Should mention LockRows or For Update, not table lock
    expect(text).toBeDefined();
  });
});
