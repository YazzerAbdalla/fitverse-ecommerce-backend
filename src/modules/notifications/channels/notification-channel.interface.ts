/**
 * This interface defines the notification channel strategy contract.
 * It handles per-channel delivery so the dispatcher can resolve channels at runtime without caller changes.
 */
export type NotificationChannelKey = 'system' | 'email';

/**
 * This interface defines the channel send contract.
 * It handles user-leg delivery and reports whether the user actually received it.
 */
export interface NotificationChannel {
  /** Channel key used by the factory and dispatcher. */
  readonly key: NotificationChannelKey;

  /**
   * Sends a notification via this channel.
   * @param params - Delivery params (recipient, subject, template, vars).
   * @returns Provider response with delivery flag (delivered=false means persisted but not yet seen, e.g. offline).
   */
  send(params: {
    to?: string;
    userId: string;
    subject: string;
    template: string;
    vars: Record<string, unknown>;
    eventId?: string;
    type?: string;
    title?: string;
    body?: string;
  }): Promise<{ messageId?: string; delivered: boolean }>;
}
