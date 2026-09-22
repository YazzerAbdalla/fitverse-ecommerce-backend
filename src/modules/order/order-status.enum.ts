/**
 * This enum represents the order status lifecycle.
 * Used by Order entity to track progression from creation to completion.
 */
export enum OrderStatus {
  PENDING = 'PENDING',
  COMPLETED = 'COMPLETED',
  CANCELLED = 'CANCELLED',
  FAILED = 'FAILED',
}
