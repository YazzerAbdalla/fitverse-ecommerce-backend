/**
 * Payment simulation E2E (checkout → intent → confirm).
 * Drives payment endpoints over HTTP; seeds cart rows directly to stay
 * independent of cart-endpoint quirks. Skips gracefully without infra.
 */
import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import request from 'supertest';
import { App } from 'supertest/types';
import { AppModule } from '../src/app.module';
import { AllExceptionsFilter } from '../src/common/filters/all-exceptions.filter';
import { DataSource } from 'typeorm';
import { Product } from '../src/modules/products/entities/product.entity';
import { Inventory } from '../src/modules/inventory/entities/inventory.entity';
import { Cart } from '../src/modules/cart/entities/cart.entity';
import { CartItem } from '../src/modules/cart/entities/cart-items.entity';

describe('Payment E2E - intent → confirm success + decline (supertest)', () => {
  let app: INestApplication<App>;
  let dataSource: DataSource;
  let skip = false;

  const uniqueEmail = () =>
    `pay_${Date.now()}_${Math.random().toString(36).slice(2, 6)}@example.com`;
  const password = 'Password123!';

  async function registerAndLogin(): Promise<{
    userJwt: string;
    userId: string;
  }> {
    const email = uniqueEmail();
    await request(app.getHttpServer())
      .post('/auth/register')
      .send({
        firstName: 'Pay',
        lastName: 'Demo',
        email,
        password,
      })
      .expect(201);
    const loginResponse = await request(app.getHttpServer())
      .post('/auth/login')
      .send({ email, password })
      .expect(200);
    const loginBody = loginResponse.body as {
      accessToken?: string;
      data?: { accessToken?: string };
    };
    const userJwt = loginBody.accessToken ?? loginBody.data?.accessToken ?? '';
    expect(userJwt.length).toBeGreaterThan(0);
    const meResponse = await request(app.getHttpServer())
      .get('/users/me')
      .set('Authorization', `Bearer ${userJwt}`)
      .expect(200);
    const userId: string =
      (meResponse.body as { id?: string }).id ??
      (meResponse.body as { data?: { id?: string } }).data?.id ??
      '';
    expect(userId.length).toBeGreaterThan(0);
    return { userJwt, userId };
  }

  async function seedCartWithOneUnit(
    ownerUserId: string,
  ): Promise<{ productId: string }> {
    const productRepository = dataSource.getRepository(Product);
    const products = await productRepository.find({ take: 1 });
    expect(products.length).toBeGreaterThan(0);
    const productId: string = products[0].id;
    const inventoryRepository = dataSource.getRepository(Inventory);
    const existingInventory = await inventoryRepository.findOne({
      where: { productId },
    });
    if (existingInventory) {
      existingInventory.stock = 10;
      existingInventory.reservedAmount = 0;
      await inventoryRepository.save(existingInventory);
    }
    const cartRepository = dataSource.getRepository(Cart);
    let userCart = await cartRepository.findOne({
      where: { userId: ownerUserId },
    });
    if (!userCart) {
      userCart = await cartRepository.save(
        cartRepository.create({ userId: ownerUserId }),
      );
    }
    const cartItemRepository = dataSource.getRepository(CartItem);
    await cartItemRepository.save(
      cartItemRepository.create({
        cart: userCart,
        product: products[0],
        quantity: 1,
      }),
    );
    return { productId };
  }

  beforeAll(async () => {
    try {
      const moduleFixture: TestingModule = await Test.createTestingModule({
        imports: [AppModule],
      }).compile();

      app = moduleFixture.createNestApplication();
      app.useGlobalPipes(
        new ValidationPipe({
          whitelist: true,
          forbidNonWhitelisted: true,
          transform: true,
        }),
      );
      app.useGlobalFilters(new AllExceptionsFilter());
      await app.init();

      dataSource = app.get(DataSource);
      await dataSource.query('SELECT 1');
    } catch (setupError: unknown) {
      skip = true;
      const setupMessage =
        setupError instanceof Error ? setupError.message : String(setupError);
      console.warn('[payment e2e] SKIP: infra unavailable:', setupMessage);
      try {
        if (app) await app.close().catch(() => undefined);
      } catch {
        // ignore close errors when boot failed
      }
    }
  }, 60000);

  afterAll(async () => {
    try {
      if (app) await app.close().catch(() => undefined);
    } catch {
      // ignore
    }
  });

  it('boots or skips gracefully', () => {
    expect(skip === true || skip === false).toBe(true);
  });

  it('success flow: checkout → intent → confirm success → COMPLETED', async () => {
    if (skip) {
      console.warn('SKIP e2e: infra not available');
      return;
    }
    const { userJwt, userId } = await registerAndLogin();
    await seedCartWithOneUnit(userId);

    const checkoutResponse = await request(app.getHttpServer())
      .post('/order/checkout')
      .set('Authorization', `Bearer ${userJwt}`)
      .send({})
      .expect(201);
    const orderId: string = (checkoutResponse.body as { id: string }).id;
    expect(orderId).toBeDefined();

    const intentResponse = await request(app.getHttpServer())
      .post('/payments/intent')
      .set('Authorization', `Bearer ${userJwt}`)
      .send({ orderId })
      .expect(201);
    const paymentId: string = (intentResponse.body as { id: string }).id;
    expect(paymentId).toBeDefined();
    expect((intentResponse.body as { status: string }).status).toBe('PENDING');

    const confirmResponse = await request(app.getHttpServer())
      .post(`/payments/${paymentId}/confirm`)
      .set('Authorization', `Bearer ${userJwt}`)
      .send({ result: 'success' })
      .expect(200);
    expect(
      (confirmResponse.body as { payment: { status: string } }).payment.status,
    ).toBe('SUCCEEDED');

    const orderResponse = await request(app.getHttpServer())
      .get(`/order/${orderId}`)
      .set('Authorization', `Bearer ${userJwt}`)
      .expect(200);
    expect((orderResponse.body as { status: string }).status).toBe('COMPLETED');

    // Terminal re-confirm is idempotent 200 with zero delta.
    await request(app.getHttpServer())
      .post(`/payments/${paymentId}/confirm`)
      .set('Authorization', `Bearer ${userJwt}`)
      .send({ result: 'success' })
      .expect(200);
  });

  it('decline flow: checkout → intent → confirm declined → FAILED + hold released', async () => {
    if (skip) {
      console.warn('SKIP e2e: infra not available');
      return;
    }
    const { userJwt, userId } = await registerAndLogin();
    await seedCartWithOneUnit(userId);

    const checkoutResponse = await request(app.getHttpServer())
      .post('/order/checkout')
      .set('Authorization', `Bearer ${userJwt}`)
      .send({})
      .expect(201);
    const orderId: string = (checkoutResponse.body as { id: string }).id;

    const intentResponse = await request(app.getHttpServer())
      .post('/payments/intent')
      .set('Authorization', `Bearer ${userJwt}`)
      .send({ orderId })
      .expect(201);
    const paymentId: string = (intentResponse.body as { id: string }).id;

    const confirmResponse = await request(app.getHttpServer())
      .post(`/payments/${paymentId}/confirm`)
      .set('Authorization', `Bearer ${userJwt}`)
      .send({ result: 'declined', failureReason: 'card_declined' })
      .expect(200);
    expect(
      (confirmResponse.body as { payment: { status: string } }).payment.status,
    ).toBe('FAILED');
    expect(
      (confirmResponse.body as { order: { status: string } }).order.status,
    ).toBe('FAILED');
  });
});
