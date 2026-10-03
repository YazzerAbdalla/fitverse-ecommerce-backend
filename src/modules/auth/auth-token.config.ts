import { ConfigService } from '@nestjs/config';
import { Logger } from '@nestjs/common';
import { parseDurationMs } from '../../common/parse-duration';

/**
 * This module is responsible for typed auth token configuration.
 * It reads every auth TTL / cooldown / cookie / OAuth setting ONCE at startup,
 * clamps values, warns once per fallback, and freezes the result.
 *
 * Responsibility (SRP): auth configuration resolution, nothing else.
 * Used by: AuthModule provider (AUTH_TOKEN_CONFIG), AuthService/stores (T029 rewire).
 * Depends on: ConfigService (reads), Logger (warn-once on fallback).
 */

/** DI token for the resolved config (string token keeps cross-module use simple). */
export const AUTH_TOKEN_CONFIG = 'AUTH_TOKEN_CONFIG';

/** Typed auth token configuration (all values resolved at startup). */
export interface AuthTokenConfig {
  /** Refresh-token lifetime, ms (default 7d). */
  refreshTokenTtlMs: number;
  /** Name of the HttpOnly refresh cookie (default 'refresh_token'). */
  refreshCookieName: string;
  /** Whether the refresh cookie requires HTTPS (default false unless 'true'). */
  refreshCookieSecure: boolean;
  /** Password-reset token lifetime, ms (default 15m). */
  resetTokenTtlMs: number;
  /** Email-verification token lifetime, ms (default 24h). */
  emailVerificationTtlMs: number;
  /** OTP lifetime, ms (default 5m). */
  otpTtlMs: number;
  /** Max OTP verify attempts (default 3). */
  otpMaxAttempts: number;
  /** OTP resend cooldown, ms (default 60s). */
  otpResendCooldownMs: number;
  /** Google OAuth client id (empty when unconfigured). */
  googleClientId: string;
  /** Google OAuth client secret (empty when unconfigured; never logged). */
  googleClientSecret: string;
  /** Google OAuth callback URL (empty when unconfigured). */
  googleCallbackUrl: string;
  /** Public frontend base URL for email links (empty when unconfigured). */
  frontendUrl: string;
}

const warnedKeys = new Set<string>();

function warnOnce(logger: Logger, key: string, fallback: string | number) {
  // Warn-once: repeated resolutions must not spam logs on every request.
  if (warnedKeys.has(key)) return;
  warnedKeys.add(key);
  logger.warn(`AuthTokenConfig: ${key} unset, using default ${fallback}`);
}

/** Clears warn-once state (tests only). */
export function resetAuthTokenConfigWarnings(): void {
  warnedKeys.clear();
}

function readString(
  config: ConfigService,
  logger: Logger,
  key: string,
  fallback: string,
): string {
  const raw = config.get<string>(key);
  if (raw === undefined || raw === null || raw === '') {
    warnOnce(logger, key, fallback === '' ? '(empty)' : fallback);
    return fallback;
  }
  return raw;
}

function readInt(
  config: ConfigService,
  logger: Logger,
  key: string,
  fallback: number,
  min: number,
): number {
  const raw = config.get<string>(key);
  const parsed = raw === undefined ? NaN : parseInt(raw, 10);
  // Clamp to min: non-numeric or below-min values fall back (same fail-safe
  // posture as the legacy per-access reads, now centralized).
  if (isNaN(parsed) || parsed < min) {
    warnOnce(logger, key, fallback);
    return fallback;
  }
  return parsed;
}

/**
 * Resolves the full auth token configuration once at startup.
 *
 * @param config - Nest ConfigService (backed by .env).
 * @param logger - Logger for warn-once fallback notices.
 * @returns Frozen AuthTokenConfig with values identical to the legacy
 *   per-access `??` defaults (no new hard-fail: missing keys warn, never throw).
 */
export function resolveAuthTokenConfig(
  config: ConfigService,
  logger: Logger,
): AuthTokenConfig {
  // Duration defaults mirror the legacy inline fallbacks byte-for-byte:
  // REFRESH 7d, RESET 15m, VERIFY 24h, OTP 5m, cooldown 60s, attempts 3.
  const DAY_MS = 24 * 3600_000;
  const HOUR_MS = 3600_000;
  const MIN_MS = 60_000;
  return Object.freeze({
    refreshTokenTtlMs: readDurationMs(
      config,
      logger,
      'REFRESH_TOKEN_TTL',
      7 * DAY_MS,
    ),
    refreshCookieName: readString(
      config,
      logger,
      'REFRESH_TOKEN_COOKIE_NAME',
      'refresh_token',
    ),
    refreshCookieSecure:
      readString(config, logger, 'REFRESH_TOKEN_COOKIE_SECURE', 'false') ===
      'true',
    resetTokenTtlMs: readDurationMs(
      config,
      logger,
      'RESET_TOKEN_TTL',
      15 * MIN_MS,
    ),
    emailVerificationTtlMs: readDurationMs(
      config,
      logger,
      'EMAIL_VERIFICATION_TTL',
      24 * HOUR_MS,
    ),
    otpTtlMs: readDurationMs(config, logger, 'OTP_TTL', 5 * MIN_MS),
    otpMaxAttempts: readInt(config, logger, 'OTP_MAX_ATTEMPTS', 3, 1),
    otpResendCooldownMs: readDurationMs(
      config,
      logger,
      'OTP_RESEND_COOLDOWN',
      60_000,
    ),
    googleClientId: readString(config, logger, 'GOOGLE_CLIENT_ID', ''),
    googleClientSecret: readString(config, logger, 'GOOGLE_CLIENT_SECRET', ''),
    googleCallbackUrl: readString(config, logger, 'GOOGLE_CALLBACK_URL', ''),
    frontendUrl: readString(config, logger, 'FRONTEND_URL', ''),
  });
}

function readDurationMs(
  config: ConfigService,
  logger: Logger,
  key: string,
  fallbackMs: number,
): number {
  const raw = config.get<string>(key);
  if (raw === undefined || raw === null || raw === '') {
    warnOnce(logger, key, fallbackMs);
    return fallbackMs;
  }
  // Reuse the single duration parser (suffix s/m/h/d or plain ms).
  return parseDurationMs(raw, fallbackMs, (bad) =>
    warnOnce(logger, `${key} (${bad})`, fallbackMs),
  );
}
