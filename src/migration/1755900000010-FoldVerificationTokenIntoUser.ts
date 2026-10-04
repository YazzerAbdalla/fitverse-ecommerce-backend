import type { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * This migration folds the email-verification token into the user row (1:1).
 * It adds three nullable columns, backfills the single live token per user
 * (latest unused + unexpired row), then drops the email_verification_token
 * table. History rows are intentionally not preserved (ADR-0013).
 */
export class FoldVerificationTokenIntoUser1755900000010
  implements MigrationInterface
{
  name = 'FoldVerificationTokenIntoUser1755900000010';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "user" ADD COLUMN IF NOT EXISTS "emailVerificationTokenHash" varchar(255)
    `);
    await queryRunner.query(`
      ALTER TABLE "user" ADD COLUMN IF NOT EXISTS "emailVerificationExpiresAt" TIMESTAMPTZ
    `);
    await queryRunner.query(`
      ALTER TABLE "user" ADD COLUMN IF NOT EXISTS "emailVerificationUsedAt" TIMESTAMPTZ
    `);

    // Backfill + drop only when the legacy table exists (fresh DBs skip).
    // DISTINCT ON keeps the latest live token per user; already-consumed or
    // expired rows are audit-dead and stay behind.
    await queryRunner.query(`
      DO $$ BEGIN
        IF to_regclass('public.email_verification_token') IS NOT NULL THEN
          UPDATE "user" u SET
            "emailVerificationTokenHash" = t."tokenHash",
            "emailVerificationExpiresAt" = t."expiresAt",
            "emailVerificationUsedAt" = NULL
          FROM (
            SELECT DISTINCT ON ("userId") "userId", "tokenHash", "expiresAt"
            FROM "email_verification_token"
            WHERE "usedAt" IS NULL AND "expiresAt" > NOW()
            ORDER BY "userId", "createdAt" DESC
          ) t
          WHERE u."id" = t."userId"
            AND u."emailVerificationTokenHash" IS NULL;
          DROP TABLE "email_verification_token";
        END IF;
      END $$;
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    // Recreate the legacy table EMPTY (history is not restored by design).
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "email_verification_token" (
        "id" uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
        "userId" uuid NOT NULL,
        "tokenHash" varchar(255) NOT NULL,
        "expiresAt" TIMESTAMPTZ NOT NULL,
        "usedAt" TIMESTAMPTZ,
        "createdAt" TIMESTAMPTZ NOT NULL DEFAULT now(),
        CONSTRAINT "CHK_evt_expires_gt_created" CHECK ("expiresAt" > "createdAt"),
        CONSTRAINT "FK_evt_userId" FOREIGN KEY ("userId") REFERENCES "user"("id") ON DELETE CASCADE
      )
    `);
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "IDX_email_verification_token_userId" ON "email_verification_token" ("userId")`,
    );
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "IDX_email_verification_token_tokenHash" ON "email_verification_token" ("tokenHash")`,
    );
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "IDX_email_verification_token_expiresAt" ON "email_verification_token" ("expiresAt")`,
    );
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "IDX_email_verification_token_userId_expiresAt" ON "email_verification_token" ("userId", "expiresAt")`,
    );
    await queryRunner.query(`
      ALTER TABLE "user" DROP COLUMN IF EXISTS "emailVerificationUsedAt"
    `);
    await queryRunner.query(`
      ALTER TABLE "user" DROP COLUMN IF EXISTS "emailVerificationExpiresAt"
    `);
    await queryRunner.query(`
      ALTER TABLE "user" DROP COLUMN IF EXISTS "emailVerificationTokenHash"
    `);
  }
}
