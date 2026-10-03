import * as crypto from 'crypto';

/**
 * This utility is responsible for one-way token hashing (sha256 hex).
 * It never stores or returns raw secrets — only their hashes.
 *
 * Responsibility (SRP): token hashing, nothing else.
 * Used by: auth token stores/services (refresh, reset, verification, OTP).
 * Depends on: node:crypto (pure function, no injected state).
 */
export function sha256Hex(raw: string): string {
  return crypto.createHash('sha256').update(raw).digest('hex');
}
