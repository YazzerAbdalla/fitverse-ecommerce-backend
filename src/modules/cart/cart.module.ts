import { Logger, Module } from '@nestjs/common';
import { CartService } from './cart.service';
import { AuthModule } from '../auth/auth.module';
import { CartController } from './cart.controller';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Cart } from './entities/cart.entity';
import { CartItem } from './entities/cart-items.entity';
import { ProductsModule } from '../products/products.module';
import { InventoryModule } from '../inventory/inventory.module';

@Module({
  imports: [
    TypeOrmModule.forFeature([Cart, CartItem]),
    AuthModule,
    ProductsModule,
    InventoryModule,
  ],
  controllers: [CartController],
  providers: [CartService, Logger],
  exports: [CartService],
})
export class CartModule {}
