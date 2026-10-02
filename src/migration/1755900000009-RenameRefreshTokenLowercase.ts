import type { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * This migration renames "RefreshToken" to refresh_token.
 * The 0007 migration created the quoted CamelCase name, but the RefreshToken
 * entity resolves (via the default snake_case naming strategy) to
 * refresh_token, so login-time queries fail with "relation does not exist".
 */
export class RenameRefreshTokenLowercase1755900000009 implements MigrationInterface {
  name = 'RenameRefreshTokenLowercase1755900000009';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      DO $$ BEGIN
        IF EXISTS (
          SELECT 1 FROM information_schema.tables
          WHERE table_schema = 'public' AND table_name = 'RefreshToken'
        ) AND NOT EXISTS (
          SELECT 1 FROM information_schema.tables
          WHERE table_schema = 'public' AND table_name = 'refresh_token'
        ) THEN
          ALTER TABLE "RefreshToken" RENAME TO refresh_token;
        END IF;
      END $$;
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      DO $$ BEGIN
        IF EXISTS (
          SELECT 1 FROM information_schema.tables
          WHERE table_schema = 'public' AND table_name = 'refresh_token'
        ) AND NOT EXISTS (
          SELECT 1 FROM information_schema.tables
          WHERE table_schema = 'public' AND table_name = 'RefreshToken'
        ) THEN
          ALTER TABLE refresh_token RENAME TO "RefreshToken";
        END IF;
      END $$;
    `);
  }
}
