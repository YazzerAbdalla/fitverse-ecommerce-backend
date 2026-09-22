/**
 * This enum represents the order status lifecycle.
 * @deprecated Use OrderStatus from './order-status.enum' - kept for backward compatibility.
 */
export enum OrderStatus {
  PENDING = 'PENDING',
  COMPLETED = 'COMPLETED',
  CANCELLED = 'CANCELLED',
  FAILED = 'FAILED',
}
