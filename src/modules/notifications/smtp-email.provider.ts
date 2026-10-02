import { Injectable, Logger, Optional } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as nodemailer from 'nodemailer';
import type { Transporter } from 'nodemailer';
import type { EmailProvider } from './email.provider';

/**
 * This service is responsible for SMTP email delivery (prod).
 * It handles nodemailer transport from ConfigService so wiring can switch noop|smtp via EMAIL_PROVIDER.
 */
@Injectable()
export class SmtpEmailProvider implements EmailProvider {
  private readonly logger = new Logger(SmtpEmailProvider.name);
  private transporter: Transporter | null = null;
  private readonly from: string;

  constructor(@Optional() private readonly configService?: ConfigService) {
    // From address is config-driven, never hardcoded per-brand.
    this.from =
      this.configService?.get<string>('EMAIL_FROM') ??
      'Mini E-Commerce <noreply@example.com>';
  }

  /**
   * Sends an email via SMTP.
   * @param to - Recipient email address.
   * @param subject - Email subject line.
   * @param template - Template identifier (verify|reset|sales|new_product).
   * @param vars - Template variables (link, firstName, etc.).
   * @returns Provider messageId from SMTP accept.
   * @throws Rethrows transport errors so the caller can retry/backoff.
   */
  async send(
    to: string,
    subject: string,
    template: string,
    vars: Record<string, unknown>,
  ): Promise<{ messageId?: string }> {
    const transporter = this.getTransporter();
    // Text fallback keeps verify/reset links readable without MJML rendering (V1 simple vars).
    const text = this.renderText(template, vars);
    const info = await transporter.sendMail({
      from: this.from,
      to,
      subject,
      text,
    });
    this.logger.log(
      `smtp email sent to=${to} template=${template} messageId=${info?.messageId ?? 'unknown'}`,
    );
    return { messageId: info?.messageId };
  }

  /**
   * Builds (lazily) the nodemailer transporter from ConfigService.
   * @returns Cached transporter instance.
   */
  private getTransporter(): Transporter {
    if (this.transporter) return this.transporter;
    // All hosts/secrets via ConfigService — never hardcode per AGENTS.md.
    const host = this.configService?.get<string>('SMTP_HOST') ?? 'localhost';
    const port = Number(this.configService?.get<string>('SMTP_PORT') ?? 587);
    const user = this.configService?.get<string>('SMTP_USER') ?? '';
    const pass = this.configService?.get<string>('SMTP_PASS') ?? '';
    const secure =
      (this.configService?.get<string>('SMTP_SECURE') ?? 'false') === 'true';
    // Auth omitted when user empty (local Mailhog-style relay) to keep dev usable.
    this.transporter = nodemailer.createTransport({
      host,
      port,
      secure,
      auth: user ? { user, pass } : undefined,
    });
    return this.transporter;
  }

  /**
   * Renders a plain-text body from template vars.
   * @param template - Template identifier.
   * @param vars - Template variables.
   * @returns Plain-text body.
   */
  private renderText(template: string, vars: Record<string, unknown>): string {
    // Keep V1 simple: link-first for trust-critical templates, body passthrough for bulk.
    const link = vars?.['link'] as string | undefined;
    const body = vars?.['body'] as string | undefined;
    if (link) return `${template}: ${link}`;
    if (body) return body;
    return `${template} notification`;
  }
}
