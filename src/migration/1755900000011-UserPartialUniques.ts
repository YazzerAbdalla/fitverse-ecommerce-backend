import type { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * This migration enforces one-account-per-Google/phone at the database level.
 * Partial unique indexes (many NULLs allowed, one row per distinct value)
 * were specified in migration 0000 but are absent from live databases, so
 * they are (re)created here idempotently. The entity declares the same
 * indexes so TypeORM metadata matches (synchronize is off — no DDL from it).
 */
export class UserPartialUniques1755900000011 implements MigrationInterface {
  name = 'UserPartialUniques1755900000011';

  public async up(queryRunner: QueryRunner): Promise<void> {
    // Fails loudly if duplicate non-null values already exist — resolve the
    // data first (backfill check), then re-run. Zero duplicates on dev 2026-10-04.
    await queryRunner.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS "UQ_user_googleId"
        ON "user" ("googleId") WHERE "googleId" IS NOT NULL
    `);
    await queryRunner.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS "UQ_user_phoneNumber"
        ON "user" ("phoneNumber") WHERE "phoneNumber" IS NOT NULL
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX IF EXISTS "UQ_user_phoneNumber"`);
    await queryRunner.query(`DROP INDEX IF EXISTS "UQ_user_googleId"`);
  }
}
