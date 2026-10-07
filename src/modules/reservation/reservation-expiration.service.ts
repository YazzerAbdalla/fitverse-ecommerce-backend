import {
  ConflictException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
  Optional,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource, EntityManager } from 'typeorm';
import { CACHE_MANAGER } from '@nestjs/cache-manager';
import type { Cache } from 'cache-manager';
import { Reservation } from './entities/reservation.entity';
import { ReservationStatus } from './entities/reservation-status.enum';
import { ReservationService } from './reservation.service';
import { OutboxService } from '../outbox/outbox.service';
import { Order } from '../order/entities/order.entity';
import { OrderStatus } from '../order/order-status.enum';
import { randomUUID } from 'crypto';

/**
 * This service is responsible for expiration cleanup domain.
 * It handles scanning expired reservations and releasing reserved inventory with poison/ TTL handling.
 * It creates transactional outbox events inside the same DataSource.transaction as business state.
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
    @Inject(OutboxService)
    private readonly outboxService?: OutboxService,
    @Optional()
    @Inject('REDIS_CLIENT')
    private readonly redis?: any,
    @Optional()
    @Inject(CACHE_MANAGER)
    private readonly cache?: Cache,
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

  /**
   * Increments idempotency duplicate skipped counter for expiration (fail-open).
   * Uses CACHE_MANAGER INCR with 24h expiry; on failure logs warn and continues.
   */
  private async incrementIdempotencyCounter(): Promise<void> {
    const key = 'idempotency:duplicate:skipped:expiration';
    try {
      if (!this.cache) return;
      const anyCache: any = this.cache as any;
      const store: any = anyCache.store ?? anyCache.stores?.[0];
      const client =
        store?.client ?? store?.store?.client ?? anyCache.client ?? null;
      if (client && typeof client.incr === 'function') {
        await client.incr(key);
        if (typeof client.expire === 'function') {
          await client.expire(key, 86400);
        } else if (typeof client.pexpire === 'function') {
          await client.pexpire(key, 86400000);
        }
        return;
      }
      const current = (await this.cache.get<number>(key)) ?? 0;
      await this.cache.set(key, current + 1, 86400000);
    } catch (e: any) {
      this.logger.warn(
        `Redis fail-open for idempotency counter ${key}: ${e?.message}`,
      );
    }
  }

  /**
   * Determines if error is transient and should count toward poison quarantine.
   * Only 23514, ETIMEDOUT, ECONNREFUSED, 500 are transient per D2; 200/404/409 are not.
   * @param e - Error to classify.
   * @returns True if transient (should poison).
   */
  private isTransientFailure(e: any): boolean {
    const msg: string = e?.message ?? '';
    const code: string = e?.code ?? '';
    // DB CHECK violation 23514 is considered transient poison (should quarantine)
    if (code === '23514' || msg.includes('23514') || msg.includes('CHK_'))
      return true;
    if (msg.includes('ETIMEDOUT') || code === 'ETIMEDOUT') return true;
    if (msg.includes('ECONNREFUSED') || code === 'ECONNREFUSED') return true;
    // Generic 500
    if (e?.status === 500 || msg.includes('500')) return true;
    // NotFound (404) and Conflict (409) and idempotent 200 are not transient
    if (e instanceof NotFoundException) return false;
    if (
      e instanceof ConflictException &&
      msg.includes('Invalid reservation transition')
    )
      return false;
    // Other 4xx are not transient
    if (e?.status >= 400 && e?.status < 500) return false;
    // Default: treat as transient for safety (DB failures)
    return true;
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

  /**
   * Checks whether an order has a pending simulated payment.
   * A pending payment defers automatic expiry so a shopper mid-pay is never
   * expired out (018-payment-simulation Q2/D5, best-effort rechecked inside
   * the expiry transaction).
   *
   * @param manager - EntityManager of the enclosing transaction.
   * @param orderId - Order id to check.
   * @returns True when a PENDING payment row exists; false otherwise (including when the payment table is absent pre-migration).
   */
  private async hasPendingPaymentForOrder(
    manager: EntityManager,
    orderId: string,
  ): Promise<boolean> {
    // Raw table check avoids importing the payment entity here: the payment
    // module depends on the order/reservation boundary, so a direct entity
    // import would reverse the dependency direction (TI-1).
    try {
      const matchingRows: Array<{ id: string }> = await manager.query(
        'SELECT 1 AS "id" FROM "Payment" WHERE "orderId" = $1 AND "status" = $2 LIMIT 1',
        [orderId, 'PENDING'],
      );
      return matchingRows.length > 0;
    } catch {
      // Payment table absent (migration not applied) — preserve legacy behavior and expire.
      return false;
    }
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
        // Per-candidate transaction — outbox events inserted atomically with state change
        let result: Reservation | null = null;
        let reservationBeforeStatus: ReservationStatus | null = null;
        let isIdempotentDuplicate = false;
        let isPaymentBlocked = false;
        await this.dataSource.transaction(async (manager) => {
          // Capture reservation status BEFORE expire to detect idempotent duplicate (RESERVED vs already terminal)
          // Idempotent guard is inside ReservationService before any Inventory FOR UPDATE; 200 duplicate must not poison (D2)
          let preOrderId: string | null = null;
          try {
            const pre = await manager.getRepository(Reservation).findOne({
              where: { id },
            });
            reservationBeforeStatus =
              (pre?.status as ReservationStatus) ?? null;
            preOrderId = pre?.orderId ?? null;
            // Also capture order status before expire to detect newly cancelled order (FR-006)
            if (pre?.orderId) {
              const ordBefore = await manager
                .getRepository(Order)
                .findOne({ where: { id: pre.orderId } });
              // stash for outbox check after expire
              (manager as any).__orderBeforeStatus =
                (ordBefore?.status as OrderStatus) ?? null;
            } else {
              (manager as any).__orderBeforeStatus = null;
            }
          } catch {
            // ignore pre-fetch errors — best effort
            (manager as any).__orderBeforeStatus = null;
          }

          // Phase 19 (018): a pending payment defers expiry until the payment
          // resolves (confirm/decline/cancel). Rechecked inside the transaction
          // so a payment created after the scan still blocks this candidate.
          // The candidate-level check is best-effort: check errors fail open
          // toward legacy behavior (expire as before).
          if (preOrderId !== null) {
            const blockedOrderId: string = preOrderId;
            if (await this.hasPendingPaymentForOrder(manager, blockedOrderId)) {
              isPaymentBlocked = true;
              return;
            }
          }

          result = await this.expireOne(manager, id);

          // Detect idempotent duplicate: before was already terminal (not RESERVED) but expire returned 200 with 0 delta
          if (
            reservationBeforeStatus &&
            reservationBeforeStatus !== ReservationStatus.RESERVED
          ) {
            // Same-transition idempotent (EXPIRED->EXPIRED, CANCELLED->CANCELLED, COMPLETED->COMPLETED) — do not create outbox
            isIdempotentDuplicate = true;
            return;
          }

          const orderBeforeStatus: OrderStatus | null = (manager as any)
            .__orderBeforeStatus;

          // OutboxEvent INSERT inside same transaction — no client.emit
          if (this.outboxService) {
            try {
              const corrId = randomUUID();
              await this.outboxService.createEvent(manager, {
                eventType: 'reservation.expired',
                aggregateType: 'Reservation',
                aggregateId: result.id,
                correlationId: corrId,
                data: {
                  reservationId: result.id,
                  userId: result.userId,
                  orderId: result.orderId ?? null,
                  items: (result.items || []).map((i: any) => ({
                    inventoryId: i.inventoryId,
                    quantity: i.quantity,
                  })),
                  expiresAt: result.expiresAt?.toISOString() ?? null,
                  expiredAt: new Date().toISOString(),
                },
              });

              if (result.orderId) {
                const orderAfter = await manager
                  .getRepository(Order)
                  .findOne({ where: { id: result.orderId } });
                // Only create order.cancelled if we just transitioned PENDING→CANCELLED
                if (
                  orderAfter &&
                  orderBeforeStatus === OrderStatus.PENDING &&
                  orderAfter.status === OrderStatus.CANCELLED
                ) {
                  const corrId2 = randomUUID();
                  try {
                    await this.outboxService.createEvent(manager, {
                      eventType: 'order.cancelled',
                      aggregateType: 'Order',
                      aggregateId: result.orderId,
                      correlationId: corrId2,
                      data: {
                        orderId: result.orderId,
                        userId: result.userId,
                        previousStatus: 'PENDING',
                        newStatus: 'CANCELLED',
                        reason: 'expired',
                        reservationId: result.id,
                      },
                    });
                  } catch (e2: any) {
                    this.logger.warn(
                      `outbox order.cancelled insert failed for ${result.orderId}: ${e2?.message}`,
                    );
                  }
                }
              }
            } catch (e: any) {
              this.logger.warn(
                `outbox reservation.expired insert failed for ${result.id}: ${e?.message}`,
              );
            }
          }
        });
        // Handle idempotent duplicate 200 after commit: do not increment poison, INCR counter, count as skipped
        if (isPaymentBlocked) {
          // Phase 19 (018): pending payment defers expiry — not a failure, not poison.
          skipped++;
          this.logger.log(
            `reservation skip id=${id}: pending payment blocks expiry until confirm/decline/cancel`,
          );
          continue;
        }
        if (isIdempotentDuplicate) {
          await this.clearPoison(id);
          skipped++;
          this.logger.log(
            `reservation idempotent skip id=${id} status=${reservationBeforeStatus} -> ${ReservationStatus.EXPIRED}`,
          );
          await this.incrementIdempotencyCounter();
          continue;
        }
        // Success - clear poison state (Redis or memory)
        await this.clearPoison(id);
        expired++;
        const expAt = (result as Reservation | null)?.expiresAt;
        this.logger.debug(
          `expiring reservation ${id} expiresAt=${expAt ? expAt.toISOString() : 'unknown'}`,
        );
      } catch (e: any) {
        // Handle idempotent skip for already-terminal (Conflict due to invalid transition) as skipped, not failed (cross-transition 409)
        // Do NOT treat 200 idempotent as poison — poison excludes 200/404 (D2)
        const msg: string = e?.message || '';
        if (e instanceof NotFoundException) {
          // 404 not-found (stale candidate) is not poison per D2
          this.logger.debug(`skip reservation ${id} not found: ${msg}`);
          skipped++;
          await this.clearPoison(id);
          continue;
        }
        if (
          e instanceof ConflictException &&
          msg.includes('Invalid reservation transition')
        ) {
          // Could be COMPLETED->EXPIRED etc cross-transition → 409 but still not poison (business terminal)
          this.logger.debug(`skip reservation ${id} status=${msg}`);
          skipped++;
          // Do not count as retry, clear poison state
          await this.clearPoison(id);
          continue;
        }
        // Only transient DB failures count toward poison (23514, ETIMEDOUT, ECONNREFUSED, 500) per D2
        if (!this.isTransientFailure(e)) {
          this.logger.debug(`skip reservation ${id} non-transient: ${msg}`);
          skipped++;
          await this.clearPoison(id);
          continue;
        }
        // Poison / CHECK violation -> retry logic (Redis-backed)
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
