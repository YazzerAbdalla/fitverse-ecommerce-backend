import {
  Inject,
  Injectable,
  InternalServerErrorException,
} from '@nestjs/common';
import { PaymentStrategyInterface } from './strategy.interface';
import { Payment } from '../entities/payment.entity';
import Stripe from 'stripe';
import { ConfigService } from '@nestjs/config';

@Injectable()
export class StripStrategy implements PaymentStrategyInterface {
  private stripe: Stripe;

  constructor(
    @Inject('STRIPE_API_KEY') private readonly apiKey: string,
    private readonly configService: ConfigService,
  ) {
    if (!this.apiKey) throw new Error('Stripe API Key is missing');
    this.stripe = new Stripe(this.apiKey, { apiVersion: '2026-09-30.endive' });
  }

  async createCheckoutSession(data: Partial<Payment>): Promise<{
    session_link: string;
  }> {
    const amountInCents = Math.round(data.amount! * 100);

    const session = await this.stripe.checkout.sessions.create({
      line_items: [
        {
          price_data: {
            currency: data.currency || 'usd',
            product_data: {
              name: `Order #${data.orderId!}`, // Generic name covering the whole cart
              description: 'Total checkout amount', // Optional details
            },
            unit_amount: amountInCents,
          },
          quantity: 1, // Quantity is always 1 for a combined total
        },
      ],
      mode: 'payment',
      success_url: `${this.configService.get<string>('FRONTEND_SUCCESS_URL')}?order_id=${data.orderId!}`,
      cancel_url: this.configService.get<string>('FRONTEND_CANCEL_URL'),
      // Storing your internal orderId in metadata is highly recommended
      metadata: {
        orderId: data.orderId!,
      },
    });

    if (!session.url) {
      throw new InternalServerErrorException(
        'Stripe did not return a Checkout URL',
      );
    }

    return { session_link: session.url };
  }
}
