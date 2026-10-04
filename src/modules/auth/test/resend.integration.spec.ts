/**
 * B7 Integration test resendVerification overwrite + cooldown (real PG).
 * Resend overwrites the single live User column (old raw dies), 60s cooldown
 * gates bursts before any transaction. Real PostgreSQL required; skips gracefully.
 */
import { DataSource } from 'typeorm';
import * as dotenv from 'dotenv';
import { Logger } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { ConfigService } from '@nestjs/config';
import User from '../../users/entity/user.entity';
import { PasswordResetToken } from '../entities/password-reset-token.entity';
import { OtpVerification } from '../entities/otp-verification.entity';
import { RefreshToken } from '../entities/refresh-token.entity';
import { AuthService } from '../auth.service';
import { VerificationCooldownError } from '../verification-cooldown.error';
import { RefreshTokenStore } from '../stores/refresh-token.store';
import { PasswordResetTokenStore } from '../stores/password-reset-token.store';
import { OtpStore } from '../stores/otp.store';
import { AuthEventPublisher } from '../auth-event.publisher';
import { SystemClock } from '../../../common/clock';

dotenv.config();

describe('Auth Integration B7 - resendVerification overwrite + cooldown (real PG)', () => {
  let dataSource: DataSource;
  let skip = false;
  let authService: AuthService;
  const cooldownStore = new Map<string, any>();

  beforeAll(async () => {
    try {
      dataSource = new DataSource({
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
      const cacheMock: any = {
        get: jest.fn(async (k: string) => cooldownStore.get(k)),
        set: jest.fn(async (k: string, v: any, ttlMs?: number) => {
          cooldownStore.set(k, { v, ttlMs });
        }),
        del: jest.fn(async (k: string) => {
          cooldownStore.delete(k);
        }),
      };
      const whatsappMock: any = {
        sendOtp: jest.fn().mockResolvedValue({ messageId: 'test' }),
      };
      const configService = {} as unknown as ConfigService;
      const userRepo = () => dataSource.getRepository(User);

      const usersServiceMock = {
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
        createNewUser: jest.fn(async (data: any) => {
          return await userRepo().save(data);
        }),
      };

      const eventPublisher = {
        emit: jest.fn(async () => undefined),
      } as unknown as AuthEventPublisher;
      const clock = new SystemClock();
      const tokenConfig = {
        emailVerificationTtlMs: 24 * 3600_000,
        otpMaxAttempts: 3,
      } as any;

      authService = new AuthService(
        usersServiceMock,
        logger,
        jwtService,
        dataSource,
        cacheMock,
        configService,
        whatsappMock,
        new RefreshTokenStore(dataSource, clock),
        new PasswordResetTokenStore(dataSource, clock),
        new OtpStore(dataSource, cacheMock, clock, tokenConfig),
        eventPublisher,
        clock,
        tokenConfig,
      );
    } catch (e: any) {
      skip = true;
      console.warn(
        '[resend integration] SKIP: Real PG not available. Error:',
        e?.message || String(e),
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

  it('resend overwrites live hash: old raw 400, new raw 200', async () => {
    if (skip || !dataSource?.isInitialized) return;
    const email = `resend_${Date.now()}@example.com`;
    const repo = dataSource.getRepository(User);
    const user = await repo.save(
      repo.create({
        firstName: 'R',
        lastName: 'U',
        email,
        password: 'hashed',
        emailVerified: false,
      } as any),
    );

    await authService.requestEmailVerification(user as any);
    const oldRaw = authService.lastVerificationToken!;
    await authService.resendVerification(email);
    const newRaw = authService.lastVerificationToken!;
    expect(newRaw).not.toBe(oldRaw);

    // Old link dies with the resend overwrite
    await expect(
      authService.verifyEmail({ email, token: oldRaw }),
    ).rejects.toThrow('Invalid or expired verification token');
    // New link verifies
    await expect(
      authService.verifyEmail({ email, token: newRaw }),
    ).resolves.toEqual({ verified: true, emailVerified: true });
  });

  it('second resend within 60s → VerificationCooldownError, 0 column change', async () => {
    if (skip || !dataSource?.isInitialized) return;
    const email = `cool_${Date.now()}@example.com`;
    const repo = dataSource.getRepository(User);
    await repo.save(
      repo.create({
        firstName: 'C',
        lastName: 'D',
        email,
        password: 'hashed',
        emailVerified: false,
      } as any),
    );

    await authService.resendVerification(email);
    const hashAfterFirst = (await repo.findOneOrFail({ where: { email } }))
      .emailVerificationTokenHash;
    // Immediate second hits the armed 60s cooldown — domain signal (the
    // controller renders the 429 wire shape), live hash untouched.
    await expect(authService.resendVerification(email)).rejects.toThrow(
      VerificationCooldownError,
    );
    const hashAfterSecond = (await repo.findOneOrFail({ where: { email } }))
      .emailVerificationTokenHash;
    expect(hashAfterSecond).toBe(hashAfterFirst);
  });

  it('unknown email → 200 anti-enum, user table untouched', async () => {
    if (skip || !dataSource?.isInitialized) return;
    const res = await authService.resendVerification(
      `nobody_${Date.now()}@example.com`,
    );
    expect(res).toEqual({
      message:
        'This email is not registered or already verified. If an account exists, a verification email has been sent.',
    });
    expect(await dataSource.getRepository(User).count()).toBe(0);
  });
});
