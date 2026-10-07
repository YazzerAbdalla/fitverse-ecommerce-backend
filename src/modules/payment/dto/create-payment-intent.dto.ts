import { IsUUID } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';

/**
 * This DTO carries the order reference for starting a simulated payment.
 * The amount is always copied from the order; clients never supply it.
 */
export class CreatePaymentIntentDto {
  /**
   * Order to pay for (must be PENDING and owned by the caller).
   */
  @ApiProperty({
    description: 'Order id to create a payment intent for',
    format: 'uuid',
  })
  @IsUUID()
  orderId!: string;
}
