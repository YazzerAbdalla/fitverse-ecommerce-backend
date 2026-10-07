import type { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * This migration is responsible for Payment persistence (Phase 19 simulation demo).
 * It handles one payment per order with server-copied amount and simulation outcome.
 */
export class CreatePayment1755900000012 implements MigrationInterface {
  name = 'CreatePayment1755900000012';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`CREATE EXTENSION IF NOT EXISTS "uuid-ossp"`);
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "Payment" (
        "id" uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
        "orderId" uuid NOT NULL UNIQUE REFERENCES "Order"("id") ON DELETE CASCADE,
        "userId" uuid NOT NULL REFERENCES "user"("id") ON DELETE CASCADE,
        "amount" integer NOT NULL DEFAULT 0,
        "currency" varchar(3) NOT NULL DEFAULT 'usd',
        "status" varchar NOT NULL DEFAULT 'PENDING',
        "provider" varchar NOT NULL DEFAULT 'simulation',
        "failureReason" varchar,
        "createdAt" timestamptz NOT NULL DEFAULT now(),
        "updatedAt" timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT "CHK_payment_amount_non_negative" CHECK ("amount" >= 0)
      )
    `);
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "IDX_payment_userId_status" ON "Payment"("userId","status")`,
    );
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "IDX_payment_status_createdAt" ON "Payment"("status","createdAt")`,
    );
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "IDX_payment_status" ON "Payment"("status")`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE IF EXISTS "Payment"`);
  }
}
