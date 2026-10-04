/**
 * One-way token hashing (sha256 hex). Never stores or returns raw secrets.
 *
 * Responsibility (SRP): token hashing, nothing else.
 * Used by: auth token flows (refresh, reset, verification, OTP).
 * Depends on: node:crypto (pure function, no injected state).
 */
import * as crypto from 'crypto';
export function sha256Hex(raw: string): string {
  return crypto.createHash('sha256').update(raw).digest('hex');
}
