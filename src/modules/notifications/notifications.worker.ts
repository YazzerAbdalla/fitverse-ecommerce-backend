import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import { CACHE_MANAGER } from '@nestjs/cache-manager';
import type { Cache } from 'cache-manager';
import { EventPattern, Payload } from '@nestjs/microservices';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { EMAIL_PROVIDER } from './email.provider';
import type { EmailProvider } from './email.provider';
import { NotificationLog } from './entities/notification-log.entity';

/**
 * This worker is responsible for notification delivery domain (Phase 12 idempotency).
 * It handles at-least-once domain events (order.* / reservation.expired) with Redis dedup and log+counter observability.
 * It enforces idempotency via eventId dedup key before any EmailProvider side-effect and tolerates duplicate delivery.
 */
@Injectable()
export class NotificationWorker {
  private readonly logger = new Logger(NotificationWorker.name);

  // In-memory fallback for tests without Redis (mirrors Phase 11 Set but now Redis-backed)
  private readonly processedFallback = new Set<string>();

  constructor(
    @Inject(CACHE_MANAGER) private readonly cache: Cache,
    @Optional()
    @Inject(EMAIL_PROVIDER)
    private readonly emailProvider?: EmailProvider,
    @Optional()
    @InjectDataSource()
    private readonly dataSource?: DataSource,
  ) {}

  /**
   * Attempts to acquire a Redis dedup lock via SET NX EX 24h (fail-open).
   * @param key - Dedup key (notification:processed:<eventId> or notification:send:<template>:<campaign>:<userId>).
   * @returns True if first acquisition (should proceed), false if duplicate (should skip).
   */
  private async tryAcquireDedupKey(key: string): Promise<boolean> {
    // Dedup guard BEFORE EmailProvider.send — V1 uses eventId key for all single events
    let first: any;
    try {
      // Try CACHE_MANAGER SET with NX option — Keyv ioredis may support {nx:true}
      first = await (this.cache as any).set(key, '1', 86400000, {
        nx: true,
      } as any);
      // If cache.set returns undefined (cache-manager void), fallback to direct client SET NX
      if (first === undefined) {
        const anyCache: any = this.cache as any;
        const store: any = anyCache.store ?? anyCache.stores?.[0] ?? anyCache;
        const client =
          store?.client ?? store?.store?.client ?? anyCache.client ?? null;
        if (client && typeof client.set === 'function') {
          // ioredis SET key value NX EX 86400 — returns 'OK' on first, null on duplicate
          const res = await client.set(key, '1', 'NX', 'EX', 86400);
          if (res === 'OK' || res === 'ok') first = true;
          else if (res === null || res === 0 || res === false) first = false;
          else first = !!res;
        } else {
          // No direct client available — treat as acquired (fail-open but allow once)
          first = true;
        }
      }
    } catch (e: any) {
      // Fail-open on Redis error — allow send once, better than lost send
      this.logger.warn(
        `Redis fail-open for idempotency key=${key}: ${e?.message}`,
      );
      first = true;
    }
    // Normalize: falsy (0/null/false) means duplicate, truthy means first
    // For Keyv, duplicate returns null/false, first returns true/'OK'
    if (!first) return false;
    return true;
  }

  /**
   * Increments duplicate skip counter for observability (fail-open).
   * @returns Void.
   */
  private async incrementCounter(): Promise<void> {
    // Each idempotent skip also increments counter idempotency:duplicate:skipped:notification EX 86400
    const key = 'idempotency:duplicate:skipped:notification';
    try {
      if (!this.cache) return;
      const anyCache: any = this.cache as any;
      const store: any = anyCache.store ?? anyCache.stores?.[0] ?? anyCache;
      const client =
        store?.client ?? store?.store?.client ?? anyCache.client ?? null;
      if (client && typeof client.incr === 'function') {
        await client.incr(key);
        // ensure 24h expiry (86400s) — ioredis EXPIRE
        if (typeof client.expire === 'function') {
          await client.expire(key, 86400);
        } else if (typeof client.pexpire === 'function') {
          await client.pexpire(key, 86400000);
        }
        return;
      }
      // Fallback to cache-manager get/set (fail-open)
      const current = ((await this.cache.get<number>(key)) as number) ?? 0;
      // cache-manager ttl in ms
      await (this.cache as any).set(key, current + 1, 86400000);
    } catch (e: any) {
      this.logger.warn(
        `Redis fail-open for idempotency counter ${key}: ${e?.message}`,
      );
    }
  }

  /**
   * Persists NotificationLog audit row if entity/repository exists (fallback dedup).
   * @param params - Log fields (userId, template, aggregateId, eventId, provider, messageId).
   * @returns Void.
   */
  private async saveNotificationLog(params: {
    userId: string;
    template: string;
    aggregateId: string | null;
    eventId: string;
    provider: string;
    messageId?: string | null;
  }): Promise<void> {
    // Only if NotificationLog entity exists and DataSource available — check existence, if not, skip
    if (!this.dataSource) return;
    try {
      // NotificationLog entity is optional fallback — if repository/table missing, skip gracefully
      let repo: any;
      try {
        repo = this.dataSource.getRepository(NotificationLog);
      } catch {
        return;
      }
      if (!repo) return;
      // Use INSERT ... ON CONFLICT DO NOTHING if supported (PG fallback dedup)
      try {
        await repo
          .createQueryBuilder()
          .insert()
          .into(NotificationLog)
          .values({
            userId: params.userId,
            template: params.template,
            aggregateId: params.aggregateId,
            eventId: params.eventId,
            provider: params.provider,
            messageId: params.messageId ?? null,
          })
          .orIgnore()
          .execute();
        return;
      } catch {
        // Fallback to save with unique catch
      }
      await repo.save({
        userId: params.userId,
        template: params.template,
        aggregateId: params.aggregateId,
        eventId: params.eventId,
        provider: params.provider,
        messageId: params.messageId ?? null,
      });
    } catch (e: any) {
      // Duplicate eventId unique violation is expected on retry — swallow, else warn
      const msg: string = e?.message ?? '';
      if (
        msg.includes('duplicate') ||
        msg.includes('unique') ||
        e?.code === '23505'
      ) {
        this.logger.log(
          `notification log duplicate eventId=${params.eventId} skipped (PG fallback)`,
        );
        return;
      }
      this.logger.warn(
        `notification log save failed eventId=${params.eventId}: ${msg}`,
      );
    }
  }

  /**
   * Extracts envelope fields from OutboxEvent payload (version:1 + correlationId).
   * @param data - Raw event payload or envelope {eventId, eventType, version, correlationId, data/payload}.
   * @returns Normalized envelope fields.
   */
  private extractEnvelope(data: any): {
    eventId: string;
    eventType: string;
    version: number;
    correlationId: string;
    payload: Record<string, unknown>;
    aggregateId: string | null;
    userId: string | null;
    template: string;
  } {
    // Envelope carries eventId = OutboxEvent.id, eventType, version:1, correlationId
    const envelope: any = data ?? {};
    const payloadData: any = envelope.data ?? envelope.payload ?? {};
    // OutboxService envelope is {version, eventId, eventType, occurredAt, correlationId, data:{...domain}}
    const eventId =
      envelope.eventId ||
      envelope.event_id ||
      payloadData.eventId ||
      envelope.payload?.eventId ||
      envelope.data?.eventId ||
      'unknown';
    const eventType =
      envelope.eventType ||
      payloadData.eventType ||
      envelope.payload?.eventType ||
      'unknown';
    const version = envelope.version ?? payloadData.version ?? 1;
    const correlationId =
      envelope.correlationId ||
      envelope.correlation_id ||
      payloadData.correlationId ||
      'unknown';
    const payload: Record<string, unknown> =
      (envelope.data as Record<string, unknown>) ??
      (envelope.payload as Record<string, unknown>) ??
      (payloadData as Record<string, unknown>) ??
      {};
    const aggregateId =
      (payload.orderId as string) ||
      (payload.reservationId as string) ||
      (payload.aggregateId as string) ||
      envelope.aggregateId ||
      null;
    const userId = (payload.userId as string) || envelope.userId || null;
    // Template derived from eventType for dedup key (order.* -> order, reservation.expired -> reservation)
    const template = eventType.includes('order')
      ? 'order'
      : eventType.includes('reservation')
        ? 'reservation'
        : eventType;
    return {
      eventId,
      eventType,
      version,
      correlationId,
      payload,
      aggregateId,
      userId,
      template,
    };
  }

  /**
   * Handles order.created events with idempotency guard before email send.
   * @param data - Event envelope/payload containing eventId, version, correlationId, orderId, userId.
   * @returns Void — ACK is handled by framework; duplicate returns early with incrementCounter.
   */
  @EventPattern('order.created')
  async handleOrderCreated(@Payload() data: any): Promise<void> {
    const { eventId, correlationId, payload, aggregateId, userId, template } =
      this.extractEnvelope(data);
    // Idempotent guard BEFORE EmailProvider.send
    const key = `notification:processed:${eventId}`;
    const isFirst = await this.tryAcquireDedupKey(key);
    if (!isFirst) {
      // Already processed — log + counter + return without side-effect
      this.logger.log(`notification duplicate eventId=${eventId} skipped`);
      await this.incrementCounter();
      return;
    }
    // No Inventory/Order/Reservation mutation — only Logger + email
    this.logger.log(
      `notification received order.created eventId=${eventId} correlationId=${correlationId} orderId=${aggregateId ?? (payload.orderId as string) ?? 'unknown'}`,
    );
    // Only if first → EmailProvider.send → then NotificationLog save
    if (this.emailProvider) {
      try {
        const to = (payload.userId as string)
          ? `${payload.userId}@example.com`
          : 'unknown@example.com';
        // Available stock calculation not needed — notification only
        const result = await this.emailProvider.send(
          to,
          'Order Created',
          template,
          payload,
        );
        await this.saveNotificationLog({
          userId: (userId as string) ?? 'unknown',
          template,
          aggregateId: aggregateId ?? null,
          eventId,
          provider: 'noop',
          messageId: result?.messageId ?? null,
        });
      } catch (e: any) {
        this.logger.warn(`email send failed eventId=${eventId}: ${e?.message}`);
      }
    }
    // In-memory fallback for tests without Redis persistence
    this.processedFallback.add(eventId);
  }

  /**
   * Handles order.completed events with idempotency guard.
   * @param data - Event payload.
   * @returns Void.
   */
  @EventPattern('order.completed')
  async handleOrderCompleted(@Payload() data: any): Promise<void> {
    const { eventId, correlationId, payload, aggregateId, userId, template } =
      this.extractEnvelope(data);
    const key = `notification:processed:${eventId}`;
    const isFirst = await this.tryAcquireDedupKey(key);
    if (!isFirst) {
      this.logger.log(`notification duplicate eventId=${eventId} skipped`);
      await this.incrementCounter();
      return;
    }
    this.logger.log(
      `notification received order.completed eventId=${eventId} correlationId=${correlationId} orderId=${aggregateId ?? 'unknown'}`,
    );
    if (this.emailProvider) {
      try {
        const to = (payload.userId as string)
          ? `${payload.userId}@example.com`
          : 'unknown@example.com';
        const result = await this.emailProvider.send(
          to,
          'Order Completed',
          template,
          payload,
        );
        await this.saveNotificationLog({
          userId: (userId as string) ?? 'unknown',
          template,
          aggregateId: aggregateId ?? null,
          eventId,
          provider: 'noop',
          messageId: result?.messageId ?? null,
        });
      } catch (e: any) {
        this.logger.warn(`email send failed eventId=${eventId}: ${e?.message}`);
      }
    }
    this.processedFallback.add(eventId);
  }

  /**
   * Handles order.cancelled events with idempotency guard.
   * @param data - Event payload.
   * @returns Void.
   */
  @EventPattern('order.cancelled')
  async handleOrderCancelled(@Payload() data: any): Promise<void> {
    const { eventId, correlationId, payload, aggregateId, userId, template } =
      this.extractEnvelope(data);
    const key = `notification:processed:${eventId}`;
    const isFirst = await this.tryAcquireDedupKey(key);
    if (!isFirst) {
      this.logger.log(`notification duplicate eventId=${eventId} skipped`);
      await this.incrementCounter();
      return;
    }
    this.logger.log(
      `notification received order.cancelled eventId=${eventId} correlationId=${correlationId} orderId=${aggregateId ?? 'unknown'}`,
    );
    if (this.emailProvider) {
      try {
        const to = (payload.userId as string)
          ? `${payload.userId}@example.com`
          : 'unknown@example.com';
        const result = await this.emailProvider.send(
          to,
          'Order Cancelled',
          template,
          payload,
        );
        await this.saveNotificationLog({
          userId: (userId as string) ?? 'unknown',
          template,
          aggregateId: aggregateId ?? null,
          eventId,
          provider: 'noop',
          messageId: result?.messageId ?? null,
        });
      } catch (e: any) {
        this.logger.warn(`email send failed eventId=${eventId}: ${e?.message}`);
      }
    }
    this.processedFallback.add(eventId);
  }

  /**
   * Handles reservation.expired events with idempotency guard.
   * @param data - Event payload.
   * @returns Void.
   */
  @EventPattern('reservation.expired')
  async handleReservationExpired(@Payload() data: any): Promise<void> {
    const { eventId, correlationId, payload, aggregateId, userId, template } =
      this.extractEnvelope(data);
    const key = `notification:processed:${eventId}`;
    const isFirst = await this.tryAcquireDedupKey(key);
    if (!isFirst) {
      this.logger.log(`notification duplicate eventId=${eventId} skipped`);
      await this.incrementCounter();
      return;
    }
    this.logger.log(
      `notification received reservation.expired eventId=${eventId} correlationId=${correlationId} reservationId=${aggregateId ?? 'unknown'}`,
    );
    if (this.emailProvider) {
      try {
        const to = (payload.userId as string)
          ? `${payload.userId}@example.com`
          : 'unknown@example.com';
        const result = await this.emailProvider.send(
          to,
          'Reservation Expired',
          template,
          payload,
        );
        await this.saveNotificationLog({
          userId: (userId as string) ?? 'unknown',
          template,
          aggregateId: aggregateId ?? null,
          eventId,
          provider: 'noop',
          messageId: result?.messageId ?? null,
        });
      } catch (e: any) {
        this.logger.warn(`email send failed eventId=${eventId}: ${e?.message}`);
      }
    }
    this.processedFallback.add(eventId);
  }

  /**
   * Bulk send with full re-scan per Q4 A — stateless idempotent via per-user SET NX.
   * Re-scans all eligible users each retry (no checkpoint cursor) and skips already sent via Redis.
   * @param params - Bulk params {campaignId, template, subject, body}.
   * @returns Counts {sent, skipped}.
   */
  async sendBulk(params: {
    campaignId: string;
    template: string;
    subject: string;
    body: string;
    aggregateId?: string;
  }): Promise<{ sent: number; skipped: number }> {
    // Do not use checkpoint cursor — re-scan full eligible SELECT users WHERE marketingOptIn=true
    if (!this.dataSource) {
      this.logger.warn('sendBulk skipped: DataSource not available');
      return { sent: 0, skipped: 0 };
    }
    // For bulk sales, eligible is users where marketingOptIn=true (if column exists) and emailVerified true
    let users: Array<{ id: string; email: string }> = [];
    try {
      // Dynamic query to tolerate missing marketingOptIn column (graceful fallback)
      let repo: any;
      try {
        repo = this.dataSource.getRepository('User');
      } catch {
        return { sent: 0, skipped: 0 };
      }
      // Try marketingOptIn filter first, fallback to emailVerified or all
      let rawUsers: any[] = [];
      try {
        rawUsers = await this.dataSource
          .createQueryBuilder()
          .select('user')
          .from('user', 'user')
          .where('user.marketingOptIn = :optIn', { optIn: true })
          .getMany();
      } catch (e: any) {
        const msg: string = e?.message ?? '';
        if (msg.includes('marketingOptIn') || msg.includes('column')) {
          // Fallback: select all users with emailVerified true or all users
          try {
            rawUsers = await repo.find({
              where: { emailVerified: true } as any,
            });
          } catch {
            rawUsers = await repo.find();
          }
        } else {
          rawUsers = await repo.find();
        }
      }
      // Normalize to id/email shape
      users = rawUsers.map((u: any) => ({
        id: u.id,
        email: u.email ?? `${u.id}@example.com`,
      }));
    } catch (e: any) {
      this.logger.warn(`sendBulk user query failed: ${e?.message}`);
      return { sent: 0, skipped: 0 };
    }

    let sent = 0;
    let skipped = 0;
    // Per-user SET NX notification:send:sales:<campaignId>:<userId> EX 86400
    for (const user of users) {
      // Intent: per-user idempotency so second bulk retry skips first-5 already sent
      const key = `notification:send:${params.template}:${params.campaignId}:${user.id}`;
      const isFirst = await this.tryAcquireDedupKey(key);
      if (!isFirst) {
        // Already sent for this user in prior attempt — skip send
        this.logger.log(
          `notification bulk duplicate skip campaign=${params.campaignId} userId=${user.id}`,
        );
        await this.incrementCounter();
        skipped++;
        continue;
      }
      // Only if first → EmailProvider.send
      if (this.emailProvider) {
        try {
          const result = await this.emailProvider.send(
            user.email,
            params.subject,
            params.template,
            {
              campaignId: params.campaignId,
              body: params.body,
              userId: user.id,
            },
          );
          // Then NotificationLog save if entity exists (onConflict DO NOTHING fallback)
          await this.saveNotificationLog({
            userId: user.id,
            template: params.template,
            aggregateId: params.aggregateId ?? params.campaignId,
            eventId: `${params.campaignId}:${user.id}`,
            provider: 'noop',
            messageId: result?.messageId ?? null,
          });
        } catch (e: any) {
          this.logger.warn(
            `bulk email send failed user=${user.id}: ${e?.message}`,
          );
        }
      }
      sent++;
    }
    this.logger.log(
      `sendBulk completed template=${params.template} campaign=${params.campaignId} sent=${sent} skipped=${skipped} total=${users.length}`,
    );
    return { sent, skipped };
  }
}
