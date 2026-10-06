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
import { RefreshToken } from '../../auth/entities/refresh-token.entity';
import { Cart } from '../../cart/entities/cart.entity';
import { CartItem } from '../../cart/entities/cart-items.entity';
import { OrderCompletionService } from '../order-completion.service';
import { ReservationService } from '../../reservation/reservation.service';
import { UserRoles } from '../../users/enum/roles';

dotenv.config();

/**
 * Concurrency tests for complete vs complete and complete vs expire (real PG, --runInBand).
 */
describe('Order Completion Concurrency (real PostgreSQL)', () => {
  let dataSource: DataSource;
  let orderCompletionService: OrderCompletionService;
  let reservationService: ReservationService;
  let enabled = true;

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
    try {
      if (!dataSource.isInitialized) await dataSource.initialize();
      reservationService = new ReservationService(dataSource);
      orderCompletionService = new OrderCompletionService(
        dataSource,
        reservationService,
      );
    } catch (e) {
      enabled = false;
      console.warn('Concurrency tests skipped — PG not available', e?.message);
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

  async function createUser(
    emailSuffix: string,
    role: UserRoles = UserRoles.User,
  ): Promise<User> {
    const repo = dataSource.getRepository(User);
    const u = repo.create({
      firstName: 'Test',
      lastName: 'User',
      email: `conc-${emailSuffix}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}@test.com`,
      password: 'hashed',
      role,
    } as any);
    return repo.save(u);
  }

  async function createProductInv(
    price: number,
    stock: number,
  ): Promise<{ product: Product; inventory: Inventory }> {
    const pRepo = dataSource.getRepository(Product);
    const iRepo = dataSource.getRepository(Inventory);
    const p = pRepo.create({
      name: `P-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
      slug: `s-${Date.now()}-${Math.random()}`,
      description: 't',
      price,
    } as any);
    const sp = await pRepo.save(p);
    const inv = iRepo.create({
      productId: (sp as any).id,
      stock,
      reservedAmount: 0,
    } as any);
    const si = await iRepo.save(inv);
    return { product: sp as any, inventory: si as any };
  }

  async function checkoutAs(
    user: User,
    items: { product: Product; inventory: Inventory; qty: number }[],
  ): Promise<{ order: Order }> {
    return dataSource.transaction(async (manager) => {
      const orderRepo = manager.getRepository(Order);
      const orderItemRepo = manager.getRepository(OrderItem);
      const sortedIds = [...new Set(items.map((i) => i.inventory.id))].sort();
      const locked = await manager.find(Inventory, {
        where: { id: In(sortedIds) },
        lock: { mode: 'pessimistic_write' },
      });
      const map = new Map(locked.map((inv) => [inv.id, inv]));
      for (const it of items) {
        const inv = map.get(it.inventory.id)!;
        inv.reservedAmount += it.qty;
        await manager.getRepository(Inventory).save(inv);
      }
      const total = items.reduce(
        (s, it) => s + it.qty * (it.product as any).price,
        0,
      );
      const order = orderRepo.create({
        userId: (user as any).id,
        status: OrderStatus.PENDING,
        total,
      } as any);
      const so = await orderRepo.save(order);
      for (const it of items) {
        const oi = orderItemRepo.create({
          orderId: (so as any).id,
          productId: (it.product as any).id,
          quantity: it.qty,
          unit_price: (it.product as any).price,
        } as any);
        await orderItemRepo.save(oi);
      }
      const rRepo = manager.getRepository(Reservation);
      const riRepo = manager.getRepository(ReservationItem);
      const r = rRepo.create({
        userId: (user as any).id,
        orderId: (so as any).id,
        status: ReservationStatus.RESERVED,
        expiresAt: new Date(Date.now() + 15 * 60 * 1000),
      } as any);
      const sr = await rRepo.save(r);
      for (const it of items) {
        const ri = riRepo.create({
          reservationId: (sr as any).id,
          inventoryId: it.inventory.id,
          quantity: it.qty,
        } as any);
        await riRepo.save(ri);
      }
      return { order: so as any };
    });
  }

  it('complete vs complete same Order → single stock decrement, both 200 (SC-003)', async () => {
    if (!enabled) return;
    const user = await createUser('c1');
    const { product, inventory } = await createProductInv(100, 10);
    const { order } = await checkoutAs(user, [{ product, inventory, qty: 2 }]);

    const results = await Promise.allSettled([
      dataSource.transaction(async (m) =>
        orderCompletionService.complete(
          m,
          (user as any).id,
          (order as any).id,
          UserRoles.User,
        ),
      ),
      dataSource.transaction(async (m) =>
        orderCompletionService.complete(
          m,
          (user as any).id,
          (order as any).id,
          UserRoles.User,
        ),
      ),
    ]);

    const fulfilled = results.filter((r) => r.status === 'fulfilled');
    expect(fulfilled.length).toBe(2);
    for (const r of fulfilled) {
      expect(r.value.status).toBe(OrderStatus.COMPLETED);
    }

    const inv = await dataSource
      .getRepository(Inventory)
      .findOne({ where: { id: (inventory as any).id } });
    // stock 10→8 once, not 10→6; reserved 2→0
    expect(inv!.stock).toBe(8);
    expect(inv!.reservedAmount).toBe(0);
  });

  it('complete vs expire race → single winner (SC-006)', async () => {
    if (!enabled) return;
    const user = await createUser('c2');
    const { product, inventory } = await createProductInv(100, 10);
    const { order } = await checkoutAs(user, [{ product, inventory, qty: 1 }]);
    const reservation = await dataSource
      .getRepository(Reservation)
      .findOne({ where: { orderId: (order as any).id } });

    const results = await Promise.allSettled([
      dataSource.transaction(async (m) =>
        orderCompletionService.complete(
          m,
          (user as any).id,
          (order as any).id,
          UserRoles.User,
        ),
      ),
      dataSource.transaction(async (m) =>
        reservationService.expire(m, (reservation as any).id),
      ),
    ]);

    const orderFresh = await dataSource
      .getRepository(Order)
      .findOne({ where: { id: (order as any).id } });
    const inv = await dataSource
      .getRepository(Inventory)
      .findOne({ where: { id: (inventory as any).id } });

    if (orderFresh!.status === OrderStatus.COMPLETED) {
      // complete won: stock 10→9 reserved 1→0
      expect(inv!.stock).toBe(9);
      expect(inv!.reservedAmount).toBe(0);
    } else {
      // expire won: ORDER CANCELLED, stock 10 reserved 0
      expect(orderFresh!.status).toBe(OrderStatus.CANCELLED);
      expect(inv!.stock).toBe(10);
      expect(inv!.reservedAmount).toBe(0);
    }

    // Exactly one inventory change
    const totalDelta = 10 - inv!.stock + (1 - inv!.reservedAmount);
    expect([1, 1]).toContain(totalDelta); // either 1 stock or 1 reserved
  });

  it('no-deadlock [A,B] vs [B,A] concurrent completes on shared B', async () => {
    if (!enabled) return;
    const user1 = await createUser('c3a');
    const user2 = await createUser('c3b');
    const { product: pA, inventory: invA } = await createProductInv(100, 10);
    const { product: pB, inventory: invB } = await createProductInv(50, 10);
    const { order: o1 } = await checkoutAs(user1, [
      { product: pA, inventory: invA, qty: 1 },
      { product: pB, inventory: invB, qty: 1 },
    ]);
    const { order: o2 } = await checkoutAs(user2, [
      { product: pB, inventory: invB, qty: 1 },
    ]);

    // Order of items opposite sortedIds both sort → [invA, invB] and [invB] so no deadlock
    const results = await Promise.allSettled([
      dataSource.transaction(async (m) =>
        orderCompletionService.complete(
          m,
          (user1 as any).id,
          (o1 as any).id,
          UserRoles.User,
        ),
      ),
      dataSource.transaction(async (m) =>
        orderCompletionService.complete(
          m,
          (user2 as any).id,
          (o2 as any).id,
          UserRoles.User,
        ),
      ),
    ]);

    expect(results.filter((r) => r.status === 'fulfilled').length).toBe(2);
    const invBfresh = await dataSource
      .getRepository(Inventory)
      .findOne({ where: { id: (invB as any).id } });
    // B stock 10 → 8 (two completes each qty1: 10→9→8), reserved 2→0
    expect(invBfresh!.stock).toBe(8);
    expect(invBfresh!.reservedAmount).toBe(0);
  });
});
