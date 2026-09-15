import { MigrationInterface, QueryRunner } from 'typeorm';

export class AuthUpgradesUserAndResetToken1755900000000 implements MigrationInterface {
  name = 'AuthUpgradesUserAndResetToken1755900000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`CREATE EXTENSION IF NOT EXISTS "uuid-ossp"`);

    // --- User alterations -------------------------------------------------
    // Add columns if not exists
    await queryRunner.query(`
      ALTER TABLE "user" ADD COLUMN IF NOT EXISTS "phoneNumber" varchar
    `);
    await queryRunner.query(`
      ALTER TABLE "user" ADD COLUMN IF NOT EXISTS "phoneVerified" boolean NOT NULL DEFAULT false
    `);
    await queryRunner.query(`
      ALTER TABLE "user" ADD COLUMN IF NOT EXISTS "googleId" varchar
    `);
    await queryRunner.query(`
      ALTER TABLE "user" ADD COLUMN IF NOT EXISTS "provider" varchar NOT NULL DEFAULT 'local'
    `);
    await queryRunner.query(`
      ALTER TABLE "user" ADD COLUMN IF NOT EXISTS "tokenVersion" integer NOT NULL DEFAULT 0
    `);
    await queryRunner.query(`
      ALTER TABLE "user" ADD COLUMN IF NOT EXISTS "passwordChangedAt" TIMESTAMPTZ
    `);
    await queryRunner.query(`
      ALTER TABLE "user" ADD COLUMN IF NOT EXISTS "emailVerified" boolean NOT NULL DEFAULT false
    `);

    // Make password nullable
    await queryRunner.query(`
      ALTER TABLE "user" ALTER COLUMN "password" DROP NOT NULL
    `);

    // Unique email where not exists
    await queryRunner.query(`
      DO $$ BEGIN
        IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'UQ_user_email') THEN
          ALTER TABLE "user" ADD CONSTRAINT "UQ_user_email" UNIQUE ("email");
        END IF;
      END $$;
    `);

    // Partial unique indexes for googleId and phoneNumber
    await queryRunner.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS "UQ_user_googleId" ON "user" ("googleId") WHERE "googleId" IS NOT NULL
    `);
    await queryRunner.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS "UQ_user_phoneNumber" ON "user" ("phoneNumber") WHERE "phoneNumber" IS NOT NULL
    `);

    // Index for phoneNumber and googleId (non-unique) and tokenVersion/email
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "IDX_user_phoneNumber" ON "user" ("phoneNumber")`,
    );
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "IDX_user_googleId" ON "user" ("googleId")`,
    );
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "IDX_user_tokenVersion" ON "user" ("tokenVersion")`,
    );

    // Check provider
    await queryRunner.query(`
      DO $$ BEGIN
        IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'CHK_user_provider') THEN
          ALTER TABLE "user" ADD CONSTRAINT "CHK_user_provider" CHECK ("provider" IN ('local','google'));
        END IF;
      END $$;
    `);

    // --- PasswordResetToken table -----------------------------------------
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "password_reset_token" (
        "id" uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
        "userId" uuid NOT NULL,
        "tokenHash" varchar(255) NOT NULL,
        "expiresAt" TIMESTAMPTZ NOT NULL,
        "usedAt" TIMESTAMPTZ,
        "createdAt" TIMESTAMPTZ NOT NULL DEFAULT now(),
        CONSTRAINT "CHK_password_reset_token_expires_gt_created" CHECK ("expiresAt" > "createdAt"),
        CONSTRAINT "FK_password_reset_token_userId" FOREIGN KEY ("userId") REFERENCES "user"("id") ON DELETE CASCADE
      )
    `);
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "IDX_password_reset_token_userId" ON "password_reset_token" ("userId")`,
    );
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "IDX_password_reset_token_tokenHash" ON "password_reset_token" ("tokenHash")`,
    );
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "IDX_password_reset_token_expiresAt" ON "password_reset_token" ("expiresAt")`,
    );
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "IDX_password_reset_token_userId_expiresAt" ON "password_reset_token" ("userId", "expiresAt")`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE IF EXISTS "password_reset_token"`);
    await queryRunner.query(`DROP INDEX IF EXISTS "IDX_user_phoneNumber"`);
    await queryRunner.query(`DROP INDEX IF EXISTS "IDX_user_googleId"`);
    await queryRunner.query(`DROP INDEX IF EXISTS "IDX_user_tokenVersion"`);
    await queryRunner.query(`DROP INDEX IF EXISTS "UQ_user_googleId"`);
    await queryRunner.query(`DROP INDEX IF EXISTS "UQ_user_phoneNumber"`);
    await queryRunner.query(
      `ALTER TABLE "user" DROP CONSTRAINT IF EXISTS "CHK_user_provider"`,
    );
    await queryRunner.query(
      `ALTER TABLE "user" DROP CONSTRAINT IF EXISTS "UQ_user_email"`,
    );
    await queryRunner.query(
      `ALTER TABLE "user" ALTER COLUMN "password" SET NOT NULL`,
    );
    await queryRunner.query(
      `ALTER TABLE "user" DROP COLUMN IF EXISTS "emailVerified"`,
    );
    await queryRunner.query(
      `ALTER TABLE "user" DROP COLUMN IF EXISTS "passwordChangedAt"`,
    );
    await queryRunner.query(
      `ALTER TABLE "user" DROP COLUMN IF EXISTS "tokenVersion"`,
    );
    await queryRunner.query(
      `ALTER TABLE "user" DROP COLUMN IF EXISTS "provider"`,
    );
    await queryRunner.query(
      `ALTER TABLE "user" DROP COLUMN IF EXISTS "googleId"`,
    );
    await queryRunner.query(
      `ALTER TABLE "user" DROP COLUMN IF EXISTS "phoneVerified"`,
    );
    await queryRunner.query(
      `ALTER TABLE "user" DROP COLUMN IF EXISTS "phoneNumber"`,
    );
  }
}
