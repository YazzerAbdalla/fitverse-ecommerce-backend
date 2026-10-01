/**
 * T028 Integration test resendVerification race + cooldown (real PG).
 * Real PostgreSQL required. If DB not available, tests skip gracefully with warning.
 */
import { DataSource } from 'typeorm';
import * as dotenv from 'dotenv';
import { Logger } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { ConfigService } from '@nestjs/config';
import User from '../../users/entity/user.entity';
import { EmailVerificationToken } from '../entities/email-verification-token.entity';
import { PasswordResetToken } from '../entities/password-reset-token.entity';
import { OtpVerification } from '../entities/otp-verification.entity';
import { AuthService } from '../auth.service';

dotenv.config();

describe('Auth Integration T028 - resendVerification race + cooldown (real PG)', () => {
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
        set: jest.fn(async (k: string, v: any) => {
          cooldownStore.set(k, v);
        }),
        del: jest.fn(async (k: string) => {
          cooldownStore.delete(k);
        }),
      };
      const whatsappMock: any = {
        sendOtp: jest.fn().mockResolvedValue({ messageId: 'test' }),
      };
      const configService = {
        get: jest.fn((key: string) =>
          key === 'EMAIL_VERIFICATION_TTL' ? '24h' : '15m',
        ),
      } as unknown as ConfigService;

      const usersServiceMock = {
        findUserByEmail: jest.fn(async (email: string) => {
          return await dataSource
            .getRepository(User)
            .findOne({ where: { email } });
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

  it('resend invalidates old raw (400) and new raw verifies (200)', async () => {
    if (skip || !dataSource?.isInitialized) return;
    const email = `resend_${Date.now()}@example.com`;
    const repo = dataSource.getRepository(User);
    await repo.save(
      repo.create({
        firstName: 'R',
        lastName: 'U',
        email,
        password: 'hashed',
        emailVerified: false,
      } as any),
    );

    await authService.requestEmailVerification(email);
    const oldRaw = authService.lastVerificationToken!;
    await authService.resendVerification(email);
    const newRaw = authService.lastVerificationToken!;
    expect(newRaw).not.toBe(oldRaw);

    // Old link dies with the resend invalidation
    await expect(
      authService.verifyEmail({ email, token: oldRaw }),
    ).rejects.toThrow('Invalid or expired verification token');
    // New link verifies
    await expect(
      authService.verifyEmail({ email, token: newRaw }),
    ).resolves.toEqual({ verified: true, emailVerified: true });
  });

  it('second resend within 60s → 429 before transaction', async () => {
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
    const countAfterFirst = await dataSource
      .getRepository(EmailVerificationToken)
      .count();
    // Immediate second hits the armed 60s cooldown — 429, no new row
    await expect(authService.resendVerification(email)).rejects.toThrow(
      expect.objectContaining({ status: 429 }),
    );
    const countAfterSecond = await dataSource
      .getRepository(EmailVerificationToken)
      .count();
    expect(countAfterSecond).toBe(countAfterFirst);
  });

  it('unknown email → 200 anti-enum, 0 rows', async () => {
    if (skip || !dataSource?.isInitialized) return;
    const res = await authService.resendVerification(
      `nobody_${Date.now()}@example.com`,
    );
    expect(res).toEqual({
      message: 'If an account exists, a verification email has been sent.',
    });
    expect(await dataSource.getRepository(EmailVerificationToken).count()).toBe(
      0,
    );
  });
});
