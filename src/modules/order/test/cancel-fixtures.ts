/**
 * This module provides shared fixtures for cancel-flow tests on real PostgreSQL.
 * It builds a PENDING order with a RESERVED reservation and held inventory,
 * mirroring the checkout transaction without HTTP overhead.
 *
 * Responsibility (SRP): cancel-test doubles and data setup/teardown only.
 * Used by: order-cancel unit/integration/concurrency specs (Phase 8).
 */
import * as dotenv from 'dotenv';
import { DataSource, EntityManager, EntityTarget, In } from 'typeorm';
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
import { OutboxEvent } from '../../outbox/entities/outbox-event.entity';
import { UserRoles } from '../../users/enum/roles';

dotenv.config();

/** One held line: product sold, inventory row holding the reservation. */
export interface FixtureHeldLine {
  product: Product;
  inventory: Inventory;
  quantity: number;
}

/** Complete cancel fixture: owner, order, reservation, held lines. */
export interface CancelFixture {
  fixtureUser: User;
  fixtureOrder: Order;
  fixtureReservation: Reservation;
  fixtureLines: FixtureHeldLine[];
}

/** Typed repository stub for unit tests (explicit mocks, no `any`). */
export interface UnitRepositoryStub {
  findOne: jest.Mock;
  save: jest.Mock;
}

/** Typed EntityManager stub implementing the subset cancel uses. */
export interface UnitManagerStub {
  getRepository: jest.Mock;
  find: jest.Mock;
  manager: EntityManager;
}

/**
 * Creates a repository stub with echo-save default.
 *
 * @returns Repository stub whose save echoes its input by default.
 */
export function createUnitRepositoryStub(): UnitRepositoryStub {
  return {
    findOne: jest.fn(),
    save: jest.fn((entityToSave: unknown) => entityToSave),
  };
}

/**
 * Creates an EntityManager stub serving repositories by entity name.
 *
 * @param repositoriesByName - Repository stubs keyed by entity class name.
 * @param findResult - Value resolved by the stubbed find (inventory rows).
 * @returns GetRepository/find mocks plus the stubbed manager.
 */
export function createUnitManagerStub(
  repositoriesByName: Record<string, UnitRepositoryStub>,
  inventoryRows: unknown[] = [],
): UnitManagerStub {
  const fallbackStub = repositoriesByName[Order.name];
  const getRepository = jest.fn((entity: EntityTarget<unknown>) => {
    if (typeof entity === 'string') {
      return repositoriesByName[entity] ?? fallbackStub;
    }
    if (typeof entity === 'function') {
      return repositoriesByName[entity.name] ?? fallbackStub;
    }
    return fallbackStub;
  });
  // Cancel looks up locked inventories via manager.find(Inventory, ...).
  const find = jest.fn().mockResolvedValue(inventoryRows);
  // Single assertion: the stub implements exactly the EntityManager subset
  // the cancel flow uses (getRepository + find); verified by the specs.
  const manager = { getRepository, find } as unknown as EntityManager;
  return { getRepository, find, manager };
}

let fixtureSequence = 0;

/** Returns a unique suffix for test emails/names within one run. */
function nextFixtureSuffix(label: string): string {
  fixtureSequence += 1;
  return `${label}-${Date.now()}-${fixtureSequence}`;
}

/**
 * Creates an initialized DataSource for cancel tests (real PostgreSQL).
 *
 * @returns Initialized DataSource with order-domain entities registered.
 */
export async function createCancelTestDataSource(): Promise<DataSource> {
  const cancelTestDataSource = new DataSource({
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
      OutboxEvent,
    ],
  });
  await cancelTestDataSource.initialize();
  return cancelTestDataSource;
}

/**
 * Removes cancel-domain rows (child tables first for FK safety).
 *
 * @param cancelTestDataSource - Initialized test DataSource.
 */
export async function truncateCancelTables(
  cancelTestDataSource: DataSource,
): Promise<void> {
  await cancelTestDataSource.query(`DELETE FROM "outbox_event"`).catch(() => {
    // Outbox table may be absent on stale schemas; business rows still clear.
  });
  await cancelTestDataSource
    .query(`DELETE FROM "reservation_item"`)
    .catch(() => undefined);
  await cancelTestDataSource
    .query(`DELETE FROM "reservation"`)
    .catch(() => undefined);
  await cancelTestDataSource
    .query(`DELETE FROM "order_item"`)
    .catch(() => undefined);
  await cancelTestDataSource
    .query(`DELETE FROM "order"`)
    .catch(() => undefined);
}

/**
 * Creates a fixture user with a unique email.
 *
 * @param cancelTestDataSource - Initialized test DataSource.
 * @param userRole - Role for the user (default regular shopper).
 * @returns Saved User row.
 */
export async function createFixtureUser(
  cancelTestDataSource: DataSource,
  userRole: UserRoles = UserRoles.User,
): Promise<User> {
  const userRepository = cancelTestDataSource.getRepository(User);
  const fixtureUser = userRepository.create({
    firstName: 'Cancel',
    lastName: 'Fixture',
    email: `order-cancel-${nextFixtureSuffix('user')}@test.com`,
    password: 'hashed-fixture-password',
    role: userRole,
  });
  return userRepository.save(fixtureUser);
}

/**
 * Creates a product with a stocked inventory row.
 *
 * @param cancelTestDataSource - Initialized test DataSource.
 * @param unitPrice - Snapshot price for the product.
 * @param stockOnHand - Initial stock (reserved starts at 0).
 * @returns Saved product and inventory rows.
 */
export async function createFixtureProductWithInventory(
  cancelTestDataSource: DataSource,
  unitPrice: number,
  stockOnHand: number,
): Promise<{ fixtureProduct: Product; fixtureInventory: Inventory }> {
  const productRepository = cancelTestDataSource.getRepository(Product);
  const inventoryRepository = cancelTestDataSource.getRepository(Inventory);
  const fixtureSuffix = nextFixtureSuffix('product');
  const fixtureProduct = await productRepository.save(
    productRepository.create({
      name: `CancelProduct-${fixtureSuffix}`,
      slug: `cancel-product-${fixtureSuffix}`,
      description: 'cancel fixture product',
      price: unitPrice,
    }),
  );
  const fixtureInventory = await inventoryRepository.save(
    inventoryRepository.create({
      productId: fixtureProduct.id,
      stock: stockOnHand,
      reservedAmount: 0,
    }),
  );
  return { fixtureProduct, fixtureInventory };
}

/**
 * Checks out a PENDING order with a RESERVED reservation (holds inventory).
 * Mirrors the checkout transaction: sorted FOR UPDATE locks, availability
 * check, reservedAmount increment, order + items + reservation inserts.
 *
 * @param cancelTestDataSource - Initialized test DataSource.
 * @param fixtureUser - Owner of the order.
 * @param fixtureLines - Held lines (product + inventory + quantity).
 * @returns Saved order, reservation with items, and echo of inputs.
 */
export async function checkoutFixtureOrder(
  cancelTestDataSource: DataSource,
  fixtureUser: User,
  fixtureLines: FixtureHeldLine[],
): Promise<CancelFixture> {
  return cancelTestDataSource.transaction(async (manager) => {
    const orderRepository = manager.getRepository(Order);
    const orderItemRepository = manager.getRepository(OrderItem);
    const inventoryRepository = manager.getRepository(Inventory);
    const reservationRepository = manager.getRepository(Reservation);
    const reservationItemRepository = manager.getRepository(ReservationItem);

    // Deterministic lock ordering prevents deadlocks on multi-line checkouts.
    const sortedInventoryIds = [
      ...new Set(fixtureLines.map((line) => line.inventory.id)),
    ].sort();
    const lockedInventories = await manager.find(Inventory, {
      where: { id: In(sortedInventoryIds) },
      lock: { mode: 'pessimistic_write' },
    });
    const inventoryById = new Map(
      lockedInventories.map((inventoryRow) => [inventoryRow.id, inventoryRow]),
    );
    let fixtureTotal = 0;
    for (const fixtureLine of fixtureLines) {
      const lockedInventory = inventoryById.get(fixtureLine.inventory.id);
      if (!lockedInventory) {
        throw new Error(
          `Fixture inventory ${fixtureLine.inventory.id} not found`,
        );
      }
      // Available excludes already-reserved units to prevent overselling.
      const availableUnits =
        lockedInventory.stock - lockedInventory.reservedAmount;
      if (availableUnits < fixtureLine.quantity) {
        throw new Error(
          `Fixture insufficient stock for ${fixtureLine.inventory.id}`,
        );
      }
      lockedInventory.reservedAmount += fixtureLine.quantity;
      await inventoryRepository.save(lockedInventory);
      // Order total is server-calculated: sum of quantity * snapshot price.
      fixtureTotal += fixtureLine.quantity * fixtureLine.product.price;
    }

    const fixtureOrder = await orderRepository.save(
      orderRepository.create({
        userId: fixtureUser.id,
        status: OrderStatus.PENDING,
        total: fixtureTotal,
      }),
    );
    for (const fixtureLine of fixtureLines) {
      await orderItemRepository.save(
        orderItemRepository.create({
          orderId: fixtureOrder.id,
          productId: fixtureLine.product.id,
          quantity: fixtureLine.quantity,
          unit_price: fixtureLine.product.price,
          productNameSnapshot: fixtureLine.product.name,
        }),
      );
    }
    const fixtureReservation = await reservationRepository.save(
      reservationRepository.create({
        userId: fixtureUser.id,
        orderId: fixtureOrder.id,
        status: ReservationStatus.RESERVED,
        // Reservation TTL mirrors checkout: now + 15 minutes.
        expiresAt: new Date(Date.now() + 15 * 60 * 1000),
      }),
    );
    for (const fixtureLine of fixtureLines) {
      await reservationItemRepository.save(
        reservationItemRepository.create({
          reservationId: fixtureReservation.id,
          inventoryId: fixtureLine.inventory.id,
          quantity: fixtureLine.quantity,
        }),
      );
    }
    const reservationWithItems = await reservationRepository.findOne({
      where: { id: fixtureReservation.id },
      relations: { items: true },
    });
    if (!reservationWithItems) {
      throw new Error(
        `Fixture reservation ${fixtureReservation.id} not found after save`,
      );
    }
    return {
      fixtureUser,
      fixtureOrder,
      fixtureReservation: reservationWithItems,
      fixtureLines,
    };
  });
}
