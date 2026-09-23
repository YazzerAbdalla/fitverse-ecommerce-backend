import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { AuthModule } from '../auth/auth.module';
import { Order } from './entities/order.entity';
import { OrderItem } from './entities/order-items.entity';
import { OrderController } from './order.controller';
import { OrderService } from './order.service';
import { OrderCheckoutService } from './order-checkout.service';
import { OrderCompletionService } from './order-completion.service';
import { OrderCancellationService } from './order-cancellation.service';
import { ReservationModule } from '../reservation/reservation.module';
import { CartModule } from '../cart/cart.module';
import { ProductsModule } from '../products/products.module';
import { InventoryModule } from '../inventory/inventory.module';
import { OutboxModule } from '../outbox/outbox.module';

/**
 * This module handles Order domain.
 * It exposes checkout and read APIs and collaborates with Reservation/Cart/Products/Inventory.
 */
@Module({
  imports: [
    TypeOrmModule.forFeature([Order, OrderItem]),
    AuthModule,
    ReservationModule,
    CartModule,
    ProductsModule,
    InventoryModule,
    OutboxModule,
  ],
  controllers: [OrderController],
  providers: [
    OrderService,
    OrderCheckoutService,
    OrderCompletionService,
    OrderCancellationService,
  ],
  exports: [
    OrderService,
    OrderCheckoutService,
    OrderCompletionService,
    OrderCancellationService,
  ],
})
export class OrderModule {}
