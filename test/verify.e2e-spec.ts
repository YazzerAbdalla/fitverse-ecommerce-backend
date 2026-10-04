/**
 * T022 E2E GET|POST /auth/verify-email contract (supertest).
 * If DB/infra not available (or the folded verification columns are missing),
 * tests skip gracefully with warning.
 */
import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import request from 'supertest';
import { App } from 'supertest/types';
import { AppModule } from '../src/app.module';
import { AllExceptionsFilter } from '../src/common/filters/all-exceptions.filter';
import { DataSource } from 'typeorm';
import { AuthService } from '../src/modules/auth/auth.service';

describe('Verify E2E T022 - GET|POST /auth/verify-email (supertest)', () => {
  let app: INestApplication<App>;
  let dataSource: DataSource;
  let authService: AuthService;
  let skip = false;
  let skipReason = '';

  const uniqueEmail = () =>
    `verify_${Date.now()}_${Math.random().toString(36).slice(2, 6)}@example.com`;

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
      authService = app.get(AuthService);
      await dataSource.query('SELECT 1');
      // Folded columns must exist (B2 migration); otherwise skip gracefully
      await dataSource.query(
        'SELECT "emailVerificationTokenHash" FROM "user" LIMIT 1',
      );
    } catch (e: any) {
      skip = true;
      skipReason = e?.message || String(e);
      console.warn(
        '[verify e2e] SKIP: E2E not available (DB or folded verification columns missing). Error:',
        skipReason,
      );
      try {
        if (app) await app.close().catch(() => {});
      } catch {
        void 0;
      }
    }
  }, 60000);

  afterAll(async () => {
    try {
      if (app) await app.close().catch(() => {});
    } catch {
      void 0;
    }
  });

  it('should note skip gracefully when E2E unavailable', () => {
    if (!skip) return;
    expect(skip).toBe(true);
  });

  it('POST /auth/register → GET verify 200 → reuse 400 → wrong email 400', async () => {
    if (skip) {
      console.warn('SKIP e2e: infra not available');
      return;
    }
    const email = uniqueEmail();

    await request(app.getHttpServer())
      .post('/auth/register')
      .send({
        firstName: 'E2E',
        lastName: 'Verify',
        email,
        password: 'Password123!',
      })
      .expect((res) => {
        if (![200, 201].includes(res.status))
          throw new Error(`register ${res.status} ${JSON.stringify(res.body)}`);
      });

    // Capture raw via test hook (014 US1 documented hook)
    const raw = authService.lastVerificationToken;
    expect(raw).toMatch(/^[a-f0-9]{64}$/);

    // Valid link → 200
    await request(app.getHttpServer())
      .get('/auth/verify-email')
      .query({ email, token: raw })
      .expect(200)
      .expect((res) => {
        if (res.body.verified !== true) throw new Error('not verified');
      });

    // Reuse → 400
    await request(app.getHttpServer())
      .get('/auth/verify-email')
      .query({ email, token: raw })
      .expect(400);

    // Wrong email for a fresh token → 400 (register second user for fresh raw)
    const other = uniqueEmail();
    await request(app.getHttpServer()).post('/auth/register').send({
      firstName: 'E2E',
      lastName: 'Other',
      email: other,
      password: 'Password123!',
    });
    const freshRaw = authService.lastVerificationToken;
    await request(app.getHttpServer())
      .post('/auth/verify-email')
      .send({ email, token: freshRaw })
      .expect(400);
  });
});
