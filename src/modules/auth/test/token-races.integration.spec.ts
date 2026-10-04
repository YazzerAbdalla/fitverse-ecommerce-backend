/**
 * BASELINE single-winner concurrency proofs (read-only characterization, NO production code changes).
 * Phase 2 T006 of specs/015-auth-user-refactor (tasks.md T006, spec.md SC-002). Real PG required.
 *
 * Each case is stable across runs (FOR UPDATE serialization or sequential cooldown);
 * unique emails/users per case. Skips gracefully if PG unavailable.
 */
import { DataSource, IsNull } from 'typeorm';
import * as dotenv from 'dotenv';
import * as bcrypt from 'bcrypt';
import { HttpException, Logger } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { ConfigService } from '@nestjs/config';
import User from '../../users/entity/user.entity';
import { RefreshToken } from '../entities/refresh-token.entity';
import { PasswordResetToken } from '../entities/password-reset-token.entity';
import { OtpVerification } from '../entities/otp-verification.entity';
import { AuthService } from '../auth.service';
import { VerificationCooldownError } from '../verification-cooldown.error';
// Relation-closure entities (User -> Order/Cart, Order/Cart -> items -> Product -> Inventory).
// Required: TypeORM fails metadata build if a relation target is missing from `entities`.
import { Order } from '../../order/entities/order.entity';
import { OrderItem } from '../../order/entities/order-items.entity';
import { Cart } from '../../cart/entities/cart.entity';
import { CartItem } from '../../cart/entities/cart-items.entity';
import { Product } from '../../products/entities/product.entity';
import { Inventory } from '../../inventory/entities/inventory.entity';
import { RefreshTokenStore } from '../stores/refresh-token.store';
import { PasswordResetTokenStore } from '../stores/password-reset-token.store';
import { OtpStore } from '../stores/otp.store';
import { SystemClock } from '../../../common/clock';

dotenv.config();

describe('Auth Baseline T006 - token races single-winner (real PG)', () => {
  let dataSource: DataSource;
  let skip = false;
  let skipReason = '';
  let authService: AuthService;
  const cooldownStore = new Map<string, any>();

  const TRUNCATE_ALL = async () => {
    // Dynamic table list from metadata: robust to @Entity() default vs explicit names
    // (e.g. RefreshToken maps to "refresh_token", NOT "RefreshToken").
    const tables = dataSource.entityMetadatas
      .map((m) => `"${m.tableName}"`)
      .join(', ');
    await dataSource.query(`TRUNCATE ${tables} CASCADE`).catch(() => {});
  };

  const getDataSource = () => {
    return new DataSource({
      type: 'postgres',
      host: process.env.POSTGRES_HOST || '127.0.0.1',
      port: parseInt(process.env.POSTGRES_PORT || '5432', 10),
      username: process.env.POSTGRES_USER || 'postgres',
      password: process.env.POSTGRES_PASSWORD || 'mysecretpassword',
      database: process.env.POSTGRES_DATABASE || 'test_ecommerce_races',
      entities: [
        User,
        RefreshToken,
        PasswordResetToken,
        OtpVerification,
        Order,
        OrderItem,
        Cart,
        CartItem,
        Product,
        Inventory,
      ],
      synchronize: true,
      dropSchema: true,
      logging: false,
    });
  };

  beforeAll(async () => {
    try {
      dataSource = getDataSource();
      await dataSource.initialize();
      await dataSource.query('SELECT 1');
      await TRUNCATE_ALL();
      const logger = {
        log: jest.fn(),
        warn: jest.fn(),
        error: jest.fn(),
        debug: jest.fn(),
      } as unknown as Logger;
      const jwtService = {
        signAsync: jest.fn().mockResolvedValue('jwt-token'),
      } as unknown as JwtService;
      // In-memory Map-backed cache honoring cooldown get/set semantics
      // (resendVerification checks get() truthy -> 429, arms via set()).
      const cacheMock: any = {
        get: jest.fn(async (k: string) => cooldownStore.get(k) ?? null),
        set: jest.fn(async (k: string, v: any) => {
          cooldownStore.set(k, v);
          return 'OK';
        }),
        del: jest.fn(async (k: string) => {
          cooldownStore.delete(k);
        }),
        store: {
          client: {
            incr: jest.fn(async () => 1),
            expire: jest.fn(async () => 1),
          },
        },
      };
      const configService = {
        get: jest.fn((k: string) =>
          k === 'REFRESH_TOKEN_TTL'
            ? '7d'
            : k === 'RESET_TOKEN_TTL'
              ? '15m'
              : k === 'EMAIL_VERIFICATION_TTL'
                ? '24h'
                : undefined,
        ),
      } as unknown as ConfigService;
      const usersServiceMock: any = {
        findUserByEmail: jest.fn(async (e: string, m?: any) =>
          (m ? m.getRepository(User) : dataSource.getRepository(User)).findOne({
            where: { email: e },
          }),
        ),
        findUserById: jest.fn(async (id: string, m?: any) =>
          (m ? m.getRepository(User) : dataSource.getRepository(User)).findOne({
            where: { id },
          }),
        ),
        findUserByIdForUpdate: jest.fn(async (m: any, id: string) =>
          m
            .getRepository(User)
            .createQueryBuilder('u')
            .setLock('pessimistic_write')
            .where('u.id = :id', { id })
            .getOne(),
        ),
        findByGoogleId: jest.fn(async (gid: string) =>
          dataSource.getRepository(User).findOne({ where: { googleId: gid } }),
        ),
        createNewUser: jest.fn(async (data: any) =>
          dataSource.getRepository(User).save(data),
        ),
        updatePassword: jest.fn(
          async (
            userId: string,
            hash: string,
            _v?: number,
            opts?: { manager?: any; passwordChangedAt?: Date },
          ) => {
            const repo = opts?.manager
              ? opts.manager.getRepository(User)
              : dataSource.getRepository(User);
            const update: any = {
              password: hash,
              tokenVersion: () => '"tokenVersion" + 1',
            };
            if (opts?.passwordChangedAt)
              update.passwordChangedAt = opts.passwordChangedAt;
            await repo.update(userId, update);
          },
        ),
        incrementTokenVersion: jest.fn(
          async (
            userId: string,
            opts?: { manager?: any; passwordChangedAt?: Date },
          ) => {
            const repo = opts?.manager
              ? opts.manager.getRepository(User)
              : dataSource.getRepository(User);
            const update: any = {
              tokenVersion: () => '"tokenVersion" + 1',
            };
            if (opts?.passwordChangedAt)
              update.passwordChangedAt = opts.passwordChangedAt;
            await repo.update(userId, update);
          },
        ),
        setEmailVerified: jest.fn(async (userId: string, m?: any) =>
          (m ? m.getRepository(User) : dataSource.getRepository(User)).update(
            userId,
            { emailVerified: true },
          ),
        ),
        findUserByEmailForUpdate: jest.fn(async (m: any, email: string) =>
          m
            .getRepository(User)
            .createQueryBuilder('u')
            .setLock('pessimistic_write')
            .where('u.email = :email', { email })
            .getOne(),
        ),
        issueEmailVerificationToken: jest.fn(
          async (
            m: any,
            userId: string,
            tokenHash: string,
            expiresAt: Date,
          ) =>
            await m.getRepository(User).update(userId, {
              emailVerificationTokenHash: tokenHash,
              emailVerificationExpiresAt: expiresAt,
              emailVerificationUsedAt: null,
            }),
        ),
        consumeEmailVerificationToken: jest.fn(
          async (m: any, userId: string, now: Date) =>
            await m.getRepository(User).update(userId, {
              emailVerificationUsedAt: now,
              emailVerified: true,
            }),
        ),
      };
      const whatsappMock: any = { sendOtp: jest.fn() };
      // Real stores wired to the real DataSource (US3): races prove the
      // production wiring, not mocks.
      const refreshTokens = new RefreshTokenStore(dataSource);
      const resetTokens = new PasswordResetTokenStore(dataSource);
      const otpStore = new OtpStore(dataSource, cacheMock);
      const eventPublisher: any = { emit: jest.fn() };
      // SystemClock + legacy-identical config values (US4 rewire).
      const clock = new SystemClock();
      const tokenConfig: any = {
        refreshTokenTtlMs: 7 * 24 * 3600_000,
        resetTokenTtlMs: 15 * 60_000,
        emailVerificationTtlMs: 24 * 3600_000,
        otpTtlMs: 5 * 60_000,
      };
      authService = new AuthService(
        usersServiceMock,
        logger,
        jwtService,
        dataSource,
        cacheMock,
        configService,
        whatsappMock,
        refreshTokens,
        resetTokens,
        otpStore,
        eventPublisher,
        clock,
        tokenConfig,
      );
      console.log('[token-races] PG connected');
    } catch (e: any) {
      skip = true;
      skipReason = e?.message || String(e);
      console.warn('[token-races] SKIP PG not available', skipReason);
      try {
        if (dataSource?.isInitialized) await dataSource.destroy();
      } catch {
        // best-effort teardown during boot failure — never fail the suite here
      }
    }
  }, 30000);

  afterAll(async () => {
    try {
      if (dataSource?.isInitialized) {
        await TRUNCATE_ALL();
        await dataSource.destroy();
      }
    } catch {
      // best-effort teardown only — never fail the suite in teardown
    }
  });

  beforeEach(async () => {
    if (skip || !dataSource?.isInitialized) return;
    cooldownStore.clear();
    await TRUNCATE_ALL();
  });

  const uniq = (prefix: string) =>
    `${prefix}_${Date.now()}_${Math.floor(Math.random() * 1e6)}@example.com`;

  async function seedUser(email: string, extra: Record<string, unknown> = {}) {
    const repo = dataSource.getRepository(User);
    return await repo.save(
      repo.create({
        firstName: 'Race',
        lastName: 'User',
        email,
        password: await bcrypt.hash('Pass123!', 10),
        emailVerified: false,
        tokenVersion: 0,
        ...extra,
      } as any),
    );
  }

  it('(a) same refresh token x2 -> one 200-pair + one 401, bulk revoke proves theft-nuke', async () => {
    if (skip) {
      console.warn('SKIP (a)');
      return;
    }
    const user = await seedUser(uniq('race_refresh'));
    const login = await authService.login(user as any);
    const raw = login.refreshToken;
    expect(raw).toMatch(/^[a-f0-9]{64}$/);

    const results = await Promise.allSettled([
      authService.refresh(raw),
      authService.refresh(raw),
    ]);
    const fulfilled = results.filter((r) => r.status === 'fulfilled');
    const rejected = results.filter((r) => r.status === 'rejected');
    // FOR UPDATE serializes: exactly one winner rotates, loser hits revokedAt -> theft 401
    expect(fulfilled.length).toBe(1);
    expect(rejected.length).toBe(1);
    const pair = (fulfilled[0] as PromiseFulfilledResult<any>).value;
    expect(pair.accessToken).toBeDefined();
    expect(pair.refreshToken).toMatch(/^[a-f0-9]{64}$/);
    expect(pair.refreshToken).not.toBe(raw);
    expect(String(rejected[0].reason?.message)).toMatch(
      /Invalid or expired refresh token/,
    );
    // Loser triggers bulk revoke: ALL refresh rows for user revoked (incl. winner's new token)
    const active = await dataSource
      .getRepository(RefreshToken)
      .count({ where: { userId: user.id, revokedAt: IsNull() } });
    expect(active).toBe(0);
  });

  it('(b) same reset token x2 -> one 200 + one 400, password equals winner value', async () => {
    if (skip) {
      console.warn('SKIP (b)');
      return;
    }
    const email = uniq('race_reset');
    await seedUser(email);
    await authService.requestPasswordReset(email);
    const raw = authService.lastRawToken!;
    expect(raw).toMatch(/^[a-f0-9]{64}$/);

    const pwA = 'NewPassA123!';
    const pwB = 'NewPassB123!';
    const results = await Promise.allSettled([
      authService.resetPassword({ email, token: raw, newPassword: pwA }),
      authService.resetPassword({ email, token: raw, newPassword: pwB }),
    ]);
    const fulfilled = results.filter((r) => r.status === 'fulfilled');
    const rejected = results.filter((r) => r.status === 'rejected');
    // FOR UPDATE serializes on the token row: winner sets usedAt, loser sees usedAt -> 400
    expect(fulfilled.length).toBe(1);
    expect(rejected.length).toBe(1);
    expect(String(rejected[0].reason?.message)).toMatch(
      /Invalid or expired token/,
    );
    const winnerPw = results[0].status === 'fulfilled' ? pwA : pwB;
    const loserPw = results[0].status === 'fulfilled' ? pwB : pwA;
    const dbUser = await dataSource
      .getRepository(User)
      .findOneOrFail({ where: { email } });
    expect(await bcrypt.compare(winnerPw, dbUser.password)).toBe(true);
    expect(await bcrypt.compare(loserPw, dbUser.password)).toBe(false);
  });

  it('(b2) validate says valid, but reset is the authority (S-2 ordering)', async () => {
    if (skip) {
      console.warn('SKIP (b2)');
      return;
    }
    // S-2: validateResetToken is an advisory pre-check; a concurrent consume
    // wins and the second reset 400s even though validate just said valid.
    const email = uniq('race_validate');
    await seedUser(email);
    await authService.requestPasswordReset(email);
    const raw = authService.lastRawToken!;
    // Advisory check passes before any consume.
    await expect(
      authService.validateResetToken(email, raw),
    ).resolves.toBeDefined();
    // Consume the token, then prove the same raw is now rejected at BOTH
    // layers: advisory validate AND authoritative reset.
    await authService.resetPassword({
      email,
      token: raw,
      newPassword: 'Consumed123!',
    });
    await expect(authService.validateResetToken(email, raw)).rejects.toThrow(
      /Invalid or expired token/,
    );
    await expect(
      authService.resetPassword({ email, token: raw, newPassword: 'Late123!' }),
    ).rejects.toThrow(/Invalid or expired token/);
  });

  it('(c) same verify token x2 -> one 200 + one 400, emailVerified true once', async () => {
    if (skip) {
      console.warn('SKIP (c)');
      return;
    }
    const email = uniq('race_verify');
    const user = await seedUser(email);
    // requestEmailVerification takes the loaded User (RP-AUTH, no re-read).
    await authService.requestEmailVerification(user as any);
    const raw = authService.lastVerificationToken!;
    expect(raw).toMatch(/^[a-f0-9]{64}$/);

    const results = await Promise.allSettled([
      authService.verifyEmail({ email, token: raw }),
      authService.verifyEmail({ email, token: raw }),
    ]);
    const fulfilled = results.filter((r) => r.status === 'fulfilled');
    const rejected = results.filter((r) => r.status === 'rejected');
    // FOR UPDATE serializes: winner sets usedAt + flag, loser sees usedAt -> 400
    expect(fulfilled.length).toBe(1);
    expect(rejected.length).toBe(1);
    expect((fulfilled[0] as PromiseFulfilledResult<any>).value).toEqual({
      verified: true,
      emailVerified: true,
    });
    expect(String(rejected[0].reason?.message)).toMatch(/Invalid or expired/);
    const dbUser = await dataSource
      .getRepository(User)
      .findOneOrFail({ where: { email } });
    expect(dbUser.emailVerified).toBe(true);
  });

  it('(d) logoutAll then refresh with pre-nuke token -> 401', async () => {
    if (skip) {
      console.warn('SKIP (d)');
      return;
    }
    const user = await seedUser(uniq('race_nuke'));
    const login = await authService.login(user as any);
    const raw = login.refreshToken;
    expect(raw).toMatch(/^[a-f0-9]{64}$/);

    await authService.logoutAll(user.id);
    // tokenVersion++ + bulk revokedAt: pre-nuke token is dead
    await expect(authService.refresh(raw)).rejects.toThrow(
      'Invalid or expired refresh token',
    );
    const active = await dataSource
      .getRepository(RefreshToken)
      .count({ where: { userId: user.id, revokedAt: IsNull() } });
    expect(active).toBe(0);
  });

  it('(e) resend x2 within 60s -> one 200 + one 429', async () => {
    if (skip) {
      console.warn('SKIP (e)');
      return;
    }
    const email = uniq('race_resend');
    await seedUser(email);
    // Sequential (not Promise.all): cooldown arms only after first issue commits,
    // so true-concurrent x2 would both pass the pre-tx get() check. Sequential proves the gate.
    const first = await authService.resendVerification(email);
    expect(first.message).toBe(
      'If an account exists, a verification email has been sent.',
    );
    expect(authService.lastVerificationToken).toMatch(/^[a-f0-9]{64}$/);

    let status = -1;
    try {
      await authService.resendVerification(email);
    } catch (e: any) {
      // T030: service throws the domain signal (controller renders 429).
      expect(e).toBeInstanceOf(VerificationCooldownError);
      expect(e.retryAfterSec).toBe(60);
      status = 429;
    }
    expect(status).toBe(429);
  });
});
