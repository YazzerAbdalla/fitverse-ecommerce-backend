/**
 * OutboxStatus for transactional outbox delivery (extended Phase 18 US6, FR-016).
 * PENDING → PROCESSING → SENT_TO_MQ (broker accepted) → CONSUMED (worker ACKed)
 * → DELIVERED (channels accepted). FAILED is terminal, retained from any leg.
 * SENT is kept as a legacy alias of the SENT_TO_MQ value semantics so rows
 * written before the rename keep working without a data rewrite.
 */
export enum OutboxStatus {
  PENDING = 'PENDING',
  PROCESSING = 'PROCESSING',
  /** Legacy alias: pre-rename SENT value, semantically equal to SENT_TO_MQ (broker accepted). */
  SENT = 'SENT',
  SENT_TO_MQ = 'SENT_TO_MQ',
  CONSUMED = 'CONSUMED',
  DELIVERED = 'DELIVERED',
  FAILED = 'FAILED',
}
