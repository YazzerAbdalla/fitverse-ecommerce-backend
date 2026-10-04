/**
 * Unit matrix for CC-A pure ports (T009): byte-identical outputs vs the
 * pre-refactor inline implementations (auth.service.ts parseTtlMs /
 * parseTtlWithDefault + controller cookie math, inline sha256/randomBytes).
 */
import { sha256Hex } from './token-hasher';
import { generateHex } from './secure-token';
import { FakeClock, SystemClock } from './clock';
import { parseDurationMs } from './parse-duration';
import * as crypto from 'crypto';

describe('CC-A ports parity (T009)', () => {
  it('sha256Hex matches inline crypto sha256 hex', () => {
    for (const raw of ['', 'a', 'f'.repeat(64), 'hello world']) {
      expect(sha256Hex(raw)).toBe(
        crypto.createHash('sha256').update(raw).digest('hex'),
      );
    }
    expect(sha256Hex('x')).toHaveLength(64);
  });

  it('generateHex(32) matches randomBytes(32).hex format', () => {
    const t = generateHex(32);
    expect(t).toMatch(/^[0-9a-f]{64}$/);
    expect(generateHex(32)).not.toBe(generateHex(32));
  });

  it('FakeClock is deterministic; SystemClock advances', () => {
    const fake = new FakeClock(new Date(1000));
    expect(fake.now().getTime()).toBe(1000);
    fake.advance(500);
    expect(fake.now().getTime()).toBe(1500);
    expect(new SystemClock().now().getTime()).toBeGreaterThan(0);
  });

  it('parseDurationMs matches the three legacy parsers', () => {
    // Legacy outputs (auth.service.ts parseTtlMs / parseTtlWithDefault with
    // fallbacks 15m / 24h, controller cookie math with fallback 7d).
    const cases: Array<[string, number, number, number]> = [
      // [input, parseTtlMs-out, parseTtlWithDefault-24h-out, cookieMath-7d-out]
      ['15m', 900_000, 900_000, 900_000],
      ['7d', 604_800_000, 604_800_000, 604_800_000],
      ['24h', 86_400_000, 86_400_000, 86_400_000],
      ['5m', 300_000, 300_000, 300_000],
      ['60s', 60_000, 60_000, 60_000],
      ['300', 300, 300, 300],
      ['604800000', 604_800_000, 604_800_000, 604_800_000],
    ];
    for (const [input, a, b, c] of cases) {
      expect(parseDurationMs(input, 15 * 60_000)).toBe(a);
      expect(parseDurationMs(input, 24 * 3600_000)).toBe(b);
      expect(parseDurationMs(input, 7 * 24 * 3600_000)).toBe(c);
    }
    // Legacy quirk parity: non-numeric prefix + valid suffix ('bogus' ends
    // with 's') yields NaN in BOTH old and new code (returned before the
    // numeric check). Documented, not fixed — changing it is out of scope.
    expect(parseDurationMs('bogus', 900_000)).toBeNaN();
    // Truly-invalid input → caller fallback + onInvalid hook (legacy warn).
    const seen: string[] = [];
    expect(parseDurationMs('bogus!', 900_000, (r) => void seen.push(r))).toBe(
      900_000,
    );
    expect(seen).toEqual(['bogus!']);
    expect(parseDurationMs('', 123)).toBe(123);
  });
});
