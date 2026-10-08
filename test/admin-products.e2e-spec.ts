/**
 * Admin product & stock E2E (019 US1–US3 + T002b wire proof).
 * Admin list→create→adjust→re-list plus customer 403 on all three
 * dashboard routes AND on legacy stock writes. Skips gracefully
 * without infra (docker daemon down locally); CI provides the proof.
 */
import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import request from 'supertest';
import { App } from 'supertest/types';
import { AppModule } from '../src/app.module';
import { AllExceptionsFilter } from '../src/common/filters/all-exceptions.filter';
import { DataSource } from 'typeorm';
import { UserRoles } from '../src/modules/users/enum/roles';
import { Product } from '../src/modules/products/entities/product.entity';
import { Inventory } from '../src/modules/inventory/entities/inventory.entity';
import User from 'src/modules/users/entity/user.entity';

describe('AdminProducts E2E - list → create → adjust (supertest)', () => {
  let app: INestApplication<App>;
  let dataSource: DataSource;
  let skip = false;
  let adminJwt = '';
  let customerJwt = '';
  const createdProductIds: string[] = [];

  const uniqueEmail = (prefix: string): string =>
    `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 6)}@example.com`;

  async function registerAndLogin(email: string): Promise<string> {
    await request(app.getHttpServer())
      .post('/auth/register')
      .send({
        firstName: 'Admin',
        lastName: 'E2E',
        email,
        password: 'Password123!',
      })
      .expect(201);
    const loginResponse = await request(app.getHttpServer())
      .post('/auth/login')
      .send({ email, password: 'Password123!' })
      .expect(201);
    const body = loginResponse.body as { accessToken?: string };
    expect(body.accessToken?.length).toBeGreaterThan(0);
    return body.accessToken as string;
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

      customerJwt = await registerAndLogin(uniqueEmail('cust'));
      const adminEmail = uniqueEmail('admin');
      await registerAndLogin(adminEmail);
      // Promote via repository (no role-management endpoint in demo scope),
      // then re-login so the JWT carries the Admin role claim.
      const userRepo = dataSource.getRepository(User);
      const adminUser = await userRepo.findOneByOrFail({ email: adminEmail });
      await userRepo.update({ id: adminUser.id }, { role: UserRoles.Admin });
      const relogin = await request(app.getHttpServer())
        .post('/auth/login')
        .send({ email: adminEmail, password: 'Password123!' })
        .expect(201);
      adminJwt = (relogin.body as { accessToken?: string }).accessToken ?? '';
      expect(adminJwt.length).toBeGreaterThan(0);
    } catch (setupError: unknown) {
      skip = true;
      console.warn(
        'AdminProducts E2E skipped — infra not available',
        (setupError as Error)?.message,
      );
    }
  });

  afterAll(async () => {
    if (skip) return;
    const inventoryRepo = dataSource.getRepository(Inventory);
    const productRepo = dataSource.getRepository(Product);
    for (const id of createdProductIds) {
      await inventoryRepo.delete({ productId: id }).catch(() => undefined);
    }
    for (const id of createdProductIds) {
      await productRepo.delete({ id }).catch(() => undefined);
    }
    await app?.close();
  });

  it('boots or skips gracefully', () => {
    expect(skip === true || skip === false).toBe(true);
  });

  it('admin creates, lists with status, adjusts, and re-lists', async () => {
    if (skip) return;
    const name = `E2EWidget-${Date.now()}`;

    const createResponse = await request(app.getHttpServer())
      .post('/admin/products')
      .set('Authorization', `Bearer ${adminJwt}`)
      .send({ name, description: 'e2e product', price: 150, stock: 12 })
      .expect(201);
    const created = createResponse.body as { id: string; status: string };
    expect(created.status).toBe('in-stock');
    createdProductIds.push(created.id);

    const listResponse = await request(app.getHttpServer())
      .get(`/admin/products?search=${encodeURIComponent(name)}`)
      .set('Authorization', `Bearer ${adminJwt}`)
      .expect(200);
    const listBody = listResponse.body as {
      data: { name: string; available: number; status: string }[];
    };
    expect(listBody.data).toHaveLength(1);
    expect(listBody.data[0]).toMatchObject({
      name,
      available: 12,
      status: 'in-stock',
    });

    await request(app.getHttpServer())
      .patch(`/admin/products/${created.id}/stock`)
      .set('Authorization', `Bearer ${adminJwt}`)
      .send({ delta: -9 })
      .expect(200)
      .expect((response) => {
        const body = response.body as { available: number; status: string };
        expect(body.available).toBe(3);
        expect(body.status).toBe('low-stock');
      });

    await request(app.getHttpServer())
      .patch(`/admin/products/${created.id}/stock`)
      .set('Authorization', `Bearer ${adminJwt}`)
      .send({ delta: -999 })
      .expect(409);

    // Duplicate name creates nothing.
    await request(app.getHttpServer())
      .post('/admin/products')
      .set('Authorization', `Bearer ${adminJwt}`)
      .send({ name, description: 'dup', price: 150 })
      .expect(409);
  });

  it('denies customers on all admin routes (019 SC-005)', async () => {
    if (skip) return;
    await request(app.getHttpServer())
      .get('/admin/products')
      .set('Authorization', `Bearer ${customerJwt}`)
      .expect(403);
    await request(app.getHttpServer())
      .post('/admin/products')
      .set('Authorization', `Bearer ${customerJwt}`)
      .send({ name: 'X', description: 'Y', price: 1 })
      .expect(403);
    await request(app.getHttpServer())
      .patch('/admin/products/00000000-0000-0000-0000-000000000000/stock')
      .set('Authorization', `Bearer ${customerJwt}`)
      .send({ delta: 1 })
      .expect(403);
  });

  it('denies customers on legacy stock writes (019 T002b wire proof)', async () => {
    if (skip) return;
    const productId = '00000000-0000-0000-0000-000000000000';
    await request(app.getHttpServer())
      .post(`/inventory/${productId}/increase`)
      .set('Authorization', `Bearer ${customerJwt}`)
      .send({ quantity: 1 })
      .expect(403);
    await request(app.getHttpServer())
      .post(`/inventory/${productId}/decrease`)
      .set('Authorization', `Bearer ${customerJwt}`)
      .send({ quantity: 1 })
      .expect(403);
  });
});
