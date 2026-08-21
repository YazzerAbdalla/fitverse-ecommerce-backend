import { Module, OnModuleInit, forwardRef } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Inventory } from './entities/inventory.entity';
import { InventoryService } from './inventory.service';
import { InventorySeeder } from './inventory.seeder';
import { InventoryController } from './inventory.controller';
import { ProductsModule } from '../products/products.module';

@Module({
  imports: [
    TypeOrmModule.forFeature([Inventory]),
    forwardRef(() => ProductsModule),
  ],
  controllers: [InventoryController],
  providers: [InventoryService, InventorySeeder],
  exports: [InventoryService],
})
export class InventoryModule implements OnModuleInit {
  constructor(private readonly seeder: InventorySeeder) {}

  async onModuleInit(): Promise<void> {
    await this.seeder.seed();
  }
}
