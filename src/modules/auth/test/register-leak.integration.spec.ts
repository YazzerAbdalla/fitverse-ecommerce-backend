/**
 * BASELINE characterization — T005 (research D3): register leaks bcrypt hash.
 * Read-only: asserts CURRENT pre-state on unmodified code. NO production code changes.
 * T015 flips test 1 to absent (S-delta proof).
 */
import { DataSource } from 'typeorm';
import * as dotenv from 'dotenv';
import { Logger } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { ConfigService } from '@nestjs/config';
import User from '../../users/entity/user.entity';
import { RefreshToken } from '../entities/refresh-token.entity';
import { PasswordResetToken } from '../entities/password-reset-token.entity';
import { OtpVerification } from '../entities/otp-verification.entity';
import { EmailVerificationToken } from '../entities/email-verification-token.entity';
// Relation-closure entities (User -> Order/Cart, Order/Cart -> items -> Product -> Inventory).
// Required: TypeORM fails metadata build if a relation target is missing from `entities`.
// List matches the proven sibling baseline token-races.integration.spec.ts (T006):
// Reservation/Outbox/Notification entities are deliberately EXCLUDED — including
// them makes synchronize:true fail with a duplicate auto-index
// (relation "IDX_..." already exists).
import { Order } from '../../order/entities/order.entity';
import { OrderItem } from '../../order/entities/order-items.entity';
import { Cart } from '../../cart/entities/cart.entity';
import { CartItem } from '../../cart/entities/cart-items.entity';
import { Product } from '../../products/entities/product.entity';
import { Inventory } from '../../inventory/entities/inventory.entity';
import { AuthService } from '../auth.service';

dotenv.config();

describe('Register leak baseline T005/D3 - real PG', () => {
  let dataSource: DataSource;
  let skip = false;
  let skipReason = '';
  let authService: AuthService;

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
      database: process.env.POSTGRES_DATABASE || 'test_ecommerce_register_leak',
      entities: [
        User,
        RefreshToken,
        PasswordResetToken,
        OtpVerification,
        EmailVerificationToken,
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
      const cacheMock: any = {
        get: jest.fn(),
        set: jest.fn(),
        del: jest.fn(),
        store: { client: { incr: jest.fn(), expire: jest.fn() } },
      };
      const configService = {
        get: jest.fn((k: string) =>
          k === 'REFRESH_TOKEN_TTL'
            ? '7d'
            : k === 'JWT_EXPIRES_IN'
              ? '15m'
              : k === 'EMAIL_VERIFICATION_TTL'
                ? '24h'
                : k === 'RESET_TOKEN_TTL'
                  ? '15m'
                  : k === 'OTP_TTL'
                    ? '5m'
                    : undefined,
        ),
      } as unknown as ConfigService;
      const usersServiceMock: any = {
        findUserByEmail: jest.fn(async (e: string) =>
          dataSource.getRepository(User).findOne({ where: { email: e } }),
        ),
        findUserById: jest.fn(async (id: string) =>
          dataSource.getRepository(User).findOne({ where: { id } }),
        ),
        findByGoogleId: jest.fn(async (gid: string) =>
          dataSource.getRepository(User).findOne({ where: { googleId: gid } }),
        ),
        createNewUser: jest.fn(async (data: any) =>
          dataSource.getRepository(User).save(data),
        ),
      };
      const whatsappMock: any = { sendOtp: jest.fn() };
      // NOTIFICATION_SERVICE + EMAIL_PROVIDER omitted (undefined): emitAuthEvent
      // guards `if (this.notificationClient)` (auth.service.ts:635) so absence is safe.
      authService = new AuthService(
        usersServiceMock,
        logger,
        jwtService,
        dataSource,
        cacheMock,
        configService,
        whatsappMock,
      );
      console.log('[register-leak integration] PG connected');
    } catch (e: any) {
      skip = true;
      skipReason = e?.message || String(e);
      console.warn(
        '[register-leak integration] SKIP PG not available',
        skipReason,
      );
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

  it('register returns data WITHOUT password hash (D3 POST-STATE)', async () => {
    if (skip) {
      console.warn('[register-leak integration] SKIP test 1', skipReason);
      return;
    }
    const email = `leak_${Date.now()}@example.com`;
    const result = await authService.register({
      firstName: 'Leak',
      lastName: 'Proof',
      email,
      password: 'Password123!',
    });
    expect(result.message).toBe('User created successfuly.');
    // D3 POST-STATE (was PRE-STATE leak): no password/hash key anywhere.
    expect(result.data.password).toBeUndefined();
    expect(JSON.stringify(result)).not.toContain('$2b$');
  });

  it('userValidation strips password on success (control: leak is register-specific)', async () => {
    if (skip) {
      console.warn('[register-leak integration] SKIP test 2', skipReason);
      return;
    }
    const email = `leakctl_${Date.now()}@example.com`;
    await authService.register({
      firstName: 'Ctl',
      lastName: 'User',
      email,
      password: 'Password123!',
    });
    const validated = await authService.userValidation(email, 'Password123!');
    expect(validated).not.toBeNull();
    expect(validated.password).toBeUndefined();
  });
});
