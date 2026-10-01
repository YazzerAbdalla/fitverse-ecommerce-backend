import { Injectable, Logger } from '@nestjs/common';

/**
 * Email template identifiers for V1 (union documents intent; `string` keeps
 * backward-compat with existing order/reservation template callers).
 */
export type EmailTemplate =
  'verify' | 'reset' | 'sales' | 'new_product' | (string & {});

/**
 * This interface is responsible for email sending abstraction.
 * It handles provider-agnostic send so dedup guards can be tested without real SMTP.
 */
export interface EmailProvider {
  /**
   * Sends an email via the underlying provider.
   * @param to - Recipient email address.
   * @param subject - Email subject line.
   * @param template - Template identifier (verify|reset|sales|new_product).
   * @param vars - Template variables (firstName, orderId, etc.).
   * @returns Provider response with optional messageId.
   */
  send(
    to: string,
    subject: string,
    template: EmailTemplate,
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

  /** Test hooks: last send captured for unit/e2e assertions (minimal, documented). */
  public lastTo?: string;
  public lastSubject?: string;
  public lastTemplate?: string;
  public lastVars?: Record<string, unknown>;
  public lastLink?: string;
  public sendCount = 0;

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
    // Capture for tests (spec 014 T010/T022: lastVars/lastLink capture)
    this.lastTo = to;
    this.lastSubject = subject;
    this.lastTemplate = template;
    this.lastVars = vars;
    // Extract link var when present (verify/reset templates use vars.link)
    const maybeLink = vars?.link;
    if (typeof maybeLink === 'string') this.lastLink = maybeLink;
    this.sendCount += 1;
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
