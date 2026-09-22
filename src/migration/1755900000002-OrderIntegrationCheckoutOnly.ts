import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * This migration fixes Order/OrderItem schema for checkout-only refactor.
 * It handles idempotent corrections for OrderStatus enum, Order/OrderItem columns, constraints and indexes.
 */
export class OrderIntegrationCheckoutOnly1755900000002 implements MigrationInterface {
  name = 'OrderIntegrationCheckoutOnly1755900000002';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`CREATE EXTENSION IF NOT EXISTS "uuid-ossp"`);

    // 1. Drop spurious ManyToMany join table if exists
    await queryRunner.query(
      `DROP TABLE IF EXISTS "order_order_items_order_item" CASCADE`,
    );
    await queryRunner.query(
      `DROP TABLE IF EXISTS "order_order_items_order_item" CASCADE`,
    );

    // 2. Fix OrderStatus enum type (order_status or OrderStatus or order_status_enum depending on TypeORM naming)
    // Try to handle generic enum type names: check what exists
    await queryRunner.query(`
      DO $$
      DECLARE
        enum_exists boolean;
        enum_name text;
      BEGIN
        -- TypeORM creates enum type named "order_status" for OrderStatus or "Order_status" etc.
        -- Detect existing enum type for order.status column
        SELECT EXISTS (
          SELECT 1 FROM pg_type WHERE typname = 'order_status'
        ) INTO enum_exists;
        IF enum_exists THEN
          enum_name := 'order_status';
        ELSE
          SELECT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'Order_status') INTO enum_exists;
          IF enum_exists THEN enum_name := 'Order_status'; END IF;
        END IF;

        IF enum_name IS NOT NULL THEN
          -- Rename SUCCESS -> COMPLETED if exists
          BEGIN
            IF EXISTS (SELECT 1 FROM pg_enum WHERE enumlabel='SUCCESS' AND enumtypid = enum_name::regtype) THEN
              EXECUTE format('ALTER TYPE %I RENAME VALUE %L TO %L', enum_name, 'SUCCESS', 'COMPLETED');
            END IF;
          EXCEPTION WHEN others THEN NULL; END;

          BEGIN
            IF EXISTS (SELECT 1 FROM pg_enum WHERE enumlabel='FAILD' AND enumtypid = enum_name::regtype) THEN
              EXECUTE format('ALTER TYPE %I RENAME VALUE %L TO %L', enum_name, 'FAILD', 'FAILED');
            END IF;
          EXCEPTION WHEN others THEN NULL; END;

          -- Add missing values
          BEGIN
            IF NOT EXISTS (SELECT 1 FROM pg_enum WHERE enumlabel='CANCELLED' AND enumtypid = enum_name::regtype) THEN
              EXECUTE format('ALTER TYPE %I ADD VALUE %L', enum_name, 'CANCELLED');
            END IF;
          EXCEPTION WHEN others THEN NULL; END;

          BEGIN
            IF NOT EXISTS (SELECT 1 FROM pg_enum WHERE enumlabel='COMPLETED' AND enumtypid = enum_name::regtype) THEN
              EXECUTE format('ALTER TYPE %I ADD VALUE %L', enum_name, 'COMPLETED');
            END IF;
          EXCEPTION WHEN others THEN NULL; END;

          BEGIN
            IF NOT EXISTS (SELECT 1 FROM pg_enum WHERE enumlabel='FAILED' AND enumtypid = enum_name::regtype) THEN
              EXECUTE format('ALTER TYPE %I ADD VALUE %L', enum_name, 'FAILED');
            END IF;
          EXCEPTION WHEN others THEN NULL; END;

          BEGIN
            IF NOT EXISTS (SELECT 1 FROM pg_enum WHERE enumlabel='PENDING' AND enumtypid = enum_name::regtype) THEN
              EXECUTE format('ALTER TYPE %I ADD VALUE %L', enum_name, 'PENDING');
            END IF;
          EXCEPTION WHEN others THEN NULL; END;
        ELSE
          -- No enum type yet, create one for future
          BEGIN
            EXECUTE 'CREATE TYPE "order_status" AS ENUM (''PENDING'',''COMPLETED'',''CANCELLED'',''FAILED'')';
          EXCEPTION WHEN duplicate_object THEN NULL; END;
        END IF;
      END
      $$;
    `);

    // Ensure order_status exists even if previous block didn't create due to name mismatch
    await queryRunner.query(`
      DO $$ BEGIN
        IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname='order_status') THEN
          CREATE TYPE "order_status" AS ENUM ('PENDING','COMPLETED','CANCELLED','FAILED');
        END IF;
      END $$;
    `);

    // 3. Fix Order table
    // Ensure table exists (if not, create minimal)
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "order" (
        "id" uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
        "userId" uuid,
        "status" "order_status" NOT NULL DEFAULT 'PENDING',
        "total" integer NOT NULL DEFAULT 0,
        "created_at" TIMESTAMPTZ NOT NULL DEFAULT now(),
        "updated_at" TIMESTAMPTZ NOT NULL DEFAULT now()
      );
    `);

    // Add missing columns idempotently
    await queryRunner.query(`
      DO $$ BEGIN
        IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='order' AND column_name='userId') THEN
          ALTER TABLE "order" ADD COLUMN "userId" uuid;
        END IF;
        IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='order' AND column_name='total') THEN
          ALTER TABLE "order" ADD COLUMN "total" integer NOT NULL DEFAULT 0;
        END IF;
        IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='order' AND column_name='status') THEN
          ALTER TABLE "order" ADD COLUMN "status" "order_status" NOT NULL DEFAULT 'PENDING';
        END IF;
        IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='order' AND column_name='created_at') THEN
          ALTER TABLE "order" ADD COLUMN "created_at" TIMESTAMPTZ NOT NULL DEFAULT now();
        END IF;
        IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='order' AND column_name='updated_at') THEN
          ALTER TABLE "order" ADD COLUMN "updated_at" TIMESTAMPTZ NOT NULL DEFAULT now();
        END IF;
      END $$;
    `);

    // Ensure total column type is integer (if it was bigint from total_price legacy, we keep total column separate)
    // Migrate total_price -> total if needed
    await queryRunner.query(`
      DO $$ BEGIN
        IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='order' AND column_name='total_price') THEN
          -- copy values if total still 0 and total_price has data
          UPDATE "order" SET "total" = CAST("total_price" AS integer) WHERE "total" = 0 AND "total_price" IS NOT NULL;
        END IF;
      END $$;
    `);

    // Add CHECK and indexes, FK idempotently
    await queryRunner.query(`
      DO $$ BEGIN
        IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='CHK_order_total_non_negative') THEN
          ALTER TABLE "order" ADD CONSTRAINT "CHK_order_total_non_negative" CHECK ("total" >= 0);
        END IF;
      EXCEPTION WHEN duplicate_object THEN NULL; END $$;
    `);
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "IDX_order_userId" ON "order" ("userId")`,
    );
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "IDX_order_status" ON "order" ("status")`,
    );

    // FK to user
    await queryRunner.query(`
      DO $$ BEGIN
        IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='FK_order_userId') THEN
          ALTER TABLE "order" ADD CONSTRAINT "FK_order_userId" FOREIGN KEY ("userId") REFERENCES "user"("id") ON DELETE CASCADE;
        END IF;
      EXCEPTION WHEN duplicate_object THEN NULL; END $$;
    `);

    // Try to drop old total_price column if exists (optional, keep backwards compat if needed)
    // Keep it to avoid breaking old data, but we could drop - leave for now to be safe
    // await queryRunner.query(`ALTER TABLE "order" DROP COLUMN IF EXISTS "total_price"`);

    // 4. Fix OrderItem table (named "order_item" or "order_items"? TypeORM default is "order_item" from OrderItem class)
    // Detect actual table name: try both
    await queryRunner.query(`
      DO $$ BEGIN
        IF NOT EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name='order_item') AND NOT EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name='order_items') THEN
          CREATE TABLE "order_item" (
            "id" uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
            "orderId" uuid NOT NULL,
            "productId" uuid NOT NULL,
            "quantity" integer NOT NULL DEFAULT 1,
            "unit_price" integer NOT NULL DEFAULT 0,
            "productNameSnapshot" varchar,
            "subtotal" integer GENERATED ALWAYS AS ("quantity" * "unit_price") STORED
          );
        END IF;
      END $$;
    `);

    // Ensure order_item has required columns
    await queryRunner.query(`
      DO $$ BEGIN
        IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name='order_item') THEN
          IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='order_item' AND column_name='orderId') THEN
            ALTER TABLE "order_item" ADD COLUMN "orderId" uuid;
          END IF;
          IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='order_item' AND column_name='productId') THEN
            ALTER TABLE "order_item" ADD COLUMN "productId" uuid;
          END IF;
          IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='order_item' AND column_name='quantity') THEN
            ALTER TABLE "order_item" ADD COLUMN "quantity" integer NOT NULL DEFAULT 1;
          END IF;
          IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='order_item' AND column_name='unit_price') THEN
            ALTER TABLE "order_item" ADD COLUMN "unit_price" integer NOT NULL DEFAULT 0;
          END IF;
          IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='order_item' AND column_name='productNameSnapshot') THEN
            ALTER TABLE "order_item" ADD COLUMN "productNameSnapshot" varchar;
          END IF;
        END IF;
        IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name='order_items') THEN
          IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='order_items' AND column_name='orderId') THEN
            ALTER TABLE "order_items" ADD COLUMN "orderId" uuid;
          END IF;
          IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='order_items' AND column_name='productId') THEN
            ALTER TABLE "order_items" ADD COLUMN "productId" uuid;
          END IF;
        END IF;
      END $$;
    `);

    // Add constraints/indexes for order_item
    await queryRunner.query(`
      DO $$ BEGIN
        IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name='order_item') THEN
          IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='CHK_order_item_quantity_positive') THEN
            ALTER TABLE "order_item" ADD CONSTRAINT "CHK_order_item_quantity_positive" CHECK ("quantity" > 0);
          END IF;
          IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='CHK_order_item_unit_price_non_negative') THEN
            ALTER TABLE "order_item" ADD CONSTRAINT "CHK_order_item_unit_price_non_negative" CHECK ("unit_price" >= 0);
          END IF;
          IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='UQ_order_item_order_product') THEN
            ALTER TABLE "order_item" ADD CONSTRAINT "UQ_order_item_order_product" UNIQUE ("orderId","productId");
          END IF;
        END IF;
      EXCEPTION WHEN duplicate_object THEN NULL; END $$;
    `);
    // Same for order_items table name variant
    await queryRunner.query(`
      DO $$ BEGIN
        IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name='order_items') THEN
          IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='CHK_order_items_quantity_positive') THEN
            ALTER TABLE "order_items" ADD CONSTRAINT "CHK_order_items_quantity_positive" CHECK ("quantity" > 0);
          END IF;
          IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='UQ_order_items_order_product') THEN
            ALTER TABLE "order_items" ADD CONSTRAINT "UQ_order_items_order_product" UNIQUE ("orderId","productId");
          END IF;
        END IF;
      EXCEPTION WHEN duplicate_object THEN NULL; END $$;
    `);

    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "IDX_order_item_orderId" ON "order_item" ("orderId")`,
    );
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "IDX_order_item_productId" ON "order_item" ("productId")`,
    );
    // also for alternative table
    await queryRunner.query(
      `DO $$ BEGIN IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name='order_items') THEN CREATE INDEX IF NOT EXISTS "IDX_order_items_orderId" ON "order_items" ("orderId"); CREATE INDEX IF NOT EXISTS "IDX_order_items_productId" ON "order_items" ("productId"); END IF; END $$;`,
    );

    // FKs
    await queryRunner.query(`
      DO $$ BEGIN
        IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name='order_item') THEN
          IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='FK_order_item_orderId') THEN
            ALTER TABLE "order_item" ADD CONSTRAINT "FK_order_item_orderId" FOREIGN KEY ("orderId") REFERENCES "order"("id") ON DELETE CASCADE;
          END IF;
          IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='FK_order_item_productId') THEN
            ALTER TABLE "order_item" ADD CONSTRAINT "FK_order_item_productId" FOREIGN KEY ("productId") REFERENCES "product"("id") ON DELETE RESTRICT;
          END IF;
        END IF;
      EXCEPTION WHEN duplicate_object THEN NULL; END $$;
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE IF EXISTS "order_item" CASCADE`);
    await queryRunner.query(`DROP TABLE IF EXISTS "order_items" CASCADE`);
    // Enum revert not needed
  }
}
