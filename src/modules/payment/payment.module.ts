import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { AuthModule } from '../auth/auth.module';
import { OrderModule } from '../order/order.module';
import { Payment } from './entities/payment.entity';
import { PaymentService } from './payment.service';
import { PaymentController } from './payment.controller';
import { StripeStrategy } from './strategies/stripe.strategy';
import { ConfigService } from '@nestjs/config';
import { LocalSimulationPaymentStrategy } from './strategies/local-simulation.strategy';
import { PaymentStrategyFactory } from './payment-strategy.factory';

/**
 * This module handles the payment simulation domain (demo, no real provider).
 * It owns Payment persistence and orchestrates the existing order completion
 * and cancellation cores inside single transactions.
 */
@Module({
  imports: [TypeOrmModule.forFeature([Payment]), AuthModule, OrderModule],
  controllers: [PaymentController],
  providers: [
    PaymentService,
    StripeStrategy,
    LocalSimulationPaymentStrategy,
    PaymentStrategyFactory,
    {
      provide: 'STRIPE_API_KEY',
      useFactory: (configService: ConfigService) =>
        configService.get<string>('STRIPE_API_KEY'),
      inject: [ConfigService],
    },
  ],
  exports: [PaymentService],
})
export class PaymentModule {}
