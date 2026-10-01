import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * This migration is responsible for Phase 18 email/delivery-state persistence (specs/014-email-service T008+T065).
 * It handles User opt-in flags, EmailVerificationToken, Notification history/delivery tables and OutboxStatus widening.
 */
export class NotificationDeliveryAndHistory1755900000006 implements MigrationInterface {
  name = 'NotificationDeliveryAndHistory1755900000006';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`CREATE EXTENSION IF NOT EXISTS "uuid-ossp"`);

    // --- User opt-in flags (data-model §2) ---------------------------------
    // marketingOptIn gates sales/news bulk; emailOptIn gates the email channel (verify/reset bypass both)
    await queryRunner.query(`
      ALTER TABLE "user" ADD COLUMN IF NOT EXISTS "marketingOptIn" boolean NOT NULL DEFAULT false
    `);
    await queryRunner.query(`
      ALTER TABLE "user" ADD COLUMN IF NOT EXISTS "emailOptIn" boolean NOT NULL DEFAULT true
    `);

    // --- Enum types for the notification legs (data-model §3b/§3c) ---------
    await queryRunner.query(`
      DO $$ BEGIN
        CREATE TYPE "notification_channel" AS ENUM ('SYSTEM','EMAIL');
      EXCEPTION WHEN duplicate_object THEN null;
      END $$;
    `);
    await queryRunner.query(`
      DO $$ BEGIN
        CREATE TYPE "notification_status" AS ENUM ('PENDING','SENT','DELIVERED','FAILED');
      EXCEPTION WHEN duplicate_object THEN null;
      END $$;
    `);

    // --- Widen outbox_status (FR-016; SENT value is kept, never removed) ----
    // Each ADD VALUE is guarded so the migration is re-runnable. The new values
    // are not used inside this transaction (PG only allows use after commit).
    await queryRunner.query(`
      DO $$ BEGIN
        IF NOT EXISTS (
          SELECT 1 FROM pg_enum e JOIN pg_type t ON t.oid = e.enumtypid
          WHERE t.typname = 'outbox_status' AND e.enumlabel = 'SENT_TO_MQ'
        ) THEN
          ALTER TYPE "outbox_status" ADD VALUE 'SENT_TO_MQ';
        END IF;
      END $$;
    `);
    await queryRunner.query(`
      DO $$ BEGIN
        IF NOT EXISTS (
          SELECT 1 FROM pg_enum e JOIN pg_type t ON t.oid = e.enumtypid
          WHERE t.typname = 'outbox_status' AND e.enumlabel = 'CONSUMED'
        ) THEN
          ALTER TYPE "outbox_status" ADD VALUE 'CONSUMED';
        END IF;
      END $$;
    `);
    await queryRunner.query(`
      DO $$ BEGIN
        IF NOT EXISTS (
          SELECT 1 FROM pg_enum e JOIN pg_type t ON t.oid = e.enumtypid
          WHERE t.typname = 'outbox_status' AND e.enumlabel = 'DELIVERED'
        ) THEN
          ALTER TYPE "outbox_status" ADD VALUE 'DELIVERED';
        END IF;
      END $$;
    `);

    // --- outbox_event.consumedAt (data-model §3d) ---------------------------
    await queryRunner.query(`
      ALTER TABLE "outbox_event" ADD COLUMN IF NOT EXISTS "consumedAt" TIMESTAMPTZ
    `);

    // --- email_verification_token (FR-001, data-model §1) -------------------
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

    // --- notification (data-model §3b, user-leg history truth) --------------
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "notification" (
        "id" uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
        "userId" uuid NOT NULL REFERENCES "user"("id") ON DELETE CASCADE,
        "eventId" uuid NOT NULL,
        "channel" "notification_channel" NOT NULL,
        "type" varchar(64) NOT NULL,
        "title" varchar(256) NOT NULL,
        "body" text NOT NULL,
        "data" jsonb NOT NULL DEFAULT '{}',
        "status" "notification_status" NOT NULL DEFAULT 'PENDING',
        "isRead" boolean NOT NULL DEFAULT false,
        "readAt" TIMESTAMPTZ,
        "sentAt" TIMESTAMPTZ NOT NULL DEFAULT now(),
        "deliveredAt" TIMESTAMPTZ,
        CONSTRAINT "UQ_notification_eventId_channel" UNIQUE ("eventId", "channel")
      )
    `);
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "IDX_notification_userId" ON "notification" ("userId")`,
    );
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "IDX_notification_eventId" ON "notification" ("eventId")`,
    );
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "IDX_notification_channel" ON "notification" ("channel")`,
    );
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "IDX_notification_type" ON "notification" ("type")`,
    );
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "IDX_notification_userId_sentAt" ON "notification" ("userId", "sentAt" DESC)`,
    );
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "IDX_notification_userId_isRead" ON "notification" ("userId", "isRead")`,
    );

    // --- notification_delivery (data-model §3c, per-channel leg) ------------
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "notification_delivery" (
        "id" uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
        "eventId" uuid NOT NULL,
        "channel" "notification_channel" NOT NULL,
        "status" "notification_status" NOT NULL DEFAULT 'PENDING',
        "attempts" integer NOT NULL DEFAULT 0,
        "messageId" varchar(256),
        "nextRetryAt" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        "deliveredAt" TIMESTAMPTZ,
        CONSTRAINT "CHK_notification_delivery_attempts_non_negative" CHECK ("attempts" >= 0),
        CONSTRAINT "UQ_notification_delivery_eventId_channel" UNIQUE ("eventId", "channel")
      )
    `);
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "IDX_notification_delivery_eventId" ON "notification_delivery" ("eventId")`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE IF EXISTS "notification_delivery"`);
    await queryRunner.query(`DROP TABLE IF EXISTS "notification"`);
    await queryRunner.query(`DROP TABLE IF EXISTS "email_verification_token"`);
    await queryRunner.query(
      `ALTER TABLE "outbox_event" DROP COLUMN IF EXISTS "consumedAt"`,
    );
    await queryRunner.query(`DROP TYPE IF EXISTS "notification_status"`);
    await queryRunner.query(`DROP TYPE IF EXISTS "notification_channel"`);
    await queryRunner.query(
      `ALTER TABLE "user" DROP COLUMN IF EXISTS "emailOptIn"`,
    );
    await queryRunner.query(
      `ALTER TABLE "user" DROP COLUMN IF EXISTS "marketingOptIn"`,
    );
    // Added outbox_status values (SENT_TO_MQ, CONSUMED, DELIVERED) are intentionally
    // retained: PG offers no safe transactional enum-value removal and live rows may reference them.
  }
}
