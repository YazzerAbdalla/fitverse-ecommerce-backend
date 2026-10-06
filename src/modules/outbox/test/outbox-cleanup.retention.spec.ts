/**
 * S1 P0-1 retention regression matrix (real PG required).
 * specs/016-baseline US1 (T006): proves cleanup() deletes ONLY expired
 * terminal rows (SENT/SENT_TO_MQ/CONSUMED/DELIVERED via sentAt, FAILED via
 * createdAt) and preserves fresh terminal + all non-terminal rows.
 * Skips gracefully if PG unavailable. Written BEFORE the fix (must FAIL),
 * green AFTER (T007-T008).
 */
import { DataSource } from 'typeorm';
import * as dotenv from 'dotenv';
import { Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { OutboxCleanupService } from '../outbox-cleanup.service';
import { OutboxEvent } from '../entities/outbox-event.entity';
import { OutboxStatus } from '../entities/outbox-status.enum';

dotenv.config();

describe('OutboxCleanupService retention (real PG)', () => {
  let dataSource: DataSource;
  let service: OutboxCleanupService;
  let skip = false;

  const daysAgo = (days: number): Date =>
    new Date(Date.now() - days * 24 * 60 * 60 * 1000);

  const iso = (date: Date | null): string =>
    date === null ? 'NULL' : `'${date.toISOString()}'`;

  const seed = async (
    status: OutboxStatus,
    createdAt: Date,
    sentAt: Date | null,
    consumedAt: Date | null = null,
  ): Promise<string> => {
    // Raw INSERT with explicit timestamps: entity save() would let
    // @CreateDateColumn overwrite createdAt with NOW(), and raw SQL keeps
    // the seeded ages byte-exact (production rows always carry real stamps).
    const rows: Array<{ id: string }> = await dataSource.query(
      `INSERT INTO outbox_event ("eventType", "aggregateType", "aggregateId", payload, status, attempts, "createdAt", "sentAt", "consumedAt") VALUES ('order.created', 'Order', '11111111-1111-1111-1111-111111111111', '{"version":1}', $1, 0, ${iso(createdAt)}, ${iso(sentAt)}, ${iso(consumedAt)}) RETURNING id`,
      [status],
    );
    const insertedRow = rows[0];
    if (!insertedRow) throw new Error('seed INSERT returned no id');
    return insertedRow.id;
  };

  beforeAll(async () => {
    try {
      // Hardcoded isolated database: NEVER derive this from env. Test
      // suites using dropSchema:true with the dev database name wipe the
      // dev schema (observed 2026-10-06 on `ecommerce`). The database must
      // exist (created once by ops); the schema is rebuilt per run.
      dataSource = new DataSource({
        type: 'postgres',
        host: process.env.POSTGRES_HOST || '127.0.0.1',
        port: parseInt(process.env.POSTGRES_PORT || '5432', 10),
        username: process.env.POSTGRES_USER || 'postgres',
        password: process.env.POSTGRES_PASSWORD || 'mysecretpassword',
        database: 'test_ecommerce_races',
        entities: [OutboxEvent],
        synchronize: true,
        dropSchema: true,
        logging: false,
      });
      await dataSource.initialize();
      await dataSource.query('SELECT 1');
      const configService = {
        get: jest.fn((key: string, fallback?: string) => fallback ?? '30'),
      } as unknown as ConfigService;
      const logger = {
        log: jest.fn(),
        warn: jest.fn(),
        error: jest.fn(),
        debug: jest.fn(),
      } as unknown as Logger;
      service = new OutboxCleanupService(dataSource, configService);
      void logger;
    } catch (error: unknown) {
      skip = true;
      console.warn(
        '[outbox-cleanup-retention] SKIP PG not available',
        error instanceof Error ? error.message : String(error),
      );
    }
  });

  afterAll(async () => {
    if (dataSource?.isInitialized) await dataSource.destroy();
  });

  it('deletes expired terminal rows, preserves the rest (contracts/retention-cleanup.md matrix)', async () => {
    if (skip) {
      console.warn('SKIP retention matrix (no PG)');
      return;
    }
    // Matrix rows 1-5: expired terminal → must be deleted.
    await seed(OutboxStatus.SENT, daysAgo(31), daysAgo(31));
    await seed(OutboxStatus.SENT_TO_MQ, daysAgo(31), daysAgo(31));
    await seed(OutboxStatus.CONSUMED, daysAgo(31), daysAgo(31), daysAgo(30));
    await seed(OutboxStatus.DELIVERED, daysAgo(31), daysAgo(31));
    await seed(OutboxStatus.FAILED, daysAgo(31), null);
    // Matrix rows 6-8: fresh terminal + old non-terminal → preserved.
    const freshId = await seed(OutboxStatus.SENT_TO_MQ, new Date(), new Date());
    const pendingId = await seed(OutboxStatus.PENDING, daysAgo(60), null);
    const processingId = await seed(OutboxStatus.PROCESSING, daysAgo(60), null);

    const deleted = await service.cleanup();

    // Exactly the 5 expired terminal rows go; nothing else moves.
    expect(deleted).toBe(5);
    const remaining = await dataSource
      .getRepository(OutboxEvent)
      .find({ order: { createdAt: 'ASC' } });
    expect(remaining.map((row) => row.id).sort()).toEqual(
      [freshId, pendingId, processingId].sort(),
    );
  });

  it('reports zero on an empty table without error (matrix row 9)', async () => {
    if (skip) {
      console.warn('SKIP empty-table (no PG)');
      return;
    }
    await dataSource.getRepository(OutboxEvent).clear();
    await expect(service.cleanup()).resolves.toBe(0);
  });
});
