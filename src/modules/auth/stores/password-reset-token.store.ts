import { Injectable, Logger } from '@nestjs/common';
import { DataSource, EntityManager } from 'typeorm';
import { PasswordResetToken } from '../entities/password-reset-token.entity';

/**
 * This store is responsible for password-reset-token persistence mechanics.
 * It owns prior-invalidation, locked lookup, and single-use consume.
 *
 * Responsibility (SRP): reset-token persistence, nothing else.
 * Used by: AuthService (requestPasswordReset/validateResetToken/resetPassword).
 * Depends on: DataSource (repositories).
 *
 * Transaction rule: manager-scoped methods participate in the caller's unit
 * and never commit. validate stays a plain read (S-2 advisory); only consume
 * runs under FOR UPDATE inside the authority transaction.
 */
@Injectable()
export class PasswordResetTokenStore {
  private readonly logger = new Logger(PasswordResetTokenStore.name);

  constructor(private readonly dataSource: DataSource) {}

  /**
   * Issues a token: invalidates priors, then inserts the new row.
   *
   * @param manager - Tx-scoped manager of the enclosing transaction.
   * @param userId - Owner user id.
   * @param tokenHash - sha256 hex of the raw token.
   * @param expiresAt - Expiry instant.
   * @returns Void.
   */
  async issue(
    manager: EntityManager,
    userId: string,
    tokenHash: string,
    expiresAt: Date,
  ): Promise<void> {
    this.logger.debug(
      `reset store issue start userId=${userId} hashPrefix=${tokenHash.slice(0, 6)}`,
    );
    await manager
      .createQueryBuilder()
      .update(PasswordResetToken)
      .set({ usedAt: new Date() })
      .where('userId = :userId AND "usedAt" IS NULL AND "expiresAt" > NOW()', {
        userId,
      })
      .execute();
    const repo = manager.getRepository(PasswordResetToken);
    await repo.save(
      repo.create({ userId, tokenHash, expiresAt, usedAt: null }),
    );
  }

  /**
   * Advisory read (no lock): used by the UX pre-check only.
   *
   * @param tokenHash - sha256 hex of the presented raw token.
   * @param userId - Owner user id.
   * @returns The row or null.
   */
  async findAdvisory(
    tokenHash: string,
    userId: string,
  ): Promise<PasswordResetToken | null> {
    return await this.dataSource
      .getRepository(PasswordResetToken)
      .findOne({ where: { tokenHash, userId } });
  }

  /**
   * Locked lookup for the authority path (single-winner serialization).
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
  ): Promise<PasswordResetToken | null> {
    this.logger.debug(
      `reset store findForUpdate start hashPrefix=${tokenHash.slice(0, 6)}`,
    );
    return await manager
      .getRepository(PasswordResetToken)
      .createQueryBuilder('t')
      .setLock('pessimistic_write')
      .where('t.tokenHash = :tokenHash AND t.userId = :userId', {
        tokenHash,
        userId,
      })
      .getOne();
  }

  /**
   * Consumes a token (single-use) and invalidates all other actives.
   *
   * @param manager - Tx-scoped manager of the enclosing transaction.
   * @param token - Locked row to consume.
   * @param userId - Owner user id.
   * @returns Void.
   */
  async consume(
    manager: EntityManager,
    token: PasswordResetToken,
    userId: string,
  ): Promise<void> {
    this.logger.debug(`reset store consume start id=${token.id}`);
    const repo = manager.getRepository(PasswordResetToken);
    await repo.update(token.id, { usedAt: new Date() });
    // invalidate other active tokens
    await manager
      .createQueryBuilder()
      .update(PasswordResetToken)
      .set({ usedAt: new Date() })
      .where('userId = :userId AND id != :id AND "usedAt" IS NULL', {
        userId,
        id: token.id,
      })
      .execute();
  }
}
