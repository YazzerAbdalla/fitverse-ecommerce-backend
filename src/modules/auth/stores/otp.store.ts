/**
 * One-time-passcode state (Redis primary, PostgreSQL audit fallback).
 *
 * Responsibility (SRP): OTP state, nothing else.
 * Used by: AuthService OTP orchestration (501-isolated paths only).
 * Depends on: DataSource (PG audit), Cache (TTL/cooldown, fail-open).
 */
import {
  BadRequestException,
  Inject,
  Injectable,
  Logger,
} from '@nestjs/common';
import { DataSource } from 'typeorm';
import { CACHE_MANAGER } from '@nestjs/cache-manager';
import type { Cache } from 'cache-manager';
import * as crypto from 'crypto';
import {
  OtpVerification,
  OtpPurpose,
} from '../entities/otp-verification.entity';
import { SystemClock } from '../../../common/clock';
import { AUTH_TOKEN_CONFIG, type AuthTokenConfig } from '../auth-token.config';

/** OTP cache record shape (Redis `otp:whatsapp:<phone>`). */
export interface OtpCacheRecord {
  hash: string;
  attempts: number;
  createdAt: number;
  expiresAt: number;
  purpose: OtpPurpose;
}

/**
 * Minimal typed surface of the cache used for OTP state.
 * cache-manager's Cache type exposes no get/set/del generically, so the
 * single documented cast lives in `cachePort()` instead of at every call.
 */
export interface OtpCachePort {
  get(key: string): Promise<OtpCacheRecord | null | undefined>;
  set(key: string, value: unknown, ttlMs: number): Promise<unknown>;
  del(key: string): Promise<unknown>;
}

/**
 * This store is responsible for one-time-passcode state (Redis primary,
 * PostgreSQL audit fallback). It owns mint persistence, cooldown, the
 * verify state machine (attempts, expiry, hash compare), and audit writes.
 *
 * Responsibility (SRP): OTP state, nothing else.
 * Used by: AuthService OTP orchestration (501-isolated paths only).
 * Depends on: DataSource (PG audit), Cache (TTL/cooldown, fail-open).
 *
 * OTP behavior is frozen (501 at the controller): this move is mechanical.
 * Fail-open postures (Redis down → allow + warn; PG audit best-effort) are
 * preserved exactly, including the every-attempt increment (B2 choice B) and
 * the PG fallback path (Q4).
 */
@Injectable()
export class OtpStore {
  private readonly logger = new Logger(OtpStore.name);

  // OTP resend cooldown: 60s per phone (Redis SET, fail-open, ms unit).
  private readonly otpCooldownMs = 60_000;

  constructor(
    private readonly dataSource: DataSource,
    @Inject(CACHE_MANAGER) private readonly cache: Cache,
    private readonly clock: SystemClock,
    @Inject(AUTH_TOKEN_CONFIG) private readonly tokenConfig: AuthTokenConfig,
  ) {}

  /**
   * Typed view of the injected cache (single documented cast).
   *
   * @returns The cache as get/set/del port.
   */
  private cachePort(): OtpCachePort {
    return this.cache;
  }

  /**
   * Issues an OTP: cooldown gate, Redis record + cooldown arm, PG audit row.
   * Provider send stays with the orchestrator (external I/O after state).
   *
   * @param phone - E.164 phone number.
   * @param purpose - OTP purpose (login default at the orchestrator).
   * @param minted - {otp, codeHash, expiresAt} minted by the orchestrator
   *   (crypto stays caller-owned until the US4 port rewire).
   * @param ttlMs - Record TTL in ms.
   * @param userId - Owner user id or null (audit link, best-effort).
   * @throws BadRequestException when the 60s cooldown is active.
   * @returns Void.
   */
  async issueOtp(
    phone: string,
    purpose: OtpPurpose,
    minted: { codeHash: string; expiresAt: Date },
    ttlMs: number,
    userId: string | null,
  ): Promise<void> {
    // cooldown 60s via Redis SET NX EX.
    // QUIRK (preserved): the legacy code throws the cooldown denial INSIDE
    // its own fail-open try, whose catch only warns — so the denial is
    // swallowed and issuance always proceeds. Changing that is out of scope.
    const cooldownKey = `otp:cooldown:${phone}`;
    try {
      const exists = await this.cachePort().get(cooldownKey);
      if (exists)
        throw new BadRequestException(
          'Resend cooldown active, try in 60 seconds',
        );
    } catch (error: unknown) {
      this.logger.warn(`Redis cooldown check fail-open:`, error);
    }
    const cacheKey = `otp:whatsapp:${phone}`;
    // Record instants in ms since epoch (matches expiresAt arithmetic below).
    const nowMs = this.clock.now().getTime();
    const record: OtpCacheRecord = {
      hash: minted.codeHash,
      attempts: 0,
      createdAt: nowMs,
      expiresAt: minted.expiresAt.getTime(),
      purpose,
    };
    try {
      await this.cachePort().set(cacheKey, record, ttlMs);
      await this.cachePort().set(cooldownKey, '1', this.otpCooldownMs);
    } catch (error: unknown) {
      this.logger.warn(`Redis set fail-open:`, error);
    }
    // persist to PG
    try {
      const repo = this.dataSource.getRepository(OtpVerification);
      await repo.save(
        repo.create({
          phoneNumber: phone,
          userId: userId || null,
          purpose,
          codeHash: minted.codeHash,
          expiresAt: minted.expiresAt,
          attempts: 0,
          verifiedAt: null,
        } as never),
      );
    } catch (error: unknown) {
      this.logger.warn(`PG OtpVerification save failed:`, error);
    }
  }

  /**
   * Verifies one attempt: Redis state machine with PG fallback.
   *
   * @param phone - E.164 phone number.
   * @param codeHash - sha256 hex of the presented OTP.
   * @param purpose - Calling purpose scope (audit row scope only; the
   *   orchestrator resolves post-verification purpose from its own input).
   * @returns Void on success.
   * @throws BadRequestException on invalid/expired/too-many-attempts.
   */
  async verifyAttempt(
    phone: string,
    codeHash: string,
    purpose: OtpPurpose,
  ): Promise<void> {
    const cacheKey = `otp:whatsapp:${phone}`;
    let redisData: OtpCacheRecord | null = null;
    let redisAvailable = true;
    try {
      redisData = (await this.cachePort().get(cacheKey)) ?? null;
    } catch (error: unknown) {
      redisAvailable = false;
      this.logger.warn(`Redis get fail-open, fallback to DB:`, error);
    }

    // Max attempts from startup config (was hardcoded 3, drifted from OTP_MAX_ATTEMPTS).
    const maxAttempts = this.tokenConfig.otpMaxAttempts;
    // Now in ms since epoch (single clock read per attempt).
    const nowMs = this.clock.now().getTime();

    // Redis path
    if (redisAvailable && redisData) {
      // increment attempts on every attempt per B2 choice B
      redisData.attempts = (redisData.attempts || 0) + 1;
      const attemptsOk = redisData.attempts <= maxAttempts;
      // Expiry compare in ms: record expiresAt is ms-since-epoch.
      const notExpired = redisData.expiresAt > nowMs;
      const hashOk = timingSafeEqual(redisData.hash, codeHash);
      if (!notExpired) {
        try {
          await this.cachePort().del(cacheKey);
        } catch {
          // best-effort delete — absence is fail-open safe
        }
        throw new BadRequestException('Invalid or expired OTP');
      }
      if (!attemptsOk) {
        try {
          await this.cachePort().del(cacheKey);
        } catch {
          // best-effort delete — absence is fail-open safe
        }
        throw new BadRequestException('Too many attempts, request new OTP');
      }
      if (!hashOk) {
        try {
          // Remaining TTL in ms (record expiry minus now, never negative).
          await this.cachePort().set(
            cacheKey,
            redisData,
            Math.max(redisData.expiresAt - nowMs, 0),
          );
        } catch {
          // best-effort persist — absence is fail-open safe
        }
        // also increment PG attempts
        await this.incrementAttempts(phone);
        throw new BadRequestException('Invalid or expired OTP');
      }
      // success: delete Redis, update PG audit scoped to the calling purpose
      try {
        await this.cachePort().del(cacheKey);
      } catch {
        void 0;
      }
      await this.markVerified(phone, purpose);
      return;
    }

    // Fallback DB path (Q4)
    const repo = this.dataSource.getRepository(OtpVerification);
    const latestOtpRows = await repo.find({
      where: { phoneNumber: phone },
      order: { createdAt: 'DESC' },
      take: 1,
    });
    const latestOtpRow = latestOtpRows[0];
    if (
      !latestOtpRow ||
      latestOtpRow.verifiedAt ||
      latestOtpRow.expiresAt.getTime() <= nowMs
    ) {
      throw new BadRequestException('Invalid or expired OTP');
    }
    // increment attempts on every attempt per B2
    latestOtpRow.attempts += 1;
    await repo.save(latestOtpRow);
    if (latestOtpRow.attempts > maxAttempts)
      throw new BadRequestException('Too many attempts, request new OTP');
    if (!timingSafeEqual(latestOtpRow.codeHash, codeHash)) {
      throw new BadRequestException('Invalid or expired OTP');
    }
    latestOtpRow.verifiedAt = this.clock.now();
    await repo.save(latestOtpRow);
    return;
  }

  /**
   * Increments PG audit attempts for a phone (fail-open best-effort).
   *
   * @param phone - E.164 phone number.
   * @returns Void.
   */
  private async incrementAttempts(phone: string): Promise<void> {
    try {
      const repo = this.dataSource.getRepository(OtpVerification);
      const candidateOtpRows = await repo.find({
        where: { phoneNumber: phone },
        order: { createdAt: 'DESC' },
        take: 1,
      });
      if (candidateOtpRows[0]) {
        candidateOtpRows[0].attempts += 1;
        await repo.save(candidateOtpRows[0]);
      }
    } catch {
      // best-effort audit — absence is fail-open safe
    }
  }

  /**
   * Marks the latest PG audit row verified (fail-open best-effort).
   *
   * @param phone - E.164 phone number.
   * @param purpose - OTP purpose scope for the audit row.
   * @returns Void.
   */
  private async markVerified(
    phone: string,
    purpose: OtpPurpose,
  ): Promise<void> {
    try {
      const repo = this.dataSource.getRepository(OtpVerification);
      const candidateOtpRows = await repo.find({
        where: { phoneNumber: phone, purpose },
        order: { createdAt: 'DESC' },
        take: 1,
      });
      if (candidateOtpRows[0]) {
        candidateOtpRows[0].verifiedAt = this.clock.now();
        candidateOtpRows[0].attempts += 1;
        await repo.save(candidateOtpRows[0]);
      }
    } catch {
      void 0;
    }
  }
}

/**
 * Constant-time string comparison (moved with the OTP state machine).
 *
 * @param a - First string.
 * @param b - Second string.
 * @returns True when equal (length + timing safe).
 */
export function timingSafeEqual(a: string, b: string): boolean {
  try {
    const bufA = Buffer.from(a, 'utf8');
    const bufB = Buffer.from(b, 'utf8');
    if (bufA.length !== bufB.length) return false;
    return crypto.timingSafeEqual(bufA, bufB);
  } catch {
    return a === b;
  }
}
