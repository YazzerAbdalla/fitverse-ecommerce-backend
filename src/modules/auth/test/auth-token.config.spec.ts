/**
 * Unit tests for AuthTokenConfig resolution (T010): identical defaults to the
 * legacy inline `??` fallbacks, warn-once behavior, no hard-fail on missing keys.
 */
import { ConfigService } from '@nestjs/config';
import { Logger } from '@nestjs/common';
import {
  AUTH_TOKEN_CONFIG,
  resolveAuthTokenConfig,
  resetAuthTokenConfigWarnings,
} from '../auth-token.config';

function configWith(values: Record<string, string | undefined>) {
  return {
    get: jest.fn((key: string) => values[key]),
  } as unknown as ConfigService;
}

function silentLogger() {
  return {
    log: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
  } as unknown as Logger;
}

describe('AuthTokenConfig (T010)', () => {
  beforeEach(() => resetAuthTokenConfigWarnings());

  it('exposes a stable DI token string', () => {
    expect(AUTH_TOKEN_CONFIG).toBe('AUTH_TOKEN_CONFIG');
  });

  it('resolves legacy defaults with warn-once when env is empty', () => {
    const logger = silentLogger();
    const cfg = resolveAuthTokenConfig(configWith({}), logger);
    // Defaults mirror legacy inline fallbacks byte-for-byte.
    expect(cfg.refreshTokenTtlMs).toBe(7 * 24 * 3600_000);
    expect(cfg.refreshCookieName).toBe('refresh_token');
    expect(cfg.refreshCookieSecure).toBe(false);
    expect(cfg.resetTokenTtlMs).toBe(15 * 60_000);
    expect(cfg.emailVerificationTtlMs).toBe(24 * 3600_000);
    expect(cfg.otpTtlMs).toBe(5 * 60_000);
    expect(cfg.otpMaxAttempts).toBe(3);
    expect(cfg.otpResendCooldownMs).toBe(60_000);
    expect(cfg.googleClientId).toBe('');
    expect(cfg.frontendUrl).toBe('');
    expect(Object.isFrozen(cfg)).toBe(true);
    const warnCount = (logger.warn as jest.Mock).mock.calls.length;
    expect(warnCount).toBeGreaterThan(0);
    // Second resolution warns nothing more (warn-once).
    resolveAuthTokenConfig(configWith({}), logger);
    expect((logger.warn as jest.Mock).mock.calls.length).toBe(warnCount);
  });

  it('honors explicit values and clamps below-minimum integers', () => {
    const cfg = resolveAuthTokenConfig(
      configWith({
        REFRESH_TOKEN_TTL: '1d',
        REFRESH_TOKEN_COOKIE_SECURE: 'true',
        OTP_MAX_ATTEMPTS: '0',
        OTP_TTL: '10m',
      }),
      silentLogger(),
    );
    expect(cfg.refreshTokenTtlMs).toBe(24 * 3600_000);
    expect(cfg.refreshCookieSecure).toBe(true);
    expect(cfg.otpMaxAttempts).toBe(3); // clamped: min 1
    expect(cfg.otpTtlMs).toBe(10 * 60_000);
  });
});
