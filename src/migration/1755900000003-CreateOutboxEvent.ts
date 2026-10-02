import type { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * This migration creates the transactional outbox table for at-least-once delivery.
 * It handles durable buffering so business commit never depends on RabbitMQ.
 */
export class CreateOutboxEvent1755900000003 implements MigrationInterface {
  name = 'CreateOutboxEvent1755900000003';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`CREATE EXTENSION IF NOT EXISTS "uuid-ossp"`);

    await queryRunner.query(`
      DO $$ BEGIN
        CREATE TYPE "outbox_status" AS ENUM ('PENDING','PROCESSING','SENT','FAILED');
      EXCEPTION WHEN duplicate_object THEN null;
      END $$;
    `);

    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "outbox_event" (
        "id" uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
        "eventType" varchar(64) NOT NULL,
        "aggregateType" varchar(32) NOT NULL,
        "aggregateId" uuid NOT NULL,
        "payload" jsonb NOT NULL,
        "status" "outbox_status" NOT NULL DEFAULT 'PENDING',
        "attempts" integer NOT NULL DEFAULT 0,
        "nextRetryAt" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        "lastError" varchar(1000),
        "processingStartedAt" TIMESTAMPTZ,
        "createdAt" TIMESTAMPTZ NOT NULL DEFAULT now(),
        "sentAt" TIMESTAMPTZ,
        CONSTRAINT "CHK_outbox_attempts_non_negative" CHECK ("attempts" >= 0),
        CONSTRAINT "CHK_outbox_payload_version" CHECK ("payload"->>'version' IS NOT NULL)
      )
    `);

    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "IDX_outbox_status_nextRetryAt_createdAt" ON "outbox_event" ("status", "nextRetryAt", "createdAt")
    `);
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "IDX_outbox_eventType" ON "outbox_event" ("eventType")
    `);
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "IDX_outbox_aggregateId" ON "outbox_event" ("aggregateId")
    `);
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "IDX_outbox_createdAt" ON "outbox_event" ("createdAt" DESC)
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE IF EXISTS "outbox_event" CASCADE`);
    await queryRunner.query(`DROP TYPE IF EXISTS "outbox_status"`);
  }
}
