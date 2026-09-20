/**
 * T016 Integration test PasswordResetToken constraints + FOR UPDATE single-winner (real PG)
 * Real PostgreSQL required. If DB not available, tests skip gracefully with warning.
 */
import { DataSource } from 'typeorm';
import * as dotenv from 'dotenv';
import * as crypto from 'crypto';
import * as bcrypt from 'bcrypt';
import { Logger } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { ConfigService } from '@nestjs/config';
import User from '../../users/entity/user.entity';
import { PasswordResetToken } from '../entities/password-reset-token.entity';
import { OtpVerification } from '../entities/otp-verification.entity';
import { Product } from '../../products/entities/product.entity';
import { Cart } from '../../cart/entities/cart.entity';
import { CartItem } from '../../cart/entities/cart-items.entity';
import { Order } from '../../order/entities/order.entity';
import { OrderItem } from '../../order/entities/order-items.entity';
import { Inventory } from '../../inventory/entities/inventory.entity';
import { Reservation } from '../../reservation/entities/reservation.entity';
import { ReservationItem } from '../../reservation/entities/reservation-item.entity';
import { AuthService } from '../auth.service';

dotenv.config();

describe('Auth Integration T016 - PasswordResetToken constraints & FOR UPDATE single-winner (real PG)', () => {
  let dataSource: DataSource;
  let skip = false;
  let skipReason = '';
  let authService: AuthService;
  let usersServiceMock: any;

  const getDataSource = () => {
    return new DataSource({
      type: 'postgres',
      host: process.env.POSTGRES_HOST || '127.0.0.1',
      port: parseInt(process.env.POSTGRES_PORT || '5432', 10),
      username: process.env.POSTGRES_USER || 'postgres',
      password: process.env.POSTGRES_PASSWORD || 'mysecretpassword',
      database: process.env.POSTGRES_DATABASE || 'test_ecommerce_auth',
      entities: [User, PasswordResetToken, OtpVerification],
      synchronize: true,
      dropSchema: true,
      logging: false,
    });
  };

  beforeAll(async () => {
    try {
      dataSource = getDataSource();
      await dataSource.initialize();
      // verify connection works
      await dataSource.query('SELECT 1');
      // clean
      // truncate in order respecting FKs
      await dataSource.query(
        'TRUNCATE "password_reset_token", "otp_verification", "user" CASCADE',
      );
      // console log

      console.log('[auth integration] PG connected', {
        host: process.env.POSTGRES_HOST,
        db: process.env.POSTGRES_DATABASE,
      });

      // build AuthService with real DataSource but mocked collaborators
      const logger = {
        log: jest.fn(),
        error: jest.fn(),
        debug: jest.fn(),
        warn: jest.fn(),
      } as unknown as Logger;
      const jwtService = {
        signAsync: jest.fn().mockResolvedValue('jwt-token'),
      } as unknown as JwtService;
      const cacheMock: any = { get: jest.fn(), set: jest.fn(), del: jest.fn() };
      const configService = {
        get: jest.fn().mockReturnValue('15m'),
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
        findByGoogleId: jest.fn(async (googleId: string) => {
          return await dataSource
            .getRepository(User)
            .findOne({ where: { googleId } });
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
        '[auth integration] SKIP: Real PG not available, integration tests will be skipped gracefully. Start docker postgres. Error:',
        skipReason,
      );
      try {
        if (dataSource?.isInitialized) await dataSource.destroy();
      } catch {}
    }
  }, 30000);

  afterAll(async () => {
    try {
      if (dataSource?.isInitialized) {
        await dataSource
          .query(
            'TRUNCATE "password_reset_token", "otp_verification", "user" CASCADE',
          )
          .catch(() => {});
        await dataSource.destroy();
      }
    } catch {}
  });

  afterEach(async () => {
    if (skip || !dataSource?.isInitialized) return;
    await dataSource
      .query(
        'TRUNCATE "password_reset_token", "otp_verification", "user" CASCADE',
      )
      .catch(() => {});
  });

  it('should note skip gracefully when PG unavailable', () => {
    if (skip) {
      console.warn('[auth integration] SKIP noted:', skipReason);
    }
    // if PG available, ensure dataSource initialized
    if (!skip) expect(dataSource.isInitialized).toBe(true);
    else expect(skip).toBe(true);
  });

  describe('DB constraints', () => {
    it('duplicate email 409 via UQ_user_email (23505)', async () => {
      if (skip) {
        console.warn('SKIP real PG: duplicate email 409');
        return;
      }
      const repo = dataSource.getRepository(User);
      const email = `dup_${Date.now()}@example.com`;
      await repo.save(
        repo.create({
          firstName: 'A',
          lastName: 'B',
          email,
          password: await bcrypt.hash('Pass123!', 10),
          tokenVersion: 0,
        } as any),
      );
      await expect(
        repo.save(
          repo.create({
            firstName: 'C',
            lastName: 'D',
            email,
            password: await bcrypt.hash('Pass123!', 10),
            tokenVersion: 0,
          } as any),
        ),
      ).rejects.toMatchObject(expect.objectContaining({ code: '23505' }));
      // alternative check via query error message contains UQ_user_email
      try {
        await repo.save(
          repo.create({
            firstName: 'E',
            lastName: 'F',
            email,
            password: await bcrypt.hash('Pass123!', 10),
            tokenVersion: 0,
          } as any),
        );
      } catch (e: any) {
        expect(e.message).toMatch(/UQ_user_email|duplicate|unique/i);
        expect(e.code).toBe('23505');
      }
    });

    it('CHECK expiresAt > createdAt violation', async () => {
      if (skip) {
        console.warn('SKIP real PG: CHECK expiresAt>createdAt');
        return;
      }
      const userRepo = dataSource.getRepository(User);
      const tokenRepo = dataSource.getRepository(PasswordResetToken);
      const user = await userRepo.save(
        userRepo.create({
          firstName: 'Chk',
          lastName: 'Test',
          email: `chk_${Date.now()}@example.com`,
          password: await bcrypt.hash('Pass123!', 10),
          tokenVersion: 0,
        } as any),
      );
      // Try to insert token with expiresAt in far past and createdAt forced via raw query to violate check
      // With entity, createdAt defaults to now, so expiresAt < now will violate CHECK
      const past = new Date(Date.now() - 60 * 60 * 1000);
      await expect(
        tokenRepo.save(
          tokenRepo.create({
            userId: user.id,
            tokenHash: crypto.createHash('sha256').update('raw').digest('hex'),
            expiresAt: past,
            usedAt: null,
          } as any),
        ),
      ).rejects.toThrow();
      try {
        await tokenRepo.save(
          tokenRepo.create({
            userId: user.id,
            tokenHash: crypto.createHash('sha256').update('raw2').digest('hex'),
            expiresAt: past,
            usedAt: null,
          } as any),
        );
      } catch (e: any) {
        expect(e.message).toMatch(/CHK|check|expiresAt/i);
      }

      // valid token should succeed
      const future = new Date(Date.now() + 15 * 60 * 1000);
      const ok = await tokenRepo.save(
        tokenRepo.create({
          userId: user.id,
          tokenHash: crypto.createHash('sha256').update('valid').digest('hex'),
          expiresAt: future,
          usedAt: null,
        } as any),
      );
      expect(ok.id).toBeDefined();
    });
  });

  describe('token invalidation & FOR UPDATE single-winner', () => {
    it('second forgot-password invalidates prior active token (only latest usable)', async () => {
      if (skip) {
        console.warn('SKIP real PG: token invalidation');
        return;
      }
      const userRepo = dataSource.getRepository(User);
      const tokenRepo = dataSource.getRepository(PasswordResetToken);
      const email = `inv_${Date.now()}@example.com`;
      const user = await userRepo.save(
        userRepo.create({
          firstName: 'Inv',
          lastName: 'Test',
          email,
          password: await bcrypt.hash('Pass123!', 10),
          tokenVersion: 0,
        } as any),
      );

      await authService.requestPasswordReset(email);
      const raw1 = authService.lastRawToken!;
      const hash1 = crypto.createHash('sha256').update(raw1).digest('hex');
      const tok1 = await tokenRepo.findOne({ where: { tokenHash: hash1 } });
      expect(tok1).toBeDefined();
      expect(tok1!.usedAt).toBeNull();

      await authService.requestPasswordReset(email);
      const raw2 = authService.lastRawToken!;
      const hash2 = crypto.createHash('sha256').update(raw2).digest('hex');
      expect(hash2).not.toBe(hash1);
      const tok1After = await tokenRepo.findOne({
        where: { tokenHash: hash1 },
      });
      const tok2 = await tokenRepo.findOne({ where: { tokenHash: hash2 } });
      expect(tok1After!.usedAt).not.toBeNull(); // invalidated
      expect(tok2!.usedAt).toBeNull();

      // validate first token should now fail
      await expect(authService.validateResetToken(email, raw1)).rejects.toThrow(
        'Invalid or expired token',
      );
      await expect(
        authService.validateResetToken(email, raw2),
      ).resolves.toBeDefined();
    });

    it('concurrent reset same token → one 200 one 400 (FOR UPDATE single-winner)', async () => {
      if (skip) {
        console.warn('SKIP real PG: concurrent reset single-winner');
        return;
      }
      const userRepo = dataSource.getRepository(User);
      const email = `conc_${Date.now()}@example.com`;
      const oldPass = 'OldPass123!';
      const user = await userRepo.save(
        userRepo.create({
          firstName: 'Conc',
          lastName: 'Test',
          email,
          password: await bcrypt.hash(oldPass, 10),
          tokenVersion: 0,
        } as any),
      );

      await authService.requestPasswordReset(email);
      const raw = authService.lastRawToken!;
      // two concurrent resets with same token, different new passwords to detect winner
      const p1 = authService.resetPassword({
        email,
        token: raw,
        newPassword: 'NewPass111!',
      });
      const p2 = authService.resetPassword({
        email,
        token: raw,
        newPassword: 'NewPass222!',
      });

      const results = await Promise.allSettled([p1, p2]);
      const fulfilled = results.filter((r) => r.status === 'fulfilled');
      const rejected = results.filter((r) => r.status === 'rejected');

      expect(fulfilled.length).toBe(1);
      expect(rejected.length).toBe(1);
      const reason: any = rejected[0].reason;
      expect(reason.message).toMatch(/Invalid or expired token/);
      expect(reason.status).toBe(400);

      // verify password is one of the two new ones, tokenVersion incremented to 1, usedAt set
      const updated = await userRepo.findOne({ where: { id: user.id } });
      expect(updated!.tokenVersion).toBe(1);
      expect(updated!.passwordChangedAt).not.toBeNull();
      const isOne = await bcrypt.compare('NewPass111!', updated!.password!);
      const isTwo = await bcrypt.compare('NewPass222!', updated!.password!);
      expect(isOne || isTwo).toBe(true);

      const tokenRepo = dataSource.getRepository(PasswordResetToken);
      const hash = crypto.createHash('sha256').update(raw).digest('hex');
      const token = await tokenRepo.findOne({ where: { tokenHash: hash } });
      expect(token!.usedAt).not.toBeNull();

      // second use after concurrent should also be 400
      await expect(
        authService.resetPassword({
          email,
          token: raw,
          newPassword: 'Another123!',
        }),
      ).rejects.toThrow('Invalid or expired token');
    });
  });
});
