import type { MigrationInterface, QueryRunner } from 'typeorm';

export class CreateReservationAndReservationItem1755850000000 implements MigrationInterface {
  name = 'CreateReservationAndReservationItem1755850000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `CREATE TYPE "reservation_status" AS ENUM ('RESERVED','COMPLETED','EXPIRED','CANCELLED')`,
    );

    await queryRunner.query(`
      CREATE TABLE "reservation" (
        "id" uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
        "userId" uuid NOT NULL,
        "orderId" uuid,
        "status" "reservation_status" NOT NULL DEFAULT 'RESERVED',
        "expiresAt" TIMESTAMPTZ NOT NULL,
        "createdAt" TIMESTAMPTZ NOT NULL DEFAULT now(),
        "updatedAt" TIMESTAMPTZ NOT NULL DEFAULT now(),
        CONSTRAINT "FK_reservation_userId" FOREIGN KEY ("userId") REFERENCES "user"("id") ON DELETE CASCADE,
        CONSTRAINT "FK_reservation_orderId" FOREIGN KEY ("orderId") REFERENCES "order"("id") ON DELETE SET NULL
      )
    `);

    await queryRunner.query(`
      CREATE TABLE "reservation_item" (
        "id" uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
        "reservationId" uuid NOT NULL,
        "inventoryId" uuid NOT NULL,
        "quantity" integer NOT NULL,
        "createdAt" TIMESTAMPTZ NOT NULL DEFAULT now(),
        "updatedAt" TIMESTAMPTZ NOT NULL DEFAULT now(),
        CONSTRAINT "FK_reservation_item_reservationId" FOREIGN KEY ("reservationId") REFERENCES "reservation"("id") ON DELETE CASCADE,
        CONSTRAINT "FK_reservation_item_inventoryId" FOREIGN KEY ("inventoryId") REFERENCES "inventory"("id") ON DELETE CASCADE,
        CONSTRAINT "CHK_reservation_item_quantity_positive" CHECK ("quantity" > 0),
        CONSTRAINT "UQ_reservation_item_reservation_inventory" UNIQUE ("reservationId", "inventoryId")
      )
    `);

    await queryRunner.query(
      `CREATE INDEX "IDX_reservation_userId" ON "reservation" ("userId")`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_reservation_status" ON "reservation" ("status")`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_reservation_expiresAt" ON "reservation" ("expiresAt")`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_reservation_status_expiresAt" ON "reservation" ("status", "expiresAt")`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_reservation_item_reservationId" ON "reservation_item" ("reservationId")`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_reservation_item_inventoryId" ON "reservation_item" ("inventoryId")`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE IF EXISTS "reservation_item" CASCADE`);
    await queryRunner.query(`DROP TABLE IF EXISTS "reservation" CASCADE`);
    await queryRunner.query(`DROP TYPE IF EXISTS "reservation_status"`);
  }
}
