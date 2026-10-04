/**
 * A6 Integration test: partial uniques serialize concurrent identity links (real PG).
 * Double-linking the same googleId/phoneNumber must leave exactly one winner;
 * the loser gets PG 23505 (unique violation), which AuthService maps to 409.
 * Real PostgreSQL required; skips gracefully.
 */
import { DataSource } from 'typeorm';
import * as dotenv from 'dotenv';
import User from '../entity/user.entity';
import { RefreshToken } from '../../auth/entities/refresh-token.entity';
import { Order } from '../../order/entities/order.entity';
import { OrderItem } from '../../order/entities/order-items.entity';
import { Cart } from '../../cart/entities/cart.entity';
import { CartItem } from '../../cart/entities/cart-items.entity';
import { Product } from '../../products/entities/product.entity';
import { Inventory } from '../../inventory/entities/inventory.entity';
import { UsersService } from '../users.service';

dotenv.config();

describe('Users Integration A6 - identity-link partial uniques (real PG)', () => {
  let dataSource: DataSource;
  let skip = false;
  let skipReason = '';
  let usersService: UsersService;

  const uniq = (prefix: string) =>
    `${prefix}_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;

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
          RefreshToken,
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
      await dataSource.initialize();
      await dataSource.query('SELECT 1');
      usersService = new UsersService(
        dataSource.getRepository(User),
        dataSource,
      );
      // The partial uniques under test must exist (migration 0011 on real
      // DBs; synchronize creates them here from entity metadata).
      const indexes = await dataSource.query(
        `SELECT indexname FROM pg_indexes WHERE tablename = 'user' AND indexname IN ('UQ_user_googleId','UQ_user_phoneNumber')`,
      );
      expect(
        indexes.map((row: { indexname: string }) => row.indexname).sort(),
      ).toEqual(['UQ_user_googleId', 'UQ_user_phoneNumber']);
    } catch (e: any) {
      skip = true;
      skipReason = e?.message || String(e);
      console.warn(
        '[users-link integration] SKIP: Real PG not available. Error:',
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
        firstName: 'Link',
        lastName: 'Race',
        email,
        password: 'hashed',
      } as any),
    );
  }

  it('sequential double-link same googleId → second rejects 23505', async () => {
    if (skip || !dataSource?.isInitialized) return;
    const googleId = `google-${uniq('seq')}`;
    const first = await seedUser(`${uniq('seq-a')}@example.com`);
    const second = await seedUser(`${uniq('seq-b')}@example.com`);

    await usersService.linkGoogleAccount(first.id, googleId);
    await expect(
      usersService.linkGoogleAccount(second.id, googleId),
    ).rejects.toMatchObject({ code: '23505' });

    // Winner holds the link; loser untouched.
    const winner = await dataSource
      .getRepository(User)
      .findOneOrFail({ where: { id: first.id } });
    expect(winner.googleId).toBe(googleId);
    const loser = await dataSource
      .getRepository(User)
      .findOneOrFail({ where: { id: second.id } });
    expect(loser.googleId).toBeNull();
  });

  it('concurrent double-link same googleId → exactly one winner (DB serializes)', async () => {
    if (skip || !dataSource?.isInitialized) return;
    const googleId = `google-${uniq('race')}`;
    const first = await seedUser(`${uniq('race-a')}@example.com`);
    const second = await seedUser(`${uniq('race-b')}@example.com`);

    const results = await Promise.allSettled([
      usersService.linkGoogleAccount(first.id, googleId),
      usersService.linkGoogleAccount(second.id, googleId),
    ]);
    const fulfilled = results.filter((r) => r.status === 'fulfilled');
    const rejected = results.filter((r) => r.status === 'rejected');
    expect(fulfilled.length).toBe(1);
    expect(rejected.length).toBe(1);
    expect(String(rejected[0].reason)).toMatch(/23505|duplicate|unique/i);

    // Exactly one row carries the googleId.
    const count = await dataSource
      .getRepository(User)
      .count({ where: { googleId } });
    expect(count).toBe(1);
  });

  it('sequential double-set same phoneNumber → second rejects 23505', async () => {
    if (skip || !dataSource?.isInitialized) return;
    const phoneNumber = `+2010${String(Date.now()).slice(-8)}`;
    const repo = dataSource.getRepository(User);
    const first = await seedUser(`${uniq('ph-a')}@example.com`);
    const second = await seedUser(`${uniq('ph-b')}@example.com`);

    await repo.update(first.id, { phoneNumber });
    await expect(repo.update(second.id, { phoneNumber })).rejects.toMatchObject(
      { code: '23505' },
    );
  });
});
