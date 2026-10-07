import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { AuthModule } from '../auth/auth.module';
import { OrderModule } from '../order/order.module';
import { Payment } from './entities/payment.entity';
import { PaymentService } from './payment.service';
import { PaymentController } from './payment.controller';

/**
 * This module handles the payment simulation domain (demo, no real provider).
 * It owns Payment persistence and orchestrates the existing order completion
 * and cancellation cores inside single transactions.
 */
@Module({
  imports: [TypeOrmModule.forFeature([Payment]), AuthModule, OrderModule],
  controllers: [PaymentController],
  providers: [PaymentService],
  exports: [PaymentService],
})
export class PaymentModule {}
