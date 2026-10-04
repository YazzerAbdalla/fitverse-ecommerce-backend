/**
 * B7 Integration test: email verification folded into User columns (real PG).
 * Single live token per user (overwrite), FOR UPDATE on the user row,
 * single-winner concurrent verify. Real PostgreSQL required; skips gracefully.
 */
import { DataSource } from 'typeorm';
import * as dotenv from 'dotenv';
import * as crypto from 'crypto';
import { Logger } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { ConfigService } from '@nestjs/config';
import User from '../../users/entity/user.entity';
import { PasswordResetToken } from '../entities/password-reset-token.entity';
import { OtpVerification } from '../entities/otp-verification.entity';
import { RefreshToken } from '../entities/refresh-token.entity';
import { AuthService } from '../auth.service';
import { RefreshTokenStore } from '../stores/refresh-token.store';
import { PasswordResetTokenStore } from '../stores/password-reset-token.store';
import { OtpStore } from '../stores/otp.store';
import { AuthEventPublisher } from '../auth-event.publisher';
import { SystemClock } from '../../../common/clock';

dotenv.config();

describe('Auth Integration B7 - verifyEmail on User columns (real PG)', () => {
  let dataSource: DataSource;
  let skip = false;
  let skipReason = '';
  let authService: AuthService;
  let usersServiceMock: any;
  const cooldownStore = new Map<string, any>();

  const getDataSource = () => {
    return new DataSource({
      type: 'postgres',
      host: process.env.POSTGRES_HOST || '127.0.0.1',
      port: parseInt(process.env.POSTGRES_PORT || '5432', 10),
      username: process.env.POSTGRES_USER || 'postgres',
      password: process.env.POSTGRES_PASSWORD || 'mysecretpassword',
      database: process.env.POSTGRES_DATABASE || 'test_ecommerce_auth',
      entities: [User, RefreshToken, PasswordResetToken, OtpVerification],
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

      const logger = {
        log: jest.fn(),
        error: jest.fn(),
        debug: jest.fn(),
        warn: jest.fn(),
      } as unknown as Logger;
      const jwtService = {
        signAsync: jest.fn().mockResolvedValue('jwt-token'),
      } as unknown as JwtService;
      // In-memory cooldown map mimicking Redis SET NX EX 60 (get/set/del)
      const cacheMock: any = {
        get: jest.fn(async (k: string) => cooldownStore.get(k)),
        set: jest.fn(async (k: string, v: any) => {
          cooldownStore.set(k, v);
        }),
        del: jest.fn(async (k: string) => {
          cooldownStore.delete(k);
        }),
      };
      const configService = {} as unknown as ConfigService;
      const whatsappMock: any = {
        sendOtp: jest.fn().mockResolvedValue({ messageId: 'test' }),
      };
      const userRepo = () => dataSource.getRepository(User);

      // Real-DB-backed UsersService shape (mirrors the production methods
      // the folded verify flow calls).
      usersServiceMock = {
        findUserByEmail: jest.fn(
          async (email: string) =>
            await userRepo().findOne({ where: { email } }),
        ),
        findUserByEmailForUpdate: jest.fn(
          async (manager: any, email: string) =>
            await manager
              .getRepository(User)
              .createQueryBuilder('u')
              .setLock('pessimistic_write')
              .where('u.email = :email', { email })
              .getOne(),
        ),
        issueEmailVerificationToken: jest.fn(
          async (
            manager: any,
            userId: string,
            tokenHash: string,
            expiresAt: Date,
          ) =>
            await manager.getRepository(User).update(userId, {
              emailVerificationTokenHash: tokenHash,
              emailVerificationExpiresAt: expiresAt,
              emailVerificationUsedAt: null,
            }),
        ),
        consumeEmailVerificationToken: jest.fn(
          async (manager: any, userId: string, now: Date) =>
            await manager.getRepository(User).update(userId, {
              emailVerificationUsedAt: now,
              emailVerified: true,
            }),
        ),
        setEmailVerified: jest.fn(
          async (userId: string, manager?: any) =>
            await (manager ? manager.getRepository(User) : userRepo()).update(
              userId,
              { emailVerified: true },
            ),
        ),
      };

      const eventPublisher = {
        emit: jest.fn(async () => undefined),
      } as unknown as AuthEventPublisher;
      const clock = new SystemClock();
      const tokenConfig: any = {
        emailVerificationTtlMs: 24 * 3600_000,
      };

      authService = new AuthService(
        usersServiceMock,
        logger,
        jwtService,
        dataSource,
        cacheMock,
        configService,
        whatsappMock,
        new RefreshTokenStore(dataSource),
        new PasswordResetTokenStore(dataSource),
        new OtpStore(dataSource, cacheMock),
        eventPublisher,
        clock,
        tokenConfig,
      );
    } catch (e: any) {
      skip = true;
      skipReason = e?.message || String(e);
      console.warn(
        '[verify integration] SKIP: Real PG not available. Error:',
        skipReason,
      );
      try {
        if (dataSource?.isInitialized) await dataSource.destroy();
      } catch {
        void 0;
      }
    }
  }, 30000);

  afterAll(async () => {
    try {
      if (dataSource?.isInitialized) {
        await dataSource.query('TRUNCATE "user" CASCADE').catch(() => {});
        await dataSource.destroy();
      }
    } catch {
      void 0;
    }
  });

  beforeEach(async () => {
    if (skip || !dataSource?.isInitialized) return;
    cooldownStore.clear();
    await dataSource.query('TRUNCATE "user" CASCADE').catch(() => {});
  });

  it('should note skip gracefully when PG unavailable', () => {
    if (!skip) return;
    expect(skip).toBe(true);
  });

  async function seedUser(email: string) {
    const repo = dataSource.getRepository(User);
    return await repo.save(
      repo.create({
        firstName: 'E2E',
        lastName: 'User',
        email,
        password: 'hashed',
        emailVerified: false,
      } as any),
    );
  }

  it('issue overwrites: second issue replaces the live hash (no history rows)', async () => {
    if (skip || !dataSource?.isInitialized) return;
    const email = `overwrite_${Date.now()}@example.com`;
    const user = await seedUser(email);
    await authService.requestEmailVerification(user as any);
    const firstRaw = authService.lastVerificationToken!;
    expect(firstRaw).toMatch(/^[a-f0-9]{64}$/);

    await authService.requestEmailVerification(user as any);
    const secondRaw = authService.lastVerificationToken!;
    expect(secondRaw).toMatch(/^[a-f0-9]{64}$/);
    expect(secondRaw).not.toBe(firstRaw);

    // Single column holds only the second hash; old raw is dead.
    const row = await dataSource
      .getRepository(User)
      .findOneOrFail({ where: { email } });
    expect(row.emailVerificationTokenHash).toBe(
      crypto.createHash('sha256').update(secondRaw).digest('hex'),
    );
    expect(row.emailVerificationUsedAt).toBeNull();
    await expect(
      authService.verifyEmail({ email, token: firstRaw }),
    ).rejects.toThrow('Invalid or expired verification token');
  });

  it('concurrent same raw → one 200 one 400, usedAt set once', async () => {
    if (skip || !dataSource?.isInitialized) return;
    const email = `verify_${Date.now()}@example.com`;
    const user = await seedUser(email);
    await authService.requestEmailVerification(user as any);
    const raw = authService.lastVerificationToken!;
    expect(raw).toMatch(/^[a-f0-9]{64}$/);

    const results = await Promise.allSettled([
      authService.verifyEmail({ email, token: raw }),
      authService.verifyEmail({ email, token: raw }),
    ]);
    const fulfilled = results.filter((r) => r.status === 'fulfilled');
    const rejected = results.filter((r) => r.status === 'rejected');
    // User-row FOR UPDATE serializes — exactly one winner
    expect(fulfilled.length).toBe(1);
    expect(rejected.length).toBe(1);
    expect((fulfilled[0] as any).value).toEqual({
      verified: true,
      emailVerified: true,
    });
    expect(String((rejected[0] as any).reason?.message)).toMatch(
      /Invalid or expired/,
    );

    // usedAt set exactly once, emailVerified true
    const row = await dataSource
      .getRepository(User)
      .findOneOrFail({ where: { email } });
    expect(row.emailVerificationUsedAt).not.toBeNull();
    expect(row.emailVerified).toBe(true);
  });

  it('second use of same raw → 400', async () => {
    if (skip || !dataSource?.isInitialized) return;
    const email = `reuse_${Date.now()}@example.com`;
    const user = await seedUser(email);
    await authService.requestEmailVerification(user as any);
    const raw = authService.lastVerificationToken!;
    await authService.verifyEmail({ email, token: raw });
    await expect(
      authService.verifyEmail({ email, token: raw }),
    ).rejects.toThrow('Invalid or expired verification token');
  });

  it('wrong email for same raw → 400 (no leak)', async () => {
    if (skip || !dataSource?.isInitialized) return;
    const email = `owner_${Date.now()}@example.com`;
    const other = `other_${Date.now()}@example.com`;
    const user = await seedUser(email);
    await seedUser(other);
    await authService.requestEmailVerification(user as any);
    const raw = authService.lastVerificationToken!;
    await expect(
      authService.verifyEmail({ email: other, token: raw }),
    ).rejects.toThrow('Invalid or expired verification token');
  });

  it('expired token → 400 with zero mutation', async () => {
    if (skip || !dataSource?.isInitialized) return;
    const email = `expired_${Date.now()}@example.com`;
    const user = await seedUser(email);
    const raw = crypto.randomBytes(32).toString('hex');
    const tokenHash = crypto.createHash('sha256').update(raw).digest('hex');
    // Stale live token: expiresAt in the past, never used.
    await dataSource.getRepository(User).update(user.id, {
      emailVerificationTokenHash: tokenHash,
      emailVerificationExpiresAt: new Date(Date.now() - 60_000),
      emailVerificationUsedAt: null,
    });
    await expect(
      authService.verifyEmail({ email, token: raw }),
    ).rejects.toThrow('Invalid or expired verification token');
    const row = await dataSource
      .getRepository(User)
      .findOneOrFail({ where: { email } });
    // Zero mutation: still unverified, usedAt untouched (D4 stale-leave).
    expect(row.emailVerified).toBe(false);
    expect(row.emailVerificationUsedAt).toBeNull();
  });

  it('EXPLAIN uses the email unique backing index for the FOR UPDATE lookup', async () => {
    if (skip || !dataSource?.isInitialized) return;
    const plan = await dataSource.query(
      `EXPLAIN SELECT * FROM "user" WHERE "email" = $1 FOR UPDATE`,
      ['nobody@example.com'],
    );
    const text = JSON.stringify(plan);
    // Unique-constraint backing index expected (not Seq Scan)
    expect(text).toMatch(/Index Scan|Bitmap Heap Scan/);
  });
});
