import { Injectable } from '@nestjs/common';
import { PaymentStrategyInterface } from './payment-strategy.interface';
import { Payment } from '../entities/payment.entity';

@Injectable()
export class LocalSimulationPaymentStrategy implements PaymentStrategyInterface {
  createCheckoutSession(
    data: Partial<Payment>,
  ): Promise<{ session_link: string }> {
    return Promise.resolve({ session_link: 'test' });
  }
}
