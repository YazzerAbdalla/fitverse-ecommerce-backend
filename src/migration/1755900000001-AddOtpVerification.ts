import { MigrationInterface, QueryRunner } from 'typeorm';

export class AddOtpVerification1755900000001 implements MigrationInterface {
  name = 'AddOtpVerification1755900000001';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`CREATE EXTENSION IF NOT EXISTS "uuid-ossp"`);
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "otp_verification" (
        "id" uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
        "phoneNumber" varchar NOT NULL,
        "userId" uuid,
        "purpose" varchar NOT NULL DEFAULT 'login',
        "codeHash" varchar NOT NULL,
        "expiresAt" TIMESTAMPTZ NOT NULL,
        "attempts" integer NOT NULL DEFAULT 0,
        "verifiedAt" TIMESTAMPTZ,
        "createdAt" TIMESTAMPTZ NOT NULL DEFAULT now(),
        CONSTRAINT "CHK_otp_expires_gt_created" CHECK ("expiresAt" > "createdAt"),
        CONSTRAINT "CHK_otp_attempts_lte_3" CHECK ("attempts" <= 3),
        CONSTRAINT "CHK_otp_purpose" CHECK ("purpose" IN ('login','verify_phone')),
        CONSTRAINT "FK_otp_verification_userId" FOREIGN KEY ("userId") REFERENCES "user"("id") ON DELETE SET NULL
      )
    `);
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "IDX_otp_verification_phoneNumber" ON "otp_verification" ("phoneNumber")`,
    );
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "IDX_otp_verification_expiresAt" ON "otp_verification" ("expiresAt")`,
    );
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "IDX_otp_verification_phoneNumber_createdAt" ON "otp_verification" ("phoneNumber", "createdAt")`,
    );
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "IDX_otp_verification_userId" ON "otp_verification" ("userId")`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE IF EXISTS "otp_verification"`);
  }
}
