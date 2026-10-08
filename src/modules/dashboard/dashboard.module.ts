import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { InventoryModule } from '../inventory/inventory.module';
import { ProductsModule } from '../products/products.module';

/**
 * This module exposes the admin/operational dashboard surface.
 * It aggregates the existing ProductsService and InventoryService
 * (service-only collaboration, one-way edges) and owns no tables.
 * Demo scope (019): admin product list, product creation, stock adjust.
 */
@Module({
  imports: [ProductsModule, InventoryModule, AuthModule],
  controllers: [],
  providers: [],
})
export class DashboardModule {}
