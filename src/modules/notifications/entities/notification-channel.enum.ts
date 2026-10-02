/**
 * NotificationChannel for user-leg delivery (data-model §3b/§3c).
 * SYSTEM is WebSocket realtime plus history fetch; EMAIL is EmailProvider send.
 */
export enum NotificationChannel {
  SYSTEM = 'SYSTEM',
  EMAIL = 'EMAIL',
}
