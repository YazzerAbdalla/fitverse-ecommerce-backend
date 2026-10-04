/**
 * WhatsApp OTP delivery abstraction (provider-swappable, mockable in tests).
 * V1 wires NoopWhatsAppProvider; Twilio/Meta are placeholders until
 * WhatsApp Business setup (OTP endpoints return 501 meanwhile).
 *
 * Responsibility (SRP): OTP delivery contract + provider stubs, nothing else.
 * Used by: AuthModule ('WHATSAPP_PROVIDER' token), AuthService OTP methods.
 * Depends on: nothing.
 */
export interface WhatsAppProvider {
  sendOtp(
    phoneNumber: string,
    otp: string,
    expiresInMinutes: number,
  ): Promise<{ messageId: string }>;
}

export class NoopWhatsAppProvider implements WhatsAppProvider {
  public lastSent: {
    phoneNumber: string;
    otp: string;
    expiresInMinutes: number;
  } | null = null;
  async sendOtp(phoneNumber: string, otp: string, expiresInMinutes: number) {
    this.lastSent = { phoneNumber, otp, expiresInMinutes };
    // For E2E, tests can read this
    return { messageId: `noop-${Date.now()}` };
  }
}

export class TwilioWhatsAppProvider implements WhatsAppProvider {
  async sendOtp(phoneNumber: string, _otp: string, _expiresInMinutes: number) {
    // Placeholder: integrate Twilio SDK using TWILIO_ACCOUNT_SID etc.
    return { messageId: `twilio-${phoneNumber}` };
  }
}

export class MetaCloudWhatsAppProvider implements WhatsAppProvider {
  async sendOtp(phoneNumber: string, _otp: string, _expiresInMinutes: number) {
    // Placeholder: integrate Meta Cloud API using META_WHATSAPP_TOKEN
    return { messageId: `meta-${phoneNumber}` };
  }
}
