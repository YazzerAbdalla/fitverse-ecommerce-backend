import type { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * This migration creates the notification_log audit table.
 * It was defined in code (NotificationLog entity) but never covered by any
 * migration file, so worker audit inserts fail-soft until this runs.
 */
export class CreateNotificationLog1755900000008
  implements MigrationInterface
{
  name = 'CreateNotificationLog1755900000008';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "notification_log" (
        "id" uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
        "userId" uuid NOT NULL,
        "template" varchar(64) NOT NULL,
        "subject" varchar(256),
        "aggregateId" uuid,
        "eventId" uuid NOT NULL UNIQUE,
        "provider" varchar(32) NOT NULL DEFAULT 'noop',
        "messageId" varchar(256),
        "sentAt" TIMESTAMPTZ NOT NULL DEFAULT now()
      )
    `);
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "IDX_notification_log_userId" ON "notification_log" ("userId")`,
    );
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "IDX_notification_log_aggregateId" ON "notification_log" ("aggregateId")`,
    );
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "IDX_notification_log_template" ON "notification_log" ("template")`,
    );
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "IDX_notification_log_eventId" ON "notification_log" ("eventId")`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE IF EXISTS "notification_log"`);
  }
}
