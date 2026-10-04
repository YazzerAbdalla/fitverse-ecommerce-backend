/**
 * This module is responsible for wall-clock access behind an injectable port.
 * Business logic depends on Clock (faked in tests) instead of new Date()/Date.now().
 *
 * Responsibility (SRP): time source abstraction, nothing else.
 * Used by: auth token expiry math (and later phases).
 * Depends on: nothing.
 */
export interface Clock {
  now(): Date;
}

/**
 * System clock implementation (production).
 */
export class SystemClock implements Clock {
  now(): Date {
    return new Date();
  }
}

/**
 * Fake clock for deterministic tests (manual time control).
 */
export class FakeClock implements Clock {
  private current: number;

  constructor(start: Date = new Date(0)) {
    this.current = start.getTime();
  }

  now(): Date {
    return new Date(this.current);
  }

  advance(ms: number): void {
    this.current += ms;
  }
}
