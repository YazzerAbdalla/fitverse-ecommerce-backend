import { MigrationInterface, QueryRunner } from 'typeorm';

export class CreateInventoryAndDropProductStock1755800000000
  implements MigrationInterface
{
  name = 'CreateInventoryAndDropProductStock1755800000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    // Ensure uuid generation extension exists (TypeORM uses uuid_generate_v4())
    await queryRunner.query(`CREATE EXTENSION IF NOT EXISTS "uuid-ossp"`);

    // 1. Create inventory table if not exists (matches Inventory entity)
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "inventory" (
        "id" uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
        "productId" uuid NOT NULL,
        "stock" integer NOT NULL DEFAULT 0,
        "reservedAmount" integer NOT NULL DEFAULT 0,
        "createdAt" TIMESTAMP NOT NULL DEFAULT now(),
        "updatedAt" TIMESTAMP NOT NULL DEFAULT now(),
        CONSTRAINT "CHK_inventory_stock_non_negative" CHECK ("stock" >= 0),
        CONSTRAINT "CHK_inventory_reserved_non_negative" CHECK ("reservedAmount" >= 0),
        CONSTRAINT "CHK_inventory_reserved_lte_stock" CHECK ("reservedAmount" <= "stock"),
        CONSTRAINT "UQ_inventory_productId" UNIQUE ("productId"),
        CONSTRAINT "FK_inventory_productId" FOREIGN KEY ("productId") REFERENCES "product"("id") ON DELETE CASCADE
      )
    `);

    // Create index on productId if not exists (TypeORM creates IDX + UQ)
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "IDX_inventory_productId" ON "inventory" ("productId")
    `);

    // 2. Seed inventory from existing Product.stock if that column still exists
    //    Idempotent: only inserts where no inventory yet, tolerates missing column
    await queryRunner.query(`
      DO $$
      BEGIN
        IF EXISTS (
          SELECT 1 FROM information_schema.columns
          WHERE table_name = 'product' AND column_name = 'stock'
        ) THEN
          INSERT INTO "inventory" ("id", "productId", "stock", "reservedAmount", "createdAt", "updatedAt")
          SELECT uuid_generate_v4(), p."id", p."stock", 0, NOW(), NOW()
          FROM "product" p
          WHERE NOT EXISTS (
            SELECT 1 FROM "inventory" i WHERE i."productId" = p."id"
          );
        END IF;
      END
      $$;
    `);

    // 3. Drop Product.stock column if it exists (and its check constraint is dropped automatically)
    await queryRunner.query(`
      DO $$
      BEGIN
        IF EXISTS (
          SELECT 1 FROM information_schema.columns
          WHERE table_name = 'product' AND column_name = 'stock'
        ) THEN
          ALTER TABLE "product" DROP COLUMN "stock";
        END IF;
      END
      $$;
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    // 1. Restore Product.stock column if not exists
    await queryRunner.query(`
      DO $$
      BEGIN
        IF NOT EXISTS (
          SELECT 1 FROM information_schema.columns
          WHERE table_name = 'product' AND column_name = 'stock'
        ) THEN
          ALTER TABLE "product" ADD COLUMN "stock" integer NOT NULL DEFAULT 0;
          ALTER TABLE "product" ADD CONSTRAINT "CHK_product_stock_non_negative" CHECK ("stock" >= 0);
        END IF;
      END
      $$;
    `);

    // 2. Restore Product.stock values from Inventory where possible
    await queryRunner.query(`
      DO $$
      BEGIN
        IF EXISTS (
          SELECT 1 FROM information_schema.columns
          WHERE table_name = 'product' AND column_name = 'stock'
        ) AND EXISTS (
          SELECT 1 FROM information_schema.tables WHERE table_name = 'inventory'
        ) THEN
          UPDATE "product" p SET "stock" = i."stock"
          FROM "inventory" i
          WHERE i."productId" = p."id";
        END IF;
      END
      $$;
    `);

    // 3. Drop inventory table (and its indexes/constraints)
    await queryRunner.query(`DROP TABLE IF EXISTS "inventory" CASCADE`);
  }
}
