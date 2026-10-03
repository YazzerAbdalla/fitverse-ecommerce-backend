import { Inject, Injectable, Logger } from '@nestjs/common';
import { DataSource, EntityManager } from 'typeorm';
import { CACHE_MANAGER } from '@nestjs/cache-manager';
import type { Cache } from 'cache-manager';
import { EmailVerificationToken } from '../entities/email-verification-token.entity';

/**
 * Domain signal for an active resend cooldown (no HTTP inside).
 * The controller translates it to the 429 + Retry-After wire shape (T030).
 */
export class VerificationCooldownError extends Error {
  constructor(readonly retryAfterSec = 60) {
    super('Verification resend cooldown active');
    this.name = 'VerificationCooldownError';
  }
}

/**
 * This store is responsible for email-verification-token persistence mechanics
 * plus the resend cooldown state. It owns prior-invalidation, insert (with the
 * hash-collision retry), locked lookup, single-use consume, and the 60s
 * per-email cooldown with fail-open semantics.
 *
 * Responsibility (SRP): verification-token persistence + cooldown, nothing else.
 * Used by: AuthService (requestEmailVerification/verifyEmail/resendVerification).
 * Depends on: DataSource (repositories), Cache (cooldown keys, fail-open).
 *
 * Transaction rule: manager-scoped methods participate in the caller's unit
 * and never commit. Cooldown reads/writes stay OUTSIDE transactions (checked
 * before any tx starts, armed after issue commits).
 */
@Injectable()
export class VerificationTokenStore {
  private readonly logger = new Logger(VerificationTokenStore.name);

  constructor(
    private readonly dataSource: DataSource,
    @Inject(CACHE_MANAGER) private readonly cache: Cache,
  ) {}

  /**
   * Issues a token: invalidates priors, inserts the new row (collision retry
   * once on unique violation when enabled, else propagates).
   *
   * @param manager - Tx-scoped manager of the enclosing transaction.
   * @param userId - Owner user id.
   * @param expiresAt - Expiry instant.
   * @param mint - Mints a fresh {raw, hash} pair (crypto stays caller-owned
   *   until the US4 port rewire; the store never logs raw values).
   * @param isUniqueViolation - Caller-owned unique-violation predicate
   *   (auth-domain error mapping stays with the orchestrator).
   * @param collisionRetry - Whether a hash collision retries once with a
   *   fresh mint (request path: true, matching legacy; resend path: false,
   *   matching legacy which propagated).
   * @returns The winning raw token (first or collision-retry).
   */
  async issue(
    manager: EntityManager,
    userId: string,
    expiresAt: Date,
    mint: () => { raw: string; hash: string },
    isUniqueViolation: (e: unknown) => boolean,
    collisionRetry = true,
  ): Promise<string> {
    const first = mint();
    this.logger.debug(
      `verify store issue start userId=${userId} hashPrefix=${first.hash.slice(0, 6)}`,
    );
    // Invalidate prior active tokens so only one link is live at a time.
    await manager
      .createQueryBuilder()
      .update(EmailVerificationToken)
      .set({ usedAt: new Date() })
      .where('userId = :userId AND "usedAt" IS NULL', { userId })
      .execute();
    const repo = manager.getRepository(EmailVerificationToken);
    try {
      await repo.save(
        repo.create({
          userId,
          tokenHash: first.hash,
          expiresAt,
          usedAt: null,
        }),
      );
      return first.raw;
    } catch (e: unknown) {
      // Negligible hash-collision retry once (edge: UQ 23505), else propagate.
      if (!collisionRetry || !isUniqueViolation(e)) throw e;
      this.logger.warn(
        `EmailVerificationToken hash collision userId=${userId} hashPrefix=${first.hash.slice(0, 6)} retry once`,
      );
      const retry = mint();
      await repo.save(
        repo.create({
          userId,
          tokenHash: retry.hash,
          expiresAt,
          usedAt: null,
        }),
      );
      return retry.raw;
    }
  }

  /**
   * Locked lookup scoped to (tokenHash, userId) — concurrent same-raw
   * serializes here.
   *
   * @param manager - Tx-scoped manager of the enclosing transaction.
   * @param tokenHash - sha256 hex of the presented raw token.
   * @param userId - Owner user id.
   * @returns The locked row or null.
   */
  async findForUpdate(
    manager: EntityManager,
    tokenHash: string,
    userId: string,
  ): Promise<EmailVerificationToken | null> {
    this.logger.debug(
      `verify store findForUpdate start hashPrefix=${tokenHash.slice(0, 6)}`,
    );
    return await manager
      .getRepository(EmailVerificationToken)
      .createQueryBuilder('t')
      .setLock('pessimistic_write')
      .where('t.tokenHash = :tokenHash AND t.userId = :userId', {
        tokenHash,
        userId,
      })
      .getOne();
  }

  /**
   * Marks a token consumed (single-use).
   *
   * @param manager - Tx-scoped manager of the enclosing transaction.
   * @param token - Locked row to consume.
   * @returns Void.
   */
  async consume(
    manager: EntityManager,
    token: EmailVerificationToken,
  ): Promise<void> {
    token.usedAt = new Date();
    await manager.getRepository(EmailVerificationToken).save(token);
  }

  /**
   * Checks the 60s per-email resend cooldown (before any transaction).
   *
   * @param normalizedEmail - Lowercased email (cooldown key scope).
   * @returns True when the cooldown is active (caller denies), false otherwise.
   *   Fail-open: cache errors behave as "no cooldown", with a warn log.
   */
  async isCooldownActive(normalizedEmail: string): Promise<boolean> {
    const key = `resend:cooldown:${normalizedEmail}`;
    try {
      const existing = await (
        this.cache as unknown as {
          get(k: string): Promise<unknown>;
        }
      ).get(key);
      return !!existing;
    } catch (e: unknown) {
      this.logger.warn(
        `Resend cooldown check fail-open for ${normalizedEmail}: ${(e as Error)?.message ?? e}`,
      );
      return false;
    }
  }

  /**
   * Arms the 60s per-email cooldown after a successful issue (fail-open).
   *
   * @param normalizedEmail - Lowercased email (cooldown key scope).
   * @returns Void.
   */
  async markCooldown(normalizedEmail: string): Promise<void> {
    const key = `resend:cooldown:${normalizedEmail}`;
    try {
      await (
        this.cache as unknown as {
          set(k: string, v: string, ttlMs: number): Promise<unknown>;
        }
      ).set(key, '1', 60_000);
    } catch (e: unknown) {
      this.logger.warn(
        `Resend cooldown set fail-open for ${normalizedEmail}: ${(e as Error)?.message ?? e}`,
      );
    }
  }

  /**
   * Deletes used/long-expired rows older than 7 days (retention purge).
   *
   * @returns Deleted row count.
   */
  async purgeExpired(): Promise<number> {
    this.logger.debug('verify store purge start retention=7d');
    const result = await this.dataSource
      .createQueryBuilder()
      .delete()
      .from(EmailVerificationToken)
      .where(
        `("usedAt" IS NOT NULL AND "usedAt" < NOW() - INTERVAL '7 days') OR ("expiresAt" < NOW() - INTERVAL '7 days')`,
      )
      .execute();
    return result.affected || 0;
  }
}
