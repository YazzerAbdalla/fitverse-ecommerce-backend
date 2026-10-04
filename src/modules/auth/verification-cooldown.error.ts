/**
 * Domain signal for an active verification-resend cooldown (no HTTP inside).
 * The controller translates it to the 429 + Retry-After wire shape.
 *
 * Responsibility (SRP): cooldown denial signal, nothing else.
 * Used by: AuthService (resendVerification), AuthController (429 mapping).
 * Depends on: nothing.
 */
export class VerificationCooldownError extends Error {
  constructor(readonly retryAfterSec = 60) {
    super('Verification resend cooldown active');
    this.name = 'VerificationCooldownError';
  }
}
