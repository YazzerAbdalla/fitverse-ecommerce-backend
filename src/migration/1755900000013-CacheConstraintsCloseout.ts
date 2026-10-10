import type { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * This migration closes the Phase 9 + 13 demo scope at the database level.
 * Adds the missing `Product.price >= 0` backstop (audit 2026-10-09 found zero
 * violating rows, so the check applies cleanly) and the two EXPLAIN-proven
 * order indexes (revenue window `status + created_at`, owner listing
 * `userId + created_at`). All adds are idempotent; entities declare the same
 * names so TypeORM metadata matches with synchronize on or off.
 */
export class CacheConstraintsCloseout1755900000013 implements MigrationInterface {
  name = 'CacheConstraintsCloseout1755900000013';

  public async up(queryRunner: QueryRunner): Promise<void> {
    // Named check shared with the entity decorator; guard by conname because
    // Postgres has no ADD CONSTRAINT IF NOT EXISTS. Audit: zero price < 0 rows.
    await queryRunner.query(`
      DO $$ BEGIN
        IF NOT EXISTS (
          SELECT 1 FROM pg_constraint
          WHERE conname = 'CHK_product_price_non_negative'
        ) THEN
          ALTER TABLE "product"
            ADD CONSTRAINT "CHK_product_price_non_negative"
            CHECK (price >= 0);
        END IF;
      END $$;
    `);
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "IDX_order_status_createdAt"
        ON "order" (status, created_at)
    `);
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "IDX_order_userId_createdAt"
        ON "order" ("userId", created_at)
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `DROP INDEX IF EXISTS "IDX_order_userId_createdAt"`,
    );
    await queryRunner.query(
      `DROP INDEX IF EXISTS "IDX_order_status_createdAt"`,
    );
    await queryRunner.query(
      `ALTER TABLE "product" DROP CONSTRAINT IF EXISTS "CHK_product_price_non_negative"`,
    );
  }
}
