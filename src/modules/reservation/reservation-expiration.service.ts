import {
  ConflictException,
  Inject,
  Injectable,
  Logger,
  Optional,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectDataSource } from '@nestjs/typeorm';
import { ClientProxy } from '@nestjs/microservices';
import { DataSource, EntityManager } from 'typeorm';
import { Reservation } from './entities/reservation.entity';
import { ReservationStatus } from './entities/reservation-status.enum';
import { ReservationService } from './reservation.service';

/**
 * This service is responsible for expiration cleanup domain.
 * It handles scanning expired reservations and releasing reserved inventory with poison/ TTL handling.
 */
@Injectable()
export class ReservationExpirationService {
  private readonly logger = new Logger(ReservationExpirationService.name);
  // Fallback in-memory when Redis unavailable (tests / local without Redis)
  private readonly failureCounts = new Map<string, number>();
  private readonly skipSet = new Set<string>();
  // Redis TTL for poison tracking (24h) — survives restarts unlike in-memory Map
  private readonly POISON_TTL_SECONDS = 24 * 60 * 60;

  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    private readonly reservationService: ReservationService,
    private readonly configService: ConfigService,
    @Optional()
    @Inject('NOTIFICATION_SERVICE')
    private readonly client?: ClientProxy,
    @Optional()
    @Inject('REDIS_CLIENT')
    private readonly redis?: any,
  ) {}

  private poisonCountKey(id: string): string {
    return `expiration:poison:count:${id}`;
  }

  private quarantineKey(id: string): string {
    return `expiration:poison:quarantine:${id}`;
  }

  private async isQuarantined(id: string): Promise<boolean> {
    if (this.redis) {
      try {
        const v = await this.redis.get(this.quarantineKey(id));
        return !!v;
      } catch {
        return this.skipSet.has(id);
      }
    }
    return this.skipSet.has(id);
  }

  private async getPoisonCount(id: string): Promise<number> {
    if (this.redis) {
      try {
        const v = await this.redis.get(this.poisonCountKey(id));
        return v ? parseInt(v, 10) : 0;
      } catch {
        return this.failureCounts.get(id) || 0;
      }
    }
    return this.failureCounts.get(id) || 0;
  }

  private async incrementPoisonCount(id: string): Promise<number> {
    if (this.redis) {
      try {
        const next = await this.redis.incr(this.poisonCountKey(id));
        // Ensure TTL on first increment
        await this.redis.expire(
          this.poisonCountKey(id),
          this.POISON_TTL_SECONDS,
        );
        return next;
      } catch {
        // fallback to memory
      }
    }
    const prev = this.failureCounts.get(id) || 0;
    const next = prev + 1;
    this.failureCounts.set(id, next);
    return next;
  }

  private async setQuarantined(id: string): Promise<void> {
    if (this.redis) {
      try {
        await this.redis.set(
          this.quarantineKey(id),
          '1',
          'EX',
          this.POISON_TTL_SECONDS,
        );
        return;
      } catch {
        // fallback
      }
    }
    this.skipSet.add(id);
  }

  private async clearPoison(id: string): Promise<void> {
    if (this.redis) {
      try {
        await this.redis.del(this.poisonCountKey(id));
        await this.redis.del(this.quarantineKey(id));
      } catch {
        // ignore
      }
    }
    this.failureCounts.delete(id);
    this.skipSet.delete(id);
  }

  private get batchSize(): number {
    const v = this.configService.get<string>('EXPIRATION_BATCH_SIZE');
    const n = parseInt(v || '10', 10);
    return isNaN(n) ? 10 : Math.min(Math.max(n, 1), 100);
  }

  private get maxRetries(): number {
    const v = this.configService.get<string>('EXPIRATION_MAX_RETRIES');
    const n = parseInt(v || '3', 10);
    return isNaN(n) ? 3 : Math.min(Math.max(n, 1), 10);
  }

  private get isEnabled(): boolean {
    const v = this.configService.get<string>('EXPIRATION_ENABLED');
    if (v === undefined) return true;
    return v !== 'false' && v !== '0';
  }

  async findExpiredCandidateIds(limit?: number): Promise<string[]> {
    const lim = limit ?? this.batchSize;
    // Use Postgres NOW() server time, deterministic ORDER BY expiresAt ASC, id ASC
    const repo = this.dataSource.getRepository(Reservation);
    const qb = repo
      .createQueryBuilder('r')
      .select('r.id')
      .where('r.status = :status', { status: ReservationStatus.RESERVED })
      .andWhere('r.expiresAt <= NOW()')
      .orderBy('r.expiresAt', 'ASC')
      .addOrderBy('r.id', 'ASC')
      .limit(lim);
    const rows = await qb.getMany();
    return rows.map((r) => r.id);
  }

  async expireOne(
    manager: EntityManager,
    reservationId: string,
  ): Promise<Reservation> {
    // Delegate to ReservationService.expire which already implements FOR UPDATE + sorted inventories
    // but need to handle idempotent skip for already-terminal states
    return this.reservationService.expire(manager, reservationId);
  }

  async processExpiredBatch(limit?: number): Promise<{
    scanned: number;
    expired: number;
    skipped: number;
    failed: number;
    retried: number;
  }> {
    if (!this.isEnabled) {
      this.logger.log('expiration disabled via EXPIRATION_ENABLED=false');
      return { scanned: 0, expired: 0, skipped: 0, failed: 0, retried: 0 };
    }
    const lim = limit ?? this.batchSize;
    const ids = await this.findExpiredCandidateIds(lim);
    if (ids.length === 0) {
      this.logger.debug('expiration tick: scanned=0');
      return { scanned: 0, expired: 0, skipped: 0, failed: 0, retried: 0 };
    }
    this.logger.log(`expiration batch: scanned=${ids.length} limit=${lim}`);
    let expired = 0;
    let skipped = 0;
    let failed = 0;
    let retried = 0;

    for (const id of ids) {
      if (await this.isQuarantined(id)) {
        this.logger.debug(
          `skip poison reservation ${id} (quarantined after ${this.maxRetries} failures)`,
        );
        skipped++;
        continue;
      }
      try {
        // Per-candidate transaction
        let result: Reservation | null = null;
        await this.dataSource.transaction(async (manager) => {
          result = await this.expireOne(manager, id);
        });
        // Success - clear poison state (Redis or memory) and publish RabbitMQ event post-commit
        await this.clearPoison(id);
        expired++;
        const expAt = (result as Reservation | null)?.expiresAt;
        this.logger.debug(
          `expiring reservation ${id} expiresAt=${expAt ? expAt.toISOString() : 'unknown'}`,
        );
        // Publish RabbitMQ event after commit (at-most-once, failures logged not rolled back)
        if (this.client && result) {
          const payload = {
            reservationId: (result as Reservation).id,
            userId: (result as Reservation).userId,
            expiredAt: new Date().toISOString(),
            expiresAt: (result as Reservation).expiresAt?.toISOString(),
            inventoryIds: ((result as Reservation).items || [])
              .map((i: any) => i.inventoryId)
              .sort(),
            items: ((result as Reservation).items || []).map((i: any) => ({
              inventoryId: i.inventoryId,
              quantity: i.quantity,
            })),
            status: 'EXPIRED' as const,
          };
          try {
            // fire-and-forget, subscribe to ensure error callback
            const obs = this.client.emit('reservation.expired', payload);
            if (obs && typeof (obs as any).subscribe === 'function') {
              (obs as any).subscribe({
                error: (e: any) =>
                  this.logger.error(
                    `reservation.expired emit failed for ${id}: ${e?.message}`,
                    e?.stack,
                  ),
              });
            }
            this.logger.debug(`reservation.expired emitted for ${id}`);
          } catch (e: any) {
            this.logger.error(
              `reservation.expired emit threw for ${id}: ${e?.message}`,
              e?.stack,
            );
          }
        }
      } catch (e: any) {
        // Handle idempotent skip for already-terminal (Conflict due to invalid transition) as skipped, not failed
        const msg: string = e?.message || '';
        if (
          e instanceof ConflictException &&
          msg.includes('Invalid reservation transition')
        ) {
          // Could be EXPIRED->EXPIRED, COMPLETED->EXPIRED etc - treat as idempotent skip
          this.logger.debug(`skip reservation ${id} status=${msg}`);
          skipped++;
          // Do not count as retry, clear poison state
          await this.clearPoison(id);
          continue;
        }
        // Poison / missing inventory / CHECK violation -> retry logic (Redis-backed)
        const next = await this.incrementPoisonCount(id);
        retried++;
        if (next >= this.maxRetries) {
          this.logger.warn(
            `poison reservation ${id} attempt ${next}/${this.maxRetries} failed: ${msg} — quarantining (skip until manual fix)`,
          );
          await this.setQuarantined(id);
          failed++;
        } else {
          this.logger.warn(
            `reservation ${id} expire attempt ${next}/${this.maxRetries} failed: ${msg}`,
          );
          failed++;
        }
        // Batch continues
      }
    }

    this.logger.log(
      `expiration tick: scanned=${ids.length} expired=${expired} skipped=${skipped} failed=${failed} retried=${retried}`,
    );
    return { scanned: ids.length, expired, skipped, failed, retried };
  }

  async processAll(
    batchSize?: number,
  ): Promise<{ scanned: number; expired: number }> {
    let totalScanned = 0;
    let totalExpired = 0;
    // Loop until no more candidates or safety guard
    for (let iter = 0; iter < 100; iter++) {
      const r = await this.processExpiredBatch(batchSize);
      totalScanned += r.scanned;
      totalExpired += r.expired;
      if (r.scanned === 0) break;
      if (r.expired === 0 && r.failed > 0 && r.scanned > 0) {
        // Only poisons left, break to avoid infinite loop
        const remaining = await this.findExpiredCandidateIds(batchSize);
        const nonQuarantined: string[] = [];
        for (const id of remaining) {
          if (!(await this.isQuarantined(id))) nonQuarantined.push(id);
        }
        if (nonQuarantined.length === 0) break;
      }
    }
    return { scanned: totalScanned, expired: totalExpired };
  }

  /**
   * Clears poison state for testing — removes Redis keys if present, else clears memory.
   */
  async clearPoisonState() {
    if (this.redis) {
      try {
        // Delete in-memory and attempt to clear Redis poison keys used in this process
        // For tests, mock redis has no keys scan, so just clear memory and call flush if available
        if (typeof this.redis.flushdb === 'function') {
          // do not flush real DB — only for mock
        }
        // Clear known ids from memory; redis keys expire via TTL anyway
      } catch {
        throw new Error();
      }
    }
    this.failureCounts.clear();
    this.skipSet.clear();
    // Best-effort: if redis mock supports keys, delete matching
    if (this.redis && typeof this.redis.keys === 'function') {
      try {
        const keys: string[] = await this.redis.keys('expiration:poison:*');
        if (keys.length) await this.redis.del(...keys);
      } catch {
        throw new Error();
      }
    }
  }
}
