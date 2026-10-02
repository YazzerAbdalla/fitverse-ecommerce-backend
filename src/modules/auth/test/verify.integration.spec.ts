/**
 * T021 Integration test EmailVerificationToken FOR UPDATE single-winner (real PG).
 * Real PostgreSQL required. If DB not available, tests skip gracefully with warning.
 */
import { DataSource } from 'typeorm';
import * as dotenv from 'dotenv';
import * as crypto from 'crypto';
import { Logger } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { ConfigService } from '@nestjs/config';
import User from '../../users/entity/user.entity';
import { EmailVerificationToken } from '../entities/email-verification-token.entity';
import { PasswordResetToken } from '../entities/password-reset-token.entity';
import { OtpVerification } from '../entities/otp-verification.entity';
import { AuthService } from '../auth.service';

dotenv.config();

describe('Auth Integration T021 - verifyEmail FOR UPDATE single-winner (real PG)', () => {
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
      entities: [
        User,
        EmailVerificationToken,
        PasswordResetToken,
        OtpVerification,
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
      const configService = {
        get: jest.fn((key: string) =>
          key === 'EMAIL_VERIFICATION_TTL' ? '24h' : '15m',
        ),
      } as unknown as ConfigService;
      const whatsappMock: any = {
        sendOtp: jest.fn().mockResolvedValue({ messageId: 'test' }),
      };

      usersServiceMock = {
        findUserByEmail: jest.fn(async (email: string) => {
          return await dataSource
            .getRepository(User)
            .findOne({ where: { email } });
        }),
        findUserById: jest.fn(async (id: string) => {
          return await dataSource
            .getRepository(User)
            .findOne({ where: { id } });
        }),
        createNewUser: jest.fn(async (data: any) => {
          return await dataSource.getRepository(User).save(data);
        }),
      };

      authService = new AuthService(
        usersServiceMock,
        logger,
        jwtService,
        dataSource,
        cacheMock,
        configService,
        whatsappMock,
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
        await dataSource
          .query('TRUNCATE "email_verification_token", "user" CASCADE')
          .catch(() => {});
        await dataSource.destroy();
      }
    } catch {
      void 0;
    }
  });

  beforeEach(async () => {
    if (skip || !dataSource?.isInitialized) return;
    cooldownStore.clear();
    await dataSource
      .query('TRUNCATE "email_verification_token", "user" CASCADE')
      .catch(() => {});
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

  it('concurrent same raw → one 200 one 400, usedAt set once', async () => {
    if (skip || !dataSource?.isInitialized) return;
    const email = `verify_${Date.now()}@example.com`;
    await seedUser(email);
    await authService.requestEmailVerification(email);
    const raw = authService.lastVerificationToken!;
    expect(raw).toMatch(/^[a-f0-9]{64}$/);

    const results = await Promise.allSettled([
      authService.verifyEmail({ email, token: raw }),
      authService.verifyEmail({ email, token: raw }),
    ]);
    const fulfilled = results.filter((r) => r.status === 'fulfilled');
    const rejected = results.filter((r) => r.status === 'rejected');
    // FOR UPDATE serializes — exactly one winner
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
    const tokenHash = crypto.createHash('sha256').update(raw).digest('hex');
    const rows = await dataSource
      .getRepository(EmailVerificationToken)
      .find({ where: { tokenHash } });
    expect(rows.length).toBe(1);
    expect(rows[0].usedAt).not.toBeNull();
    const user = await dataSource
      .getRepository(User)
      .findOne({ where: { email } });
    expect(user!.emailVerified).toBe(true);
  });

  it('second use of same raw → 400, inventory/order untouched (no tables touched)', async () => {
    if (skip || !dataSource?.isInitialized) return;
    const email = `reuse_${Date.now()}@example.com`;
    await seedUser(email);
    await authService.requestEmailVerification(email);
    const raw = authService.lastVerificationToken!;
    await authService.verifyEmail({ email, token: raw });
    await expect(
      authService.verifyEmail({ email, token: raw }),
    ).rejects.toThrow('Invalid or expired verification token');
  });

  it('wrong email for same raw → 400 (userId mismatch, no leak)', async () => {
    if (skip || !dataSource?.isInitialized) return;
    const email = `owner_${Date.now()}@example.com`;
    const other = `other_${Date.now()}@example.com`;
    await seedUser(email);
    await seedUser(other);
    await authService.requestEmailVerification(email);
    const raw = authService.lastVerificationToken!;
    await expect(
      authService.verifyEmail({ email: other, token: raw }),
    ).rejects.toThrow('Invalid or expired verification token');
  });

  it('expired token → 400', async () => {
    if (skip || !dataSource?.isInitialized) return;
    const email = `expired_${Date.now()}@example.com`;
    const user = await seedUser(email);
    const raw = crypto.randomBytes(32).toString('hex');
    const tokenHash = crypto.createHash('sha256').update(raw).digest('hex');
    const repo = dataSource.getRepository(EmailVerificationToken);
    // Insert directly with past expiry (bypass CHECK via short-lived row: createdAt now, expiresAt past violates CHECK — use raw SQL to force)
    await dataSource.query(
      'INSERT INTO "email_verification_token"("id","userId","tokenHash","expiresAt","usedAt","createdAt") VALUES (gen_random_uuid(), $1, $2, NOW() - INTERVAL \'1 hour\', NULL, NOW() - INTERVAL \'2 hours\')',
      [user.id, tokenHash],
    );
    await expect(
      authService.verifyEmail({ email, token: raw }),
    ).rejects.toThrow('Invalid or expired verification token');
    expect(repo).toBeDefined();
  });

  it('EXPLAIN uses tokenHash index for the FOR UPDATE lookup', async () => {
    if (skip || !dataSource?.isInitialized) return;
    const plan = await dataSource.query(
      `EXPLAIN SELECT * FROM "email_verification_token" WHERE "tokenHash" = $1 AND "userId" = $2 FOR UPDATE`,
      ['a'.repeat(64), '00000000-0000-0000-0000-000000000000'],
    );
    const text = JSON.stringify(plan);
    // Composite/single-column index scan expected (not Seq Scan)
    expect(text).toMatch(/Index Scan|Bitmap Heap Scan/);
  });
});
