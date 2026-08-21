import { Injectable, Logger } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { Product } from '../products/entities/product.entity';
import { Inventory } from './entities/inventory.entity';

@Injectable()
export class InventorySeeder {
  private readonly logger = new Logger(InventorySeeder.name);
  private hasRun = false;

  constructor(private readonly dataSource: DataSource) {}

  async seed(): Promise<void> {
    if (this.hasRun) {
      this.logger.debug('InventorySeeder already executed, skipping');
      return;
    }

    // Check if Product table has stock column is not straightforward;
    // we just attempt to load products and tolerate missing column on later runs.
    let products: Product[];
    try {
      products = await this.dataSource.getRepository(Product).find();
    } catch (error) {
      this.logger.warn(
        `Failed to load products for seeding: ${error instanceof Error ? error.message : String(error)}`,
      );
      this.hasRun = true;
      return;
    }

    if (products.length === 0) {
      this.logger.debug('No products found to seed inventory');
      this.hasRun = true;
      return;
    }

    const inventoryRepo = this.dataSource.getRepository(Inventory);

    const existingInventories = await inventoryRepo.find();
    const existingProductIds = new Set(
      existingInventories.map((inv) => inv.productId),
    );

    const toCreate: Partial<Inventory>[] = [];

    for (const product of products) {
      if (existingProductIds.has(product.id)) {
        continue;
      }

      // Generate random stock for current products (10-200)
      // Tolerate Product.stock if it still exists (use it if present, otherwise random)
      const productAsAny = product as unknown as Record<string, unknown>;
      const rawStock = productAsAny['stock'];
      let stock: number;
      if (typeof rawStock === 'number' && Number.isFinite(rawStock)) {
        stock = rawStock;
      } else {
        // Random stock 10-200 for seeding existing products
        stock = Math.floor(Math.random() * 191) + 10;
      }

      toCreate.push({
        productId: product.id,
        stock,
        reservedAmount: 0,
      });
    }

    if (toCreate.length === 0) {
      this.logger.debug('All products already have inventory, nothing to seed');
      this.hasRun = true;
      return;
    }

    const created = inventoryRepo.create(toCreate);
    await inventoryRepo.save(created);
    this.logger.log(`Seeded ${created.length} inventory records`);
    this.hasRun = true;
  }
}
