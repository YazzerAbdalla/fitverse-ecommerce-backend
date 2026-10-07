/**
 * This enum represents the lifecycle states of a simulated payment.
 * It mirrors the linked order outcome without contacting a real provider.
 */
export enum PaymentStatus {
  PENDING = 'PENDING',
  SUCCEEDED = 'SUCCEEDED',
  FAILED = 'FAILED',
  CANCELLED = 'CANCELLED',
}
