import { Injectable, Logger } from '@nestjs/common';
import { DataSource, EntityManager, IsNull, Repository } from 'typeorm';
import { RefreshToken } from '../entities/refresh-token.entity';

/**
 * This store is responsible for refresh-token persistence mechanics.
 * It owns all RefreshToken queries: locked lookup, rotation writes, cap-5
 * eviction, single revoke, theft bulk-nuke, and expiry purge.
 *
 * Responsibility (SRP): refresh-token persistence, nothing else.
 * Used by: AuthService (login/refresh/logout/logout-all orchestration).
 * Depends on: DataSource (repositories + one documented own-tx nuke).
 *
 * Transaction rule: every method takes effect in the CALLER's unit of work.
 * Manager-scoped methods participate in the ambient transaction and never
 * commit. revokeAllActive is the single exception: it runs on the DataSource
 * (own implicit transaction) because the theft 401 rolls the outer tx back,
 * which would otherwise undo the nuke and leave the stolen session alive (B5).
 */
@Injectable()
export class RefreshTokenStore {
  private readonly logger = new Logger(RefreshTokenStore.name);

  constructor(private readonly dataSource: DataSource) {}

  private repo(manager?: EntityManager): Repository<RefreshToken> {
    return manager
      ? manager.getRepository(RefreshToken)
      : this.dataSource.getRepository(RefreshToken);
  }

  /**
   * Finds a refresh-token row by hash, locking it for the enclosing unit.
   * Locking without a transaction is meaningless, so the manager is required.
   *
   * @param manager - Tx-scoped manager of the enclosing transaction.
   * @param tokenHash - sha256 hex of the presented raw token.
   * @returns The locked row or null.
   */
  async findByHashForUpdate(
    manager: EntityManager,
    tokenHash: string,
  ): Promise<RefreshToken | null> {
    this.logger.debug(
      `refresh store findForUpdate start hashPrefix=${tokenHash.slice(0, 6)}`,
    );
    return await manager
      .getRepository(RefreshToken)
      .createQueryBuilder('rt')
      .setLock('pessimistic_write')
      .where('rt.tokenHash = :tokenHash', { tokenHash })
      .getOne();
  }

  /**
   * Marks one token revoked.
   *
   * @param manager - Tx-scoped manager, or omit for autocommit use.
   * @param id - RefreshToken row id.
   * @returns Void.
   */
  async revokeById(
    manager: EntityManager | undefined,
    id: string,
  ): Promise<void> {
    this.logger.debug(`refresh store revoke start id=${id}`);
    await this.repo(manager).update(id, { revokedAt: new Date() });
  }

  /**
   * Counts active (non-revoked) tokens for a user.
   *
   * @param userId - Owner user id.
   * @param manager - Optional tx-scoped manager (participates when given).
   * @returns Active token count.
   */
  async countActive(userId: string, manager?: EntityManager): Promise<number> {
    return await this.repo(manager).count({
      where: { userId, revokedAt: IsNull() },
    });
  }

  /**
   * Finds the oldest active token (cap-5 LRU eviction pick).
   *
   * @param userId - Owner user id.
   * @param manager - Optional tx-scoped manager (participates when given).
   * @returns Oldest active row or null.
   */
  async findOldestActive(
    userId: string,
    manager?: EntityManager,
  ): Promise<RefreshToken | null> {
    const rows = await this.repo(manager).find({
      where: { userId, revokedAt: IsNull() },
      order: { createdAt: 'ASC' },
      take: 1,
    });
    return rows[0] ?? null;
  }

  /**
   * Persists a new refresh-token row (does not enforce the cap — caller does).
   *
   * @param row - {userId, tokenHash, expiresAt} for the new row.
   * @param manager - Optional tx-scoped manager (participates when given).
   * @returns The saved row.
   */
  async create(
    row: { userId: string; tokenHash: string; expiresAt: Date },
    manager?: EntityManager,
  ): Promise<RefreshToken> {
    this.logger.debug(
      `refresh store create start userId=${row.userId} hashPrefix=${row.tokenHash.slice(0, 6)}`,
    );
    const repo = this.repo(manager);
    return await repo.save(
      repo.create({
        userId: row.userId,
        user: { id: row.userId } as never,
        tokenHash: row.tokenHash,
        expiresAt: row.expiresAt,
        revokedAt: null,
      }),
    );
  }

  /**
   * Revokes one token by hash where still active (idempotent logout: 0 rows ok).
   *
   * @param tokenHash - sha256 hex of the presented raw token.
   * @returns Void.
   */
  async revokeByHashWhereActive(tokenHash: string): Promise<void> {
    this.logger.debug(
      `refresh store revokeByHash start hashPrefix=${tokenHash.slice(0, 6)}`,
    );
    await this.dataSource
      .createQueryBuilder()
      .update(RefreshToken)
      .set({ revokedAt: new Date() })
      .where('tokenHash = :tokenHash AND "revokedAt" IS NULL', { tokenHash })
      .execute();
  }

  /**
   * Revokes ALL active tokens for a user inside the caller's transaction
   * (commits with it — used where no rollback follows, e.g. logout-all).
   * For the theft path (rollback follows), use revokeAllActive instead.
   *
   * @param manager - Tx-scoped manager of the enclosing transaction.
   * @param userId - Owner user id.
   * @returns Void.
   */
  async revokeAllInTx(manager: EntityManager, userId: string): Promise<void> {
    this.logger.debug(`refresh store bulk revoke in-tx start userId=${userId}`);
    await manager
      .createQueryBuilder()
      .update(RefreshToken)
      .set({ revokedAt: new Date() })
      .where('userId = :userId AND "revokedAt" IS NULL', { userId })
      .execute();
  }

  /**
   * Revokes ALL active tokens for a user in its own implicit transaction.
   * Theft path: the outer unit rolls back (401), so this MUST NOT run on the
   * ambient manager — otherwise the nuke is undone (B5).
   *
   * @param userId - Owner user id.
   * @returns Void.
   */
  async revokeAllActive(userId: string): Promise<void> {
    this.logger.warn(`refresh store theft nuke start userId=${userId}`);
    await this.dataSource
      .createQueryBuilder()
      .update(RefreshToken)
      .set({ revokedAt: new Date() })
      .where('userId = :userId AND "revokedAt" IS NULL', { userId })
      .execute();
  }

  /**
   * Deletes rows expired or revoked over 7 days ago (retention purge).
   * DB-relative (`NOW() - INTERVAL`), same predicate as before — no cutoff
   * param, so clock skew between app and DB cannot shift retention.
   *
   * @returns Deleted row count.
   */
  async purgeExpired(): Promise<number> {
    this.logger.debug('refresh store purge start retention=7d');
    const result = await this.dataSource
      .createQueryBuilder()
      .delete()
      .from(RefreshToken)
      .where(
        `("revokedAt" IS NOT NULL AND "revokedAt" < NOW() - INTERVAL '7 days') OR ("revokedAt" IS NULL AND "expiresAt" < NOW() - INTERVAL '7 days')`,
      )
      .execute();
    return result.affected || 0;
  }
}
