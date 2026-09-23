import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * This migration is responsible for RefreshToken persistence (Phase 17).
 * It handles opaque refresh token storage with sha256 hash and single-use rotation.
 */
export class CreateRefreshToken1755900000005 implements MigrationInterface {
  name = 'CreateRefreshToken1755900000005';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "RefreshToken" (
        "id" uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
        "userId" uuid NOT NULL REFERENCES "User"("id") ON DELETE CASCADE,
        "tokenHash" varchar(255) NOT NULL,
        "expiresAt" timestamptz NOT NULL,
        "revokedAt" timestamptz,
        "createdAt" timestamptz NOT NULL DEFAULT now(),
        "updatedAt" timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT "CHK_refresh_token_expires_gt_createdAt" CHECK ("expiresAt" > "createdAt")
      )
    `);
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "IDX_refresh_token_userId" ON "RefreshToken"("userId")`,
    );
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "IDX_refresh_token_tokenHash" ON "RefreshToken"("tokenHash")`,
    );
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "IDX_refresh_token_expiresAt" ON "RefreshToken"("expiresAt")`,
    );
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "IDX_refresh_token_userId_expiresAt" ON "RefreshToken"("userId","expiresAt")`,
    );
    await queryRunner.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS "UQ_refresh_token_hash_active"
      ON "RefreshToken"("tokenHash") WHERE "revokedAt" IS NULL
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `DROP INDEX IF EXISTS "UQ_refresh_token_hash_active"`,
    );
    await queryRunner.query(`DROP TABLE IF EXISTS "RefreshToken"`);
  }
}
