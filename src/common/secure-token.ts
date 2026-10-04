/**
 * Cryptographically secure token generation (hex-encoded random bytes).
 *
 * Responsibility (SRP): secure random token generation, nothing else.
 * Used by: auth token flows.
 * Depends on: node:crypto (pure function, no injected state).
 */
import * as crypto from 'crypto';
export function generateHex(numBytes = 32): string {
  // 32 bytes -> 64 hex chars (256 bits), matching the existing token format.
  return crypto.randomBytes(numBytes).toString('hex');
}
