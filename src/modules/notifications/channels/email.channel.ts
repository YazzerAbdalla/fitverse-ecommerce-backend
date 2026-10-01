import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import { EMAIL_PROVIDER } from '../email.provider';
import type { EmailProvider } from '../email.provider';
import type { NotificationChannel } from './notification-channel.interface';

/**
 * This service is responsible for the EMAIL notification channel.
 * It handles wrapping the EMAIL_PROVIDER EmailProvider so dispatch stays transport-agnostic.
 * Retry is owned by the caller (worker) — this channel rethrows provider errors.
 */
@Injectable()
export class EmailChannel implements NotificationChannel {
  /** Channel key for factory resolution. */
  readonly key = 'email' as const;

  private readonly logger = new Logger(EmailChannel.name);

  constructor(
    @Optional()
    @Inject(EMAIL_PROVIDER)
    private readonly emailProvider?: EmailProvider,
  ) {}

  /**
   * Sends an email via the injected EmailProvider.
   * @param params - Delivery params (to, subject, template, vars).
   * @returns Provider messageId with delivered=true on accept.
   * @throws Rethrows provider errors so the caller can retry/backoff per channel.
   */
  async send(params: {
    to?: string;
    userId: string;
    subject: string;
    template: string;
    vars: Record<string, unknown>;
  }): Promise<{ messageId?: string; delivered: boolean }> {
    // No fallback address invention beyond caller-supplied `to` — missing `to` is a caller bug.
    if (!this.emailProvider) {
      this.logger.warn(
        `email provider missing userId=${params.userId} template=${params.template}`,
      );
      throw new Error('EmailProvider not configured');
    }
    // Provider throw propagates — caller owns attempts/backoff/FAILED accounting.
    const result = await this.emailProvider.send(
      params.to ?? '',
      params.subject,
      params.template,
      params.vars,
    );
    return { messageId: result?.messageId, delivered: true };
  }
}
