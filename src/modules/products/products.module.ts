import { ConfigService } from '@nestjs/config';
import { Logger, Module, forwardRef } from '@nestjs/common';
import { ProductsService } from './products.service';
import { ProductsResolver } from './products.resolver';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Product } from './entities/product.entity';
import { InventoryModule } from '../inventory/inventory.module';

@Module({
  imports: [
    TypeOrmModule.forFeature([Product]),
    forwardRef(() => InventoryModule),
  ],
  providers: [ProductsResolver, ProductsService, Logger],
  exports: [ProductsService],
})
export class ProductsModule {}
