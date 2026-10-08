import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { InventoryModule } from '../inventory/inventory.module';
import { ProductsModule } from '../products/products.module';
import { AdminProductsController } from './admin-products.controller';
import { AdminProductsService } from './admin-products.service';

/**
 * This module exposes the admin/operational dashboard surface.
 * It aggregates the existing ProductsService and InventoryService
 * (service-only collaboration, one-way edges) and owns no tables.
 * Demo scope (019): admin product list, product creation, stock adjust.
 */
@Module({
  imports: [ProductsModule, InventoryModule, AuthModule],
  controllers: [AdminProductsController],
  providers: [AdminProductsService],
  exports: [AdminProductsService],
})
export class DashboardModule {}
