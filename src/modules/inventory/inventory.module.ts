import { Module } from '@nestjs/common';
import { InventoryService } from './inventory.service';
import { ProductsModule } from '../products/products.module';

@Module({
  imports: [ProductsModule],
  providers: [InventoryService],
})
export class InventoryModule {}
