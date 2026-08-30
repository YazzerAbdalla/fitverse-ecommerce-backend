import { ConflictException } from '@nestjs/common';
import { DataSource } from 'typeorm';
import * as dotenv from 'dotenv';
import { Reservation } from '../entities/reservation.entity';
import { ReservationItem } from '../entities/reservation-item.entity';
import { ReservationService } from '../reservation.service';
import { ReservationStatus } from '../entities/reservation-status.enum';
import User from '../../users/entity/user.entity';
import { Product } from '../../products/entities/product.entity';
import { Inventory } from '../../inventory/entities/inventory.entity';
import { Order } from '../../order/entities/order.entity';
import { OrderItem } from '../../order/entities/order-items.entity';
import { Cart } from '../../cart/entities/cart.entity';
import { CartItem } from '../../cart/entities/cart-items.entity';

dotenv.config();

describe('Reservation Integration (real PostgreSQL)', () => {
  let dataSource: DataSource;
  let reservationService: ReservationService;
  let userRepo: any;
  let productRepo: any;
  let inventoryRepo: any;
  let reservationRepo: any;
  let reservationItemRepo: any;
  let orderRepo: any;

  let testUserId: string;
  let otherUserId: string;
  let inventoryId1: string;
  let inventoryId2: string;
  let productId1: string;
  let productId2: string;

  beforeAll(async () => {
    dataSource = new DataSource({
      type: 'postgres',
      host: process.env.POSTGRES_HOST || '127.0.0.1',
      port: process.env.POSTGRES_PORT
        ? parseInt(process.env.POSTGRES_PORT)
        : 5432,
      username: process.env.POSTGRES_USER || 'postgres',
      password: process.env.POSTGRES_PASSWORD || 'mysecretpassword',
      database: process.env.POSTGRES_DATABASE || 'ecommerce',
      synchronize: false,
      logging: false,
      entities: [
        User,
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
    if (!dataSource.isInitialized) await dataSource.initialize();

    reservationService = new ReservationService(dataSource);

    userRepo = dataSource.getRepository(User);
    productRepo = dataSource.getRepository(Product);
    inventoryRepo = dataSource.getRepository(Inventory);
    reservationRepo = dataSource.getRepository(Reservation);
    reservationItemRepo = dataSource.getRepository(ReservationItem);
    orderRepo = dataSource.getRepository(Order);

    // clean reservation tables first (FK cascade)
    await dataSource.query(`DELETE FROM "reservation_item"`);
    await dataSource.query(`DELETE FROM "reservation"`);
  });

  afterAll(async () => {
    await dataSource.query(`DELETE FROM "reservation_item"`).catch(() => {});
    await dataSource.query(`DELETE FROM "reservation"`).catch(() => {});
    if (dataSource.isInitialized) await dataSource.destroy();
  });

  beforeEach(async () => {
    await dataSource.query(`DELETE FROM "reservation_item"`);
    await dataSource.query(`DELETE FROM "reservation"`);
    // ensure inventory and product for each test
    // Do not delete products globally, just clean inventory for isolation? Keep products.
  });

  async function createTestUser(emailSuffix: string): Promise<string> {
    const user = userRepo.create({
      firstName: 'Test',
      lastName: 'User',
      email: `res-test-${emailSuffix}-${Date.now()}@test.com`,
      password: 'hashed',
      role: 'User',
    });
    const saved = await userRepo.save(user);
    return saved.id;
  }

  async function createProductAndInventory(
    suffix: string,
  ): Promise<{ productId: string; inventoryId: string }> {
    const product = await productRepo.save(
      productRepo.create({
        name: `prod-res-${suffix}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
        slug: `prod-${suffix}-${Date.now()}`,
        description: 'test product for reservation',
        price: 1000,
      }),
    );
    const inventory = await inventoryRepo.save(
      inventoryRepo.create({
        productId: product.id,
        stock: 100,
        reservedAmount: 0,
      }),
    );
    return { productId: product.id, inventoryId: inventory.id };
  }

  describe('create and persistence', () => {
    beforeEach(async () => {
      testUserId = await createTestUser('create');
      const p1 = await createProductAndInventory('c1');
      const p2 = await createProductAndInventory('c2');
      productId1 = p1.productId;
      inventoryId1 = p1.inventoryId;
      productId2 = p2.productId;
      inventoryId2 = p2.inventoryId;
    });

    it('should persist reservation and items via transaction', async () => {
      const dto: any = {
        items: [
          { inventoryId: inventoryId1, quantity: 2 },
          { inventoryId: inventoryId2, quantity: 1 },
        ],
      };
      const reservation = await dataSource.transaction((manager) =>
        reservationService.create(manager, testUserId, dto),
      );
      expect(reservation.status).toBe(ReservationStatus.RESERVED);
      expect(reservation.items).toHaveLength(2);
      expect(reservation.userId).toBe(testUserId);
      expect(reservation.expiresAt).toBeInstanceOf(Date);

      const dbReservation = await reservationRepo.findOne({
        where: { id: reservation.id },
        relations: { items: true },
      });
      expect(dbReservation).toBeDefined();
      expect(dbReservation.items).toHaveLength(2);
    });

    it('should reject quantity=0 via DB CHECK (and DTO)', async () => {
      // direct DB insert should violate CHECK
      const dto: any = {
        items: [{ inventoryId: inventoryId1, quantity: 2 }],
      };
      const reservation = await dataSource.transaction((manager) =>
        reservationService.create(manager, testUserId, dto),
      );
      await expect(
        reservationItemRepo.save(
          reservationItemRepo.create({
            reservationId: reservation.id,
            inventoryId: inventoryId1,
            quantity: 0,
          }),
        ),
      ).rejects.toThrow();
    });

    it('should enforce unique (reservationId, inventoryId)', async () => {
      const dto: any = {
        items: [{ inventoryId: inventoryId1, quantity: 1 }],
      };
      const reservation = await dataSource.transaction((manager) =>
        reservationService.create(manager, testUserId, dto),
      );
      await expect(
        reservationItemRepo.save(
          reservationItemRepo.create({
            reservationId: reservation.id,
            inventoryId: inventoryId1,
            quantity: 1,
          }),
        ),
      ).rejects.toThrow();
    });

    it('should have required indexes', async () => {
      const indexes: { indexname: string }[] = await dataSource.query(
        `SELECT indexname FROM pg_indexes WHERE tablename='reservation'`,
      );
      const names = indexes.map((i) => i.indexname);
      expect(names).toEqual(
        expect.arrayContaining([
          'IDX_reservation_userId',
          'IDX_reservation_status',
          'IDX_reservation_expiresAt',
          'IDX_reservation_status_expiresAt',
        ]),
      );
      const itemIndexes: { indexname: string }[] = await dataSource.query(
        `SELECT indexname FROM pg_indexes WHERE tablename='reservation_item'`,
      );
      const itemNames = itemIndexes.map((i) => i.indexname);
      expect(itemNames).toEqual(
        expect.arrayContaining([
          'IDX_reservation_item_reservationId',
          'IDX_reservation_item_inventoryId',
        ]),
      );
    });
  });

  describe('GET by id', () => {
    beforeEach(async () => {
      testUserId = await createTestUser('get');
      const p = await createProductAndInventory('get');
      inventoryId1 = p.inventoryId;
    });

    it('create then fetch asserts items present', async () => {
      const dto: any = {
        items: [{ inventoryId: inventoryId1, quantity: 3 }],
      };
      const created = await dataSource.transaction((manager) =>
        reservationService.create(manager, testUserId, dto),
      );
      const fetched = await reservationService.findById(testUserId, created.id);
      expect(fetched.id).toBe(created.id);
      expect(fetched.items).toHaveLength(1);
      expect(fetched.items[0].quantity).toBe(3);
    });
  });

  describe('transition persistence', () => {
    beforeEach(async () => {
      testUserId = await createTestUser('trans');
      const p = await createProductAndInventory('trans');
      inventoryId1 = p.inventoryId;
    });

    it('complete then assert COMPLETED in DB; second cancel -> 409', async () => {
      const dto: any = {
        items: [{ inventoryId: inventoryId1, quantity: 1 }],
      };
      const created = await dataSource.transaction((manager) =>
        reservationService.create(manager, testUserId, dto),
      );
      const completed = await dataSource.transaction((manager) =>
        reservationService.complete(manager, testUserId, created.id),
      );
      expect(completed.status).toBe(ReservationStatus.COMPLETED);
      const db = await reservationRepo.findOne({
        where: { id: created.id },
      });
      expect(db.status).toBe(ReservationStatus.COMPLETED);

      await expect(
        dataSource.transaction((manager) =>
          reservationService.cancel(manager, testUserId, created.id),
        ),
      ).rejects.toThrow(ConflictException);
    });

    it('should allow cancel from RESERVED and then reject complete', async () => {
      const dto: any = {
        items: [{ inventoryId: inventoryId1, quantity: 1 }],
      };
      const created = await dataSource.transaction((manager) =>
        reservationService.create(manager, testUserId, dto),
      );
      const cancelled = await dataSource.transaction((manager) =>
        reservationService.cancel(manager, testUserId, created.id),
      );
      expect(cancelled.status).toBe(ReservationStatus.CANCELLED);
      await expect(
        dataSource.transaction((manager) =>
          reservationService.complete(manager, testUserId, created.id),
        ),
      ).rejects.toThrow(ConflictException);
    });
  });

  describe('list pagination and scoping', () => {
    beforeEach(async () => {
      testUserId = await createTestUser('listU');
      otherUserId = await createTestUser('listV');
      const p = await createProductAndInventory('list');
      inventoryId1 = p.inventoryId;
    });

    it('seed 3 for U +1 for V, assert scoping', async () => {
      for (let i = 0; i < 3; i++) {
        await dataSource.transaction((manager) =>
          reservationService.create(manager, testUserId, {
            items: [{ inventoryId: inventoryId1, quantity: 1 }],
          } as any),
        );
      }
      await dataSource.transaction((manager) =>
        reservationService.create(manager, otherUserId, {
          items: [{ inventoryId: inventoryId1, quantity: 1 }],
        } as any),
      );

      const listU = await reservationService.listByUser(testUserId, {
        page: 1,
        limit: 10,
      });
      expect(listU.data).toHaveLength(3);
      expect(listU.meta.totalItems).toBe(3);
      listU.data.forEach((r) => expect(r.userId).toBe(testUserId));

      const listV = await reservationService.listByUser(otherUserId, {
        page: 1,
        limit: 10,
      });
      expect(listV.data).toHaveLength(1);

      const paginated = await reservationService.listByUser(testUserId, {
        page: 1,
        limit: 2,
      });
      expect(paginated.data).toHaveLength(2);
      expect(paginated.meta.totalPages).toBe(2);
      expect(paginated.meta.currentPage).toBe(1);
    });
  });
});
