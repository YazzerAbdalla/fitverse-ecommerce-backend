import type { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * This migration adds processingToken for safe lease ownership (Correction 2).
 * It handles publisher race where A claims, hangs, B reclaims, A must not overwrite B.
 */
export class AddOutboxProcessingToken1755900000004 implements MigrationInterface {
  name = 'AddOutboxProcessingToken1755900000004';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "outbox_event" ADD COLUMN IF NOT EXISTS "processingToken" varchar(36)
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "outbox_event" DROP COLUMN IF EXISTS "processingToken"
    `);
  }
}
