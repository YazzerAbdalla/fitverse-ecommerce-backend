import { Injectable, Logger } from '@nestjs/common';

/**
 * This interface is responsible for email sending abstraction.
 * It handles provider-agnostic send so dedup guards can be tested without real SMTP.
 */
export interface EmailProvider {
  /**
   * Sends an email via the underlying provider.
   * @param to - Recipient email address.
   * @param subject - Email subject line.
   * @param template - Template identifier (verify|reset|sales|order etc.).
   * @param vars - Template variables (firstName, orderId, etc.).
   * @returns Provider response with optional messageId.
   */
  send(
    to: string,
    subject: string,
    template: string,
    vars: Record<string, unknown>,
  ): Promise<{ messageId?: string }>;
}

/**
 * This provider is responsible for noop email delivery (Phase 11/12 dev/test).
 * It handles logging only so Phase 12 dedup can be verified without SMTP.
 * Future SMTP/SES providers will replace this via EMAIL_PROVIDER token.
 */
@Injectable()
export class NoopEmailProvider implements EmailProvider {
  private readonly logger = new Logger(NoopEmailProvider.name);

  /**
   * Logs email instead of sending.
   * @param to - Recipient email.
   * @param subject - Subject line.
   * @param template - Template name.
   * @param vars - Variables for template rendering.
   * @returns Mock messageId.
   */
  async send(
    to: string,
    subject: string,
    template: string,
    vars: Record<string, unknown>,
  ): Promise<{ messageId?: string }> {
    // No Inventory/Order/Reservation mutation — consumer-side only
    this.logger.log(
      `noop email send to=${to} template=${template} subject=${subject} vars=${JSON.stringify(vars).substring(0, 500)}`,
    );
    return { messageId: `noop-${Date.now()}` };
  }
}

/**
 * Injection token for EmailProvider abstraction.
 */
export const EMAIL_PROVIDER = 'EMAIL_PROVIDER';
