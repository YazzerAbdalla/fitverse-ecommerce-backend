import * as crypto from 'crypto';

/**
 * This utility is responsible for cryptographically secure token generation.
 * It produces hex-encoded random bytes for opaque tokens (refresh, reset, verify).
 *
 * Responsibility (SRP): secure random token generation, nothing else.
 * Used by: auth token stores/services.
 * Depends on: node:crypto (pure function, no injected state).
 */
export function generateHex(numBytes = 32): string {
  // 32 bytes -> 64 hex chars (256 bits), matching the existing token format.
  return crypto.randomBytes(numBytes).toString('hex');
}
