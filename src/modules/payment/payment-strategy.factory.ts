import { Injectable, InternalServerErrorException } from '@nestjs/common';
import { StripeStrategy } from './strategies/stripe.strategy';
import { LocalSimulationPaymentStrategy } from './strategies/local-simulation.strategy';
import { ConfigService } from '@nestjs/config';
import { PaymentStrategyInterface } from './strategies/payment-strategy.interface';

/**
 * This Factory is responsible for choosing the payment gateway strategy using Environment variables.
 * Why didn't we use dynamic injection for the strategy directly?
 *    To allow the application to fallback to the env default, or let the user/caller
 *    explicitly choose which gateway they need via runtime input.
 */
@Injectable()
export class PaymentStrategyFactory {
  constructor(
    private readonly stripeStrategy: StripeStrategy,
    private readonly localSimulationStrategy: LocalSimulationPaymentStrategy,
    private readonly configService: ConfigService,
  ) {}

  /**
   * Returns the requested payment strategy.
   * If no provider is passed, it falls back to the PAYMENT_PROVIDER environment variable.
   */
  getStrategy(provider?: string): PaymentStrategyInterface {
    // 1. Prioritize user/runtime input, fallback to env variable, fallback to empty string
    const targetProvider =
      provider || this.configService.get<string>('PAYMENT_PROVIDER') || '';

    // 2. Normalize casing to prevent matching bugs
    switch (targetProvider.toLowerCase()) {
      case 'stripe':
        return this.stripeStrategy;
      case 'local-simulation':
        return this.localSimulationStrategy;
      default:
        throw new InternalServerErrorException(
          `Unsupported payment provider configured or requested: "${targetProvider}"`,
        );
    }
  }
}
