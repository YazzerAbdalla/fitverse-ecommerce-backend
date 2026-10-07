import { IsIn, IsOptional } from 'class-validator';
import { ApiPropertyOptional } from '@nestjs/swagger';

/**
 * Simulated confirm result sent by the shopper (no real card network).
 */
export type ConfirmResult = 'success' | 'declined';

/**
 * Fixed decline reasons for the demo (Q4).
 */
export type PaymentFailureReason =
  'card_declined' | 'insufficient_funds' | 'expired_card';

/**
 * This DTO carries the simulated confirm decision for a pending payment.
 * Failure reason is restricted to a fixed enum on decline.
 */
export class ConfirmPaymentDto {
  /**
   * Simulated provider outcome.
   */
  @IsIn(['success', 'declined'])
  result!: ConfirmResult;

  /**
   * Decline reason; meaningful only when result is declined.
   */
  @ApiPropertyOptional({
    description: 'Decline reason (required by convention on declined)',
    enum: ['card_declined', 'insufficient_funds', 'expired_card'],
  })
  @IsOptional()
  @IsIn(['card_declined', 'insufficient_funds', 'expired_card'])
  failureReason?: PaymentFailureReason;
}
