import { Injectable } from '@nestjs/common';

/**
 * Channel keys resolved by the dispatcher (lowercase wire form).
 */
export type DispatchChannel = 'system' | 'email';

/**
 * Event identity for channel resolution.
 */
export interface DispatchEvent {
  /** OutboxEvent id (dedup + delivery linkage). */
  eventId: string;
  /** Event type (verify|reset|sales|new_product|order.*|reservation.expired). */
  type: string;
  /** Recipient user id. */
  userId: string;
}

/**
 * Current user preference snapshot for channel resolution.
 */
export interface DispatchPrefs {
  /** GDPR-like opt-in for sales/news (default false). */
  marketingOptIn?: boolean;
  /** Email-channel gate (default true). */
  emailOptIn?: boolean;
  /** Verified address flag. */
  emailVerified?: boolean;
}

/**
 * This service is responsible for runtime notification channel resolution.
 * It handles preference-gated dispatch so opt-in checkboxes take effect without caller changes.
 */
@Injectable()
export class NotificationDispatcher {
  /**
   * Resolves channels for an event from current user prefs.
   * @param event - Event identity (type, userId, eventId).
   * @param prefs - Preference snapshot (marketingOptIn, emailOptIn, emailVerified).
   * @returns Ordered channel keys to deliver (system first, email second when allowed).
   */
  dispatch(event: DispatchEvent, prefs: DispatchPrefs): DispatchChannel[] {
    // Case-tolerant matching: producers emit 'order.created' and 'ORDER.CREATED' alike.
    const type = (event?.type ?? '').toLowerCase();

    // Trust-critical override: verify/reset always reach both channels regardless of prefs.
    if (type === 'verify' || type === 'reset') {
      return ['system', 'email'];
    }

    // Marketing gate: system always, email only when fully opted-in AND verified.
    if (type === 'sales' || type === 'new_product') {
      // Opted-out (any flag false) → system-only so no marketing email leaks.
      if (
        prefs.marketingOptIn === true &&
        prefs.emailOptIn === true &&
        prefs.emailVerified === true
      ) {
        return ['system', 'email'];
      }
      return ['system'];
    }

    // Operational events: system always, email when the email channel is not opted out.
    if (
      type.startsWith('order.') ||
      type === 'reservation.expired' ||
      type === 'reservation_expired'
    ) {
      // emailOptIn defaults true (migration default) — only explicit false suppresses email.
      if (prefs.emailOptIn !== false) {
        return ['system', 'email'];
      }
      return ['system'];
    }

    // Unknown type fallback: system-only (PG history truth preserved, no email spam).
    return ['system'];
  }
}
