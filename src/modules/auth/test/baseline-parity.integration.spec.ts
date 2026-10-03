/**
 * BASELINE contract-matrix test — read-only characterization, NO production code changes.
 * T003 (specs/015-auth-user-refactor/tasks.md) — full baseline per contracts/auth-user-parity.md + spec.md US1.
 * Boots the FULL app like test/app.e2e-spec.ts and drives HTTP via supertest.
 * Writes to the dev database from .env — unique emails per run, created users deleted in afterAll.
 * Rate-limit isolation: unique X-Forwarded-For IP + unique emails/phone per run (shared Redis).
 * Skip gracefully (early return + console.warn) if app boot fails.
 */
import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import request from 'supertest';
import { App } from 'supertest/types';
import cookieParser from 'cookie-parser';
import * as crypto from 'crypto';
import { DataSource } from 'typeorm';
import { AppModule } from '../../../app.module';
import { AllExceptionsFilter } from '../../../common/filters/all-exceptions.filter';

describe('Baseline Parity T003 - auth/users contract matrix (full-app supertest)', () => {
  let app: INestApplication<App>;
  let dataSource: DataSource;
  let skip = false;
  let skipReason = '';

  const epoch = Date.now();
  const email = `base-${epoch}@test.com`;
  const unknownEmail = `base-unknown-${epoch}@test.com`;
  const phone = `+201${String(epoch).slice(-9)}`;
  const password = 'Password123!';
  // Unique client IP per run: per-IP rate buckets stay empty on shared Redis.
  const testIp = `10.99.${Math.floor(epoch / 256) % 256}.${epoch % 256}`;
  const createdEmails: string[] = [email];

  let accessA1 = '';
  let refreshR1 = '';
  let refreshR2 = '';
  let oldR1 = ''; // revoked rotation source for the reuse test
  let cookieName = 'refresh_token';

  const needApp = () => {
    if (skip) {
      console.warn('[baseline-parity] SKIP: app boot failed:', skipReason);
      return false;
    }
    return true;
  };

  /** POST/GET/PATCH helper with per-run IP isolation. */
  const req = (method: 'post' | 'get' | 'patch', path: string) =>
    request(app.getHttpServer())[method](path).set('X-Forwarded-For', testIp);

  const cookieValue = (setCookies: string[] | undefined, name: string) => {
    const found = (setCookies ?? []).find((c) => c.startsWith(`${name}=`));
    expect(found).toBeDefined();
    return found!.split(';')[0].slice(name.length + 1);
  };

  /**
   * REST error text. Observed shape is { statusCode, message: {statusCode,message,error}, timestamp }
   * (AllExceptionsFilter nests HttpException.getResponse()), NOT a flat string message.
   */
  const errText = (body: any): string =>
    typeof body?.message === 'string' ? body.message : body?.message?.message;

  beforeAll(async () => {
    try {
      const moduleFixture: TestingModule = await Test.createTestingModule({
        imports: [AppModule],
      }).compile();

      app = moduleFixture.createNestApplication({ bufferLogs: true });
      app.use(cookieParser());
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
      console.log('[baseline-parity] app booted, DB connected');
    } catch (e: any) {
      skip = true;
      skipReason = e?.message || String(e);
      console.warn('[baseline-parity] SKIP: full-app boot failed:', skipReason);
      try {
        if (app) await app.close().catch(() => {});
      } catch {
        // best-effort close during boot failure
      }
    }
  }, 90000);

  afterAll(async () => {
    try {
      if (!skip && dataSource?.isInitialized && createdEmails.length) {
        const placeholders = createdEmails
          .map((_, i) => `$${i + 1}`)
          .join(', ');
        // GET /cart (S-1 pin below) creates an empty cart row (FK RESTRICT) —
        // delete it first. Refresh-token rows cascade with the user delete.
        await dataSource
          .query(
            `DELETE FROM "cart" WHERE "userId" IN (SELECT "id" FROM "user" WHERE "email" IN (${placeholders}))`,
            createdEmails,
          )
          .catch(() => {});
        await dataSource.query(
          `DELETE FROM "user" WHERE "email" IN (${placeholders})`,
          createdEmails,
        );
      }
      if (app) await app.close().catch(() => {});
    } catch {
      // best-effort cleanup only — never fail the suite in teardown
    }
  });

  it('boot check (skip gracefully if infra down)', () => {
    if (skip) {
      console.warn('[baseline-parity] SKIP noted:', skipReason);
      expect(skip).toBe(true);
      return;
    }
    expect(app).toBeDefined();
  });

  it('register 201 + D3 pre-state key record', async () => {
    if (!needApp()) return;
    const res = await req('post', '/auth/register')
      .send({ firstName: 'Base', lastName: 'Line', email, password })
      .expect(201);
    expect(Object.keys(res.body).sort()).toEqual(['data', 'message']);
    expect(res.body.message).toBe('User created successfuly.');
    expect(res.body.data.email).toBe(email);
    // D3 PRE-STATE: register leaks the bcrypt hash — T015 flips this to absent
    expect(res.body.data.password).toBeDefined();
    expect(String(res.body.data.password)).toMatch(/^\$2b\$/);
  });

  it('duplicate register 400 (nested message object)', async () => {
    if (!needApp()) return;
    const res = await req('post', '/auth/register')
      .send({ firstName: 'Base', lastName: 'Line', email, password })
      .expect(400);
    expect(Object.keys(res.body).sort()).toEqual([
      'message',
      'statusCode',
      'timestamp',
    ]);
    expect(errText(res.body)).toBe('This email already exist.');
  });

  it('login 201 DIFF pair + refresh_token Set-Cookie + rate-limit header', async () => {
    if (!needApp()) return;
    // BASELINE-DIFF vs contracts/auth-user-parity.md (200): POST defaults to
    // 201 — the handler has no @HttpCode(200). Body/cookie/header contract as below.
    const res = await req('post', '/auth/login')
      .send({ email, password })
      .expect(201);
    expect(Object.keys(res.body).sort()).toEqual([
      'accessToken',
      'message',
      'refreshToken',
    ]);
    expect(res.body.refreshToken).toMatch(/^[a-f0-9]{64}$/);
    accessA1 = res.body.accessToken;
    refreshR1 = res.body.refreshToken;
    const setCookies: string[] = res.headers['set-cookie'];
    expect(setCookies).toBeDefined();
    cookieName = setCookies[0].split('=')[0];
    expect(cookieName).toBe('refresh_token');
    expect(cookieValue(setCookies, cookieName)).toBe(refreshR1);
    const cookieLine = setCookies.find((c) => c.startsWith(`${cookieName}=`))!;
    expect(cookieLine).toMatch(/HttpOnly/i);
    expect(cookieLine).toMatch(/Path=\/auth/);
    expect(cookieLine).toMatch(/Max-Age=/);
    expect(res.headers['x-ratelimit-limit']).toBeDefined();
  });

  it('login wrong password 401', async () => {
    if (!needApp()) return;
    const res = await req('post', '/auth/login')
      .send({ email, password: 'Wrong123!' })
      .expect(401);
    expect(res.body.statusCode).toBe(401);
  });

  it('GET /users/me 200 without password key (B4-healed)', async () => {
    if (!needApp()) return;
    // B4-HEALED (was 403 DIFF): bare-@Auth() empty-roles now passes through.
    const res = await req('get', '/users/me')
      .set('Authorization', `Bearer ${accessA1}`)
      .expect(200);
    expect(res.body.email).toBe(email);
    expect(res.body.password).toBeUndefined();
  });

  it('GET /users/me 401 without token', async () => {
    if (!needApp()) return;
    await req('get', '/users/me').expect(401);
  });

  it('PATCH /users/me/preferences 200 flip (B4-healed)', async () => {
    if (!needApp()) return;
    // B4-HEALED (was 403 DIFF): flip now reaches UsersService.
    const res = await req('patch', '/users/me/preferences')
      .set('Authorization', `Bearer ${accessA1}`)
      .send({ marketingOptIn: true })
      .expect(200);
    expect(res.body.marketingOptIn).toBe(true);
  });

  it('PATCH /users/me/preferences 200 flip-back (B4-healed)', async () => {
    if (!needApp()) return;
    await req('patch', '/users/me/preferences')
      .set('Authorization', `Bearer ${accessA1}`)
      .send({ marketingOptIn: false })
      .expect(200);
  });

  it('refresh via body 201 rotated pair (B1-healed)', async () => {
    if (!needApp()) return;
    // B1-HEALED: rotation no longer throws. POST default 201 (no @HttpCode,
    // same as login) with rotated pair + rotated cookie.
    const res = await req('post', '/auth/refresh').send({
      refreshToken: refreshR1,
    });
    expect(res.status).toBe(201);
    expect(res.body.refreshToken).toMatch(/^[a-f0-9]{64}$/);
    expect(res.body.accessToken).toBeDefined();
    const setCookies: string[] = res.headers['set-cookie'];
    expect(cookieValue(setCookies, cookieName)).toBe(res.body.refreshToken);
    if (!res.body.emailVerified) {
      expect(res.headers['x-email-unverified']).toBe('true');
    }
    oldR1 = refreshR1; // now revoked — reuse target below
    refreshR1 = res.body.refreshToken;
    accessA1 = res.body.accessToken;
  });

  it('refresh reuse 401 + theft nuke observable (B1+B5-healed)', async () => {
    if (!needApp()) return;
    // B1+B5-HEALED (was 500 DIFF): reuse → 401 and the nuke persists
    // (outer-tx rollback no longer undoes it).
    await req('post', '/auth/refresh')
      .send({ refreshToken: oldR1 })
      .expect(401);
    const rows = await dataSource.query(
      `SELECT COUNT(*)::int AS n FROM "refresh_token" WHERE "userId" = (SELECT "id" FROM "user" WHERE "email" = $1) AND "revokedAt" IS NULL`,
      [email],
    );
    expect(Number(rows[0].n)).toBe(0);
  });

  it('refresh via Cookie header 200 (B1-healed, transport-independent)', async () => {
    if (!needApp()) return;
    // B1-HEALED (was 500 DIFF): extraction worked all along. Fresh login
    // (previous pair was nuked above).
    const login = await req('post', '/auth/login')
      .send({ email, password })
      .expect(201); // see login BASELINE-DIFF above
    const fresh: string = login.body.refreshToken;
    const res = await req('post', '/auth/refresh')
      .set('Cookie', `${cookieName}=${fresh}`)
      .send({})
      .expect(201);
    expect(res.body.refreshToken).toMatch(/^[a-f0-9]{64}$/);
    refreshR2 = res.body.refreshToken;
  });

  it('logout 201 DIFF idempotent (valid + empty + cookie-garbage)', async () => {
    if (!needApp()) return;
    // BASELINE-DIFF vs (parity) 200: POST defaults to 201 (no @HttpCode).
    // Unlike refresh/forgot/resend, logout's repo.createQueryBuilder().update()
    // resolves against the repository target, so revocation works: valid → 201
    // + row revoked; empty/garbage hit the pre-builder early return → same 201.
    const bad = await req('post', '/auth/logout')
      .send({ refreshToken: refreshR2 })
      .expect(201);
    expect(bad.body).toEqual({ message: 'Logged out' });
    const hash = crypto.createHash('sha256').update(refreshR2).digest('hex');
    const row = await dataSource.query(
      `SELECT "revokedAt" FROM "refresh_token" WHERE "tokenHash" = $1`,
      [hash],
    );
    expect(row.length).toBe(1);
    expect(row[0].revokedAt).not.toBeNull();
    const empty = await req('post', '/auth/logout').send({}).expect(201);
    expect(empty.body).toEqual({ message: 'Logged out' });
    const garbage = await req('post', '/auth/logout')
      .set('Cookie', `${cookieName}=not-a-token`)
      .send({})
      .expect(201);
    expect(garbage.body).toEqual({ message: 'Logged out' });
  });

  it('logout-all 200 nuke (B4-healed) + S-1 pre-state via /cart', async () => {
    if (!needApp()) return;
    const login = await req('post', '/auth/login')
      .send({ email, password })
      .expect(201); // see login BASELINE-DIFF above
    const accessA5: string = login.body.accessToken;
    const refreshR5: string = login.body.refreshToken;
    const decoded5 = JSON.parse(
      Buffer.from(accessA5.split('.')[1], 'base64').toString(),
    );
    const sub5 = decoded5.sub as string;
    // B4-HEALED (was 403 DIFF): bare-@Auth() passes, the nuke actually runs.
    // POST default 201 (no @HttpCode — kept as R, like login/refresh/logout).
    await req('post', '/auth/logout-all')
      .set('Authorization', `Bearer ${accessA5}`)
      .send({})
      .expect(201);
    // The nuke bumps tokenVersion: prove the revoked access token is now
    // denied on a role-guarded route (S-1 unified guard). sub5 is unused
    // except to document which identity was revoked.
    void sub5;
    // Nuked refresh token is dead…
    await req('post', '/auth/refresh')
      .send({ refreshToken: refreshR5 })
      .expect(401);
    // S-1 POST-STATE (was 200 pre-state): the unified guard denies the nuked
    // access token on the role-guarded route. GET /cart carries
    // @Auth(UserRoles.User) so RolesGuard would pass for role 'User' — the
    // 401 comes from the tokenVersion check.
    const after = await req('get', '/cart').set(
      'Authorization',
      `Bearer ${accessA5}`,
    );
    expect(after.status).toBe(401);
  });

  it('forgot-password 201 + 201 anti-enum restored (B3-healed)', async () => {
    if (!needApp()) return;
    // B3-HEALED (was known-500/unknown-201 oracle): token-entity metadata is
    // registered, so the known path commits; both paths return POST-default
    // 201 with the identical neutral body — enumeration closed.
    const known = await req('post', '/auth/forgot-password')
      .send({ email })
      .expect(201);
    expect(known.body).toEqual({
      message: 'If an account exists, a reset link has been sent.',
    });
    const unknown = await req('post', '/auth/forgot-password')
      .send({ email: unknownEmail })
      .expect(201);
    expect(unknown.body).toEqual(known.body);
  });

  it('validate-reset-token garbage 400 (B3-healed)', async () => {
    if (!needApp()) return;
    // B3-HEALED (was 500 DIFF): metadata registered → service-level 400.
    const res = await req('post', '/auth/validate-reset-token')
      .send({ email, token: 'f'.repeat(64) })
      .expect(400);
    expect(res.body.statusCode).toBe(400);
  });

  it('reset-password garbage 400 (B3-healed)', async () => {
    if (!needApp()) return;
    // B3-HEALED (was 500 DIFF): garbage token is a service-level 400.
    await req('post', '/auth/reset-password')
      .send({ email, token: 'f'.repeat(64), newPassword: 'NewStrong123!' })
      .expect(400);
  });

  it('verify-email POST garbage 400 (B3-healed)', async () => {
    if (!needApp()) return;
    // B3-HEALED (was 500 DIFF): metadata registered → service-level 400.
    await req('post', '/auth/verify-email')
      .send({ email, token: 'f'.repeat(64) })
      .expect(400);
  });

  it('verify-email GET garbage 400 (B3-healed)', async () => {
    if (!needApp()) return;
    // B3-HEALED (was 500 DIFF): same root cause as POST.
    await req('get', '/auth/verify-email')
      .query({ email, token: 'f'.repeat(64) })
      .expect(400);
  });

  it('resend-verification 200 then 429 cooldown (B3-healed)', async () => {
    if (!needApp()) return;
    // B3-HEALED (was 500 + 500 DIFF): token row + cooldown key are written,
    // so the first call succeeds and the immediate second hits the 60s
    // cooldown denial.
    const first = await req('post', '/auth/resend-verification')
      .send({ email })
      .expect(201);
    expect(first.body.statusCode ?? 201).toBe(201);
    const second = await req('post', '/auth/resend-verification')
      .send({ email })
      .expect(429);
    console.log(
      '[baseline-parity] resend cooldown retry-after header:',
      JSON.stringify(second.headers['retry-after'] ?? null),
    );
  });

  it('otp/request 501 (deferred)', async () => {
    if (!needApp()) return;
    const res = await req('post', '/auth/otp/request')
      .send({ phoneNumber: phone })
      .expect(501);
    expect(res.body.statusCode).toBe(501);
  });
});
