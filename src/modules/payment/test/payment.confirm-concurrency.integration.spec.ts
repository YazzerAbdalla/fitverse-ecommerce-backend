import { DataSource } from 'typeorm';
import * as dotenv from 'dotenv';
import { Order } from '../../order/entities/order.entity';
import { OrderItem } from '../../order/entities/order-items.entity';
import { OrderStatus } from '../../order/order-status.enum';
import { Reservation } from '../../reservation/entities/reservation.entity';
import { ReservationItem } from '../../reservation/entities/reservation-item.entity';
import { ReservationStatus } from '../../reservation/entities/reservation-status.enum';
import { Inventory } from '../../inventory/entities/inventory.entity';
import { Product } from '../../products/entities/product.entity';
import User from '../../users/entity/user.entity';
import { RefreshToken } from '../../auth/entities/refresh-token.entity';
import { Cart } from '../../cart/entities/cart.entity';
import { CartItem } from '../../cart/entities/cart-items.entity';
import { OrderCompletionService } from '../../order/order-completion.service';
import { OrderCancellationService } from '../../order/order-cancellation.service';
import { ReservationService } from '../../reservation/reservation.service';
import { UserRoles } from '../../users/enum/roles';
import { Payment } from '../entities/payment.entity';
import { PaymentStatus } from '../entities/payment-status.enum';
import { PaymentService } from '../payment.service';

dotenv.config();

/**
 * Concurrency tests for concurrent confirms on one payment (real PG, --runInBand).
 * Exactly one confirm mutates stock; the loser returns already-processed idempotent 200.
 */
describe('Payment Confirm Concurrency (real PostgreSQL)', () => {
  let dataSource: DataSource;
  let paymentService: PaymentService;
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
        Payment,
      ],
    });
    try {
      if (!dataSource.isInitialized) await dataSource.initialize();
      const reservationService = new ReservationService(dataSource);
      const stubOutboxService = {
        createEvent: jest.fn(async () => ({ id: 'evt-1' })),
      };
      const completionService = new OrderCompletionService(
        dataSource,
        reservationService,
        stubOutboxService as unknown as never,
      );
      const cancellationService = new OrderCancellationService(
        dataSource,
        stubOutboxService as unknown as never,
      );
      paymentService = new PaymentService(
        dataSource,
        dataSource.getRepository(Payment),
        completionService,
        cancellationService,
      );
    } catch (setupError: unknown) {
      enabled = false;
      const setupMessage =
        setupError instanceof Error ? setupError.message : String(setupError);
      console.warn(
        'Concurrency tests skipped — PG not available',
        setupMessage,
      );
    }
  });

  afterAll(async () => {
    if (dataSource?.isInitialized) {
      await dataSource.query(`DELETE FROM "Payment"`).catch(() => undefined);
      await dataSource
        .query(`DELETE FROM "reservation_item"`)
        .catch(() => undefined);
      await dataSource
        .query(`DELETE FROM "reservation"`)
        .catch(() => undefined);
      await dataSource.query(`DELETE FROM "order_item"`).catch(() => undefined);
      await dataSource.query(`DELETE FROM "Order"`).catch(() => undefined);
      await dataSource.destroy();
    }
  });

  beforeEach(async () => {
    if (!enabled) return;
    await dataSource.query(`DELETE FROM "Payment"`).catch(() => undefined);
    await dataSource
      .query(`DELETE FROM "reservation_item"`)
      .catch(() => undefined);
    await dataSource.query(`DELETE FROM "reservation"`).catch(() => undefined);
    await dataSource.query(`DELETE FROM "order_item"`).catch(() => undefined);
    await dataSource.query(`DELETE FROM "Order"`).catch(() => undefined);
  });

  it('concurrent confirms on one payment decrement stock exactly once', async () => {
    if (!enabled) return;
    const userRepository = dataSource.getRepository(User);
    const createdUser = await userRepository.save(
      userRepository.create({
        firstName: 'Pay',
        lastName: 'Race',
        email: `pay-race-${Date.now()}@test.com`,
        password: 'hashed',
        role: UserRoles.User,
      }),
    );
    const productRepository = dataSource.getRepository(Product);
    const createdProduct = await productRepository.save(
      productRepository.create({
        name: `PR-${Date.now()}`,
        slug: `pr-${Date.now()}-${Math.random()}`,
        description: 't',
        price: 100,
      }),
    );
    const inventoryRepository = dataSource.getRepository(Inventory);
    const createdInventory = await inventoryRepository.save(
      inventoryRepository.create({
        productId: createdProduct.id,
        stock: 10,
        reservedAmount: 1,
      }),
    );
    const orderRepository = dataSource.getRepository(Order);
    const createdOrder = await orderRepository.save(
      orderRepository.create({
        userId: createdUser.id,
        status: OrderStatus.PENDING,
        total: 100,
      }),
    );
    const reservationRepository = dataSource.getRepository(Reservation);
    const createdReservation = await reservationRepository.save(
      reservationRepository.create({
        userId: createdUser.id,
        orderId: createdOrder.id,
        status: ReservationStatus.RESERVED,
        expiresAt: new Date(Date.now() + 15 * 60 * 1000),
      }),
    );
    const reservationItemRepository = dataSource.getRepository(ReservationItem);
    await reservationItemRepository.save(
      reservationItemRepository.create({
        reservationId: createdReservation.id,
        inventoryId: createdInventory.id,
        quantity: 1,
      }),
    );
    const paymentRepository = dataSource.getRepository(Payment);
    const createdPayment = await paymentRepository.save(
      paymentRepository.create({
        orderId: createdOrder.id,
        userId: createdUser.id,
        amount: 100,
        currency: 'usd',
        status: PaymentStatus.PENDING,
        provider: 'simulation',
      }),
    );

    const [firstResult, secondResult] = await Promise.all([
      paymentService.confirmPayment(
        createdPayment.id,
        createdUser.id,
        'success',
      ),
      paymentService.confirmPayment(
        createdPayment.id,
        createdUser.id,
        'success',
      ),
    ]);

    // Both callers observe SUCCEEDED; only one performed the mutation.
    expect(firstResult.payment.status).toBe(PaymentStatus.SUCCEEDED);
    expect(secondResult.payment.status).toBe(PaymentStatus.SUCCEEDED);
    const finalInventory = await inventoryRepository.findOne({
      where: { id: createdInventory.id },
    });
    // Sale converts the single held unit: stock 10→9, reserved 1→0.
    expect(finalInventory?.stock).toBe(9);
    expect(finalInventory?.reservedAmount).toBe(0);
  });
});
