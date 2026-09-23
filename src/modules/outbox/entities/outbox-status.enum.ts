/**
 * OutboxStatus for transactional outbox delivery.
 * PENDING → PROCESSING → SENT (success) or PENDING (retry) → FAILED (terminal, retained).
 */
export enum OutboxStatus {
  PENDING = 'PENDING',
  PROCESSING = 'PROCESSING',
  SENT = 'SENT',
  FAILED = 'FAILED',
}
