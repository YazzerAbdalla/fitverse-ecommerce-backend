import { Payment } from '../entities/payment.entity';

export interface PaymentStrategyInterface {
  createCheckoutSession(
    data: Partial<Payment>,
  ): Promise<{ session_link: string }>;
}
