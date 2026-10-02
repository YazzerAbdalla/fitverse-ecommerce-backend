/**
 * NotificationStatus for user-leg rows and per-channel delivery legs (data-model §3b/§3c).
 * PENDING → SENT → DELIVERED, FAILED terminal. READ is user behavior tracked
 * via Notification.isRead/readAt, never via this status.
 */
export enum NotificationStatus {
  PENDING = 'PENDING',
  SENT = 'SENT',
  DELIVERED = 'DELIVERED',
  FAILED = 'FAILED',
}
