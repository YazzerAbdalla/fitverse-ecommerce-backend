import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import { CACHE_MANAGER } from '@nestjs/cache-manager';
import type { Cache } from 'cache-manager';
import { ConfigService } from '@nestjs/config';
import { Ctx, EventPattern, Payload, RmqContext } from '@nestjs/microservices';
import { InjectDataSource } from '@nestjs/typeorm';
import { createHash, randomUUID } from 'crypto';
import { DataSource } from 'typeorm';
import { EMAIL_PROVIDER } from './email.provider';
import type { EmailProvider } from './email.provider';
import { NotificationLog } from './entities/notification-log.entity';
import { Notification } from './entities/notification.entity';
import { NotificationDelivery } from './entities/notification-delivery.entity';
import { NotificationChannel } from './entities/notification-channel.enum';
import { NotificationStatus } from './entities/notification-status.enum';
import { OutboxEvent } from '../outbox/entities/outbox-event.entity';
import { OutboxStatus } from '../outbox/entities/outbox-status.enum';
import User from '../users/entity/user.entity';
import { NotificationDispatcher } from './notification.dispatcher';
import type { DispatchChannel } from './notification.dispatcher';
import { NotificationChannelFactory } from './channels/notification-channel.factory';
import { NotificationsGateway } from './notifications.gateway';

/**
 * This worker is responsible for notification delivery domain (Phase 12 idempotency + Phase 18 US6/US7 delivery-state).
 * It handles at-least-once domain events (order.* / reservation.expired / email.verify / auth.reset) with Redis dedup and log+counter observability.
 * It enforces idempotency via eventId dedup key before any EmailProvider side-effect and tolerates duplicate delivery.
 * It writes CONSUMED on OutboxEvent plus per-channel NotificationDelivery rows, then manual ACKs only after commit.
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
    @Optional()
    private readonly dispatcher?: NotificationDispatcher,
    @Optional()
    private readonly channelFactory?: NotificationChannelFactory,
    @Optional()
    private readonly configService?: ConfigService,
    @Optional()
    private readonly gateway?: NotificationsGateway,
  ) {}

  /**
   * Attempts to acquire a Redis dedup lock via SET NX EX 24h (fail-open).
   * @param key - Dedup key (notification:processed:<eventId> or notification:send:<template>:<campaign>:<userId>).
   * @returns True if first acquisition (should proceed), false if duplicate (should skip).
   */
  async tryAcquireDedupKey(key: string): Promise<boolean> {
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
   * Checks whether a string is a valid UUID (outbox/notification linkage guard).
   * @param value - Candidate event id.
   * @returns True when the value parses as UUID.
   */
  private isUuid(value: string): boolean {
    // Strict uuid check avoids PG invalid-input errors on the uuid-typed eventId columns
    return (
      typeof value === 'string' &&
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
        value,
      )
    );
  }

  /**
   * Maps a lowercase dispatch channel key to the PG enum value.
   * @param channel - Dispatch channel ('system' | 'email').
   * @returns NotificationChannel enum member.
   */
  private toChannelEnum(channel: DispatchChannel): NotificationChannel {
    // Normalized input is lowercase; PG enum is uppercase
    return channel === 'email'
      ? NotificationChannel.EMAIL
      : NotificationChannel.SYSTEM;
  }

  /**
   * Acknowledges the RMQ message only after the CONSUMED commit (at-least-once).
   * @param context - Optional RmqContext (absent in unit tests).
   * @returns Void.
   */
  private ack(context?: RmqContext): void {
    // Same manual-ACK pattern as EventVerificationConsumer: ACK after processing, never on throw
    try {
      const channel = context?.getChannelRef();
      const originalMsg = context?.getMessage();
      if (channel && originalMsg) channel.ack(originalMsg);
    } catch (e: any) {
      this.logger.warn(`ack failed: ${e?.message}`);
    }
  }

  /**
   * Marks an OutboxEvent CONSUMED inside a FOR UPDATE transaction (fail-open).
   * @param eventId - OutboxEvent id (payload.eventId, must be uuid).
   * @returns True when the row was transitioned or already consumed; false when skipped.
   */
  private async markConsumed(eventId: string): Promise<boolean> {
    // Outbox row may not exist for old direct-emit events — fail-open skips PG without blocking delivery
    if (!this.dataSource || !this.isUuid(eventId)) return true;
    try {
      let transitioned = true;
      await this.dataSource.transaction(async (manager) => {
        const repo = manager.getRepository(OutboxEvent);
        // FOR UPDATE serializes concurrent duplicate consumes of the same eventId
        const row = await repo
          .createQueryBuilder('e')
          .setLock('pessimistic_write')
          .where('e.id = :id', { id: eventId })
          .getOne();
        if (!row) return;
        // Only SENT_TO_MQ (or legacy SENT) advances; terminal/failed rows are left untouched
        if (
          row.status !== OutboxStatus.SENT_TO_MQ &&
          row.status !== OutboxStatus.SENT
        ) {
          transitioned = false;
          return;
        }
        row.status = OutboxStatus.CONSUMED;
        row.consumedAt = new Date();
        await repo.save(row);
      });
      return transitioned;
    } catch (e: any) {
      this.logger.warn(
        `markConsumed fail-open eventId=${eventId}: ${e?.message}`,
      );
      return true;
    }
  }

  /**
   * Resolves the recipient contact + preference snapshot for dispatch gating.
   * @param userId - Recipient user id (may be null for legacy payloads).
   * @param fallbackEmail - Email carried in the event payload (verify/reset always carry it).
   * @returns Contact email plus dispatcher prefs (fail-open defaults when the user row is missing).
   */
  private async resolveUserContact(
    userId: string | null,
    fallbackEmail?: string,
  ): Promise<{
    email: string | null;
    prefs: {
      marketingOptIn?: boolean;
      emailOptIn?: boolean;
      emailVerified?: boolean;
    };
  }> {
    // verify/reset carry the real address in the payload; order events resolve via the User row
    const defaults = {
      email: fallbackEmail ?? null,
      prefs: { marketingOptIn: false, emailOptIn: true, emailVerified: false },
    };
    if (!this.dataSource || !userId) return defaults;
    try {
      const repo = this.dataSource.getRepository(User);
      const user = await repo.findOne({ where: { id: userId } });
      if (!user) {
        // Fail-open skip signal: caller logs and skips EMAIL but still persists SYSTEM when userId known
        return defaults;
      }
      return {
        email: user.email ?? fallbackEmail ?? null,
        prefs: {
          marketingOptIn: user.marketingOptIn,
          emailOptIn: user.emailOptIn,
          emailVerified: user.emailVerified,
        },
      };
    } catch (e: any) {
      this.logger.warn(
        `resolveUserContact fail-open userId=${userId}: ${e?.message}`,
      );
      return defaults;
    }
  }

  /**
   * Upserts a PENDING delivery leg per resolved channel (duplicate consume → 0 new rows).
   * @param eventId - OutboxEvent id (uuid).
   * @param channels - Resolved dispatch channels.
   * @returns Void.
   */
  private async upsertDeliveriesPending(
    eventId: string,
    channels: DispatchChannel[],
  ): Promise<void> {
    if (!this.dataSource) return;
    try {
      const repo = this.dataSource.getRepository(NotificationDelivery);
      for (const channel of channels) {
        // Unique guard on (eventId, channel) makes replay idempotent at the PG layer too
        await repo
          .createQueryBuilder()
          .insert()
          .into(NotificationDelivery)
          .values({
            eventId,
            channel: this.toChannelEnum(channel),
            status: NotificationStatus.PENDING,
            attempts: 0,
            nextRetryAt: new Date(),
          })
          .orIgnore()
          .execute();
      }
    } catch (e: any) {
      this.logger.warn(
        `upsertDeliveries fail-open eventId=${eventId}: ${e?.message}`,
      );
    }
  }

  /**
   * Finalizes one channel leg after send (T072: DELIVERED vs attempts/backoff/FAILED).
   * @param eventId - OutboxEvent id.
   * @param channel - Dispatch channel just attempted.
   * @param ok - True when the channel accepted the payload.
   * @param messageId - Provider/WS message id on success.
   * @returns Void.
   */
  private async finalizeDelivery(
    eventId: string,
    channel: DispatchChannel,
    ok: boolean,
    messageId?: string | null,
  ): Promise<void> {
    if (!this.dataSource) return;
    try {
      const deliveryRepo = this.dataSource.getRepository(NotificationDelivery);
      const enumChannel = this.toChannelEnum(channel);
      if (ok) {
        await deliveryRepo.update(
          { eventId, channel: enumChannel },
          {
            status: NotificationStatus.DELIVERED,
            messageId: messageId ?? null,
            deliveredAt: new Date(),
          },
        );
      } else {
        // attempts++ with exponential backoff 1s·2^n capped at 60s; FAILED terminal after 3
        const existing = await deliveryRepo.findOne({
          where: { eventId, channel: enumChannel },
        });
        const attempts = (existing?.attempts ?? 0) + 1;
        const backoffMs = Math.min(60000, 1000 * Math.pow(2, attempts - 1));
        await deliveryRepo.update(
          { eventId, channel: enumChannel },
          {
            status:
              attempts >= 3
                ? NotificationStatus.FAILED
                : NotificationStatus.SENT,
            attempts,
            nextRetryAt: new Date(Date.now() + backoffMs),
          },
        );
      }
      // Mirror the leg outcome onto the user-visible Notification row (best-effort, never throws)
      try {
        const notifRepo = this.dataSource.getRepository(Notification);
        await notifRepo.update(
          { eventId, channel: enumChannel },
          ok
            ? {
                status: NotificationStatus.DELIVERED,
                deliveredAt: new Date(),
              }
            : { status: NotificationStatus.SENT },
        );
      } catch {
        // Notification row may not exist yet for legacy paths — channel already persisted its own copy
      }
    } catch (e: any) {
      this.logger.warn(
        `finalizeDelivery fail-open eventId=${eventId} channel=${channel}: ${e?.message}`,
      );
    }
  }

  /**
   * Marks the OutboxEvent DELIVERED when every resolved leg is DELIVERED (best-effort).
   * @param eventId - OutboxEvent id.
   * @returns Void.
   */
  private async maybeMarkOutboxDelivered(eventId: string): Promise<void> {
    if (!this.dataSource || !this.isUuid(eventId)) return;
    try {
      const deliveryRepo = this.dataSource.getRepository(NotificationDelivery);
      const legs = await deliveryRepo.find({ where: { eventId } });
      // All legs DELIVERED (and at least one) → MQ-leg row advances; otherwise it stays CONSUMED
      if (
        legs.length > 0 &&
        legs.every((l) => l.status === NotificationStatus.DELIVERED)
      ) {
        await this.dataSource
          .getRepository(OutboxEvent)
          .update(eventId, { status: OutboxStatus.DELIVERED });
      }
    } catch (e: any) {
      this.logger.warn(
        `maybeMarkDelivered fail-open eventId=${eventId}: ${e?.message}`,
      );
    }
  }

  /**
   * Shared domain-event pipeline: dedup → CONSUMED → dispatch → per-channel send → ACK.
   * @param opts - Event identity (eventId, eventType, userId), copy, and RMQ context.
   * @returns Void — duplicate returns early with counter + ACK; throw path never ACKs.
   */
  private async processDomainEvent(opts: {
    eventId: string;
    eventType: string;
    userId: string | null;
    email?: string | null;
    title: string;
    body: string;
    template: string;
    vars: Record<string, unknown>;
    aggregateId?: string | null;
    context?: RmqContext;
  }): Promise<void> {
    const key = `notification:processed:${opts.eventId}`;
    const isFirst = await this.tryAcquireDedupKey(key);
    if (!isFirst) {
      this.logger.log(`notification duplicate eventId=${opts.eventId} skipped`);
      await this.incrementCounter();
      this.ack(opts.context);
      return;
    }
    this.logger.log(
      `notification received ${opts.eventType} eventId=${opts.eventId} userId=${opts.userId ?? 'unknown'}`,
    );
    try {
      // Consumer-side CONSUMED write (only for uuid outbox ids; legacy 'unknown' skips PG)
      await this.markConsumed(opts.eventId);
      const contact = await this.resolveUserContact(
        opts.userId,
        opts.email ?? undefined,
      );
      // Runtime channel resolution from current prefs (verify/reset bypass gates inside dispatcher)
      const dispatchType = opts.eventType.toLowerCase().includes('order')
        ? opts.eventType
        : opts.eventType;
      const channels: DispatchChannel[] = this.dispatcher
        ? this.dispatcher.dispatch(
            {
              eventId: opts.eventId,
              type: dispatchType,
              userId: opts.userId ?? 'unknown',
            },
            contact.prefs,
          )
        : ['system', 'email'];
      // Non-uuid eventIds (legacy direct emits) skip PG delivery rows but still send best-effort email
      if (!this.isUuid(opts.eventId)) {
        await this.sendLegacyEmail(opts, contact.email);
        this.ack(opts.context);
        return;
      }
      await this.upsertDeliveriesPending(opts.eventId, channels);
      let firstMessageId: string | null = null;
      for (const channel of channels) {
        // SYSTEM persists its own row; EMAIL needs a user-visible row too — upsert PENDING first
        if (channel === 'email') {
          await this.upsertNotificationRow(opts, channel);
        }
        try {
          const result = await this.sendViaChannel(
            channel,
            opts,
            contact.email,
          );
          if (result.messageId && !firstMessageId)
            firstMessageId = result.messageId;
          await this.finalizeDelivery(
            opts.eventId,
            channel,
            true,
            result.messageId,
          );
          if (channel === 'system') {
            // Realtime emit after persist (offline stays SENT until history fetch)
            this.gateway?.broadcastToUser(opts.userId ?? 'unknown', {
              type: opts.eventType,
              title: opts.title,
              body: opts.body,
              channel: 'system',
              eventId: opts.eventId,
            });
          }
        } catch (e: any) {
          this.logger.warn(
            `channel send failed eventId=${opts.eventId} channel=${channel}: ${e?.message}`,
          );
          await this.finalizeDelivery(opts.eventId, channel, false);
        }
      }
      await this.maybeMarkOutboxDelivered(opts.eventId);
      await this.saveNotificationLog({
        userId: opts.userId ?? 'unknown',
        template: opts.template,
        aggregateId: opts.aggregateId ?? null,
        eventId: opts.eventId,
        provider: this.configService?.get<string>('EMAIL_PROVIDER') ?? 'noop',
        messageId: firstMessageId,
      });
      this.processedFallback.add(opts.eventId);
      // Manual ACK only after the CONSUMED commit + channel legs settle
      this.ack(opts.context);
    } catch (e: any) {
      this.logger.error(
        `${opts.eventType} processing failed eventId=${opts.eventId}: ${e?.message}`,
        e?.stack,
      );
      // No ACK — RabbitMQ requeues per queue config
    }
  }

  /**
   * Upserts a PENDING user-visible Notification row for channels that do not persist themselves.
   * @param opts - Event identity + copy.
   * @param channel - Dispatch channel ('email' — system persists its own row).
   * @returns Void.
   */
  private async upsertNotificationRow(
    opts: {
      eventId: string;
      eventType: string;
      userId: string | null;
      title: string;
      body: string;
      vars: Record<string, unknown>;
    },
    channel: DispatchChannel,
  ): Promise<void> {
    if (!this.dataSource || !this.isUuid(opts.eventId) || !opts.userId) return;
    try {
      const repo = this.dataSource.getRepository(Notification);
      await repo
        .createQueryBuilder()
        .insert()
        .into(Notification)
        .values({
          userId: opts.userId,
          eventId: opts.eventId,
          channel: this.toChannelEnum(channel),
          type: opts.eventType,
          title: opts.title,
          body: opts.body,
          data: opts.vars ?? {},
          status: NotificationStatus.PENDING,
          isRead: false,
        } as any)
        .orIgnore()
        .execute();
    } catch (e: any) {
      this.logger.warn(
        `upsertNotification fail-open eventId=${opts.eventId}: ${e?.message}`,
      );
    }
  }

  /**
   * Sends via the resolved channel strategy (factory) with real-email lookup.
   * @param channel - Dispatch channel.
   * @param opts - Event identity + copy.
   * @param email - Resolved recipient address (may be null → EMAIL send throws → attempts++ path).
   * @returns Provider result {messageId, delivered}.
   * @throws Rethrows channel errors so the caller records attempts/backoff.
   */
  private async sendViaChannel(
    channel: DispatchChannel,
    opts: {
      userId: string | null;
      title: string;
      template: string;
      vars: Record<string, unknown>;
      eventId: string;
      eventType: string;
      body: string;
    },
    email: string | null,
  ): Promise<{ messageId?: string; delivered: boolean }> {
    if (!this.channelFactory) {
      throw new Error('Channel factory not configured');
    }
    const strategy = this.channelFactory.create(channel);
    return strategy.send({
      to: email ?? undefined,
      userId: opts.userId ?? 'unknown',
      subject: opts.title,
      template: opts.template,
      vars: opts.vars,
      eventId: opts.eventId,
      type: opts.eventType,
      title: opts.title,
      body: opts.body,
    });
  }

  /**
   * Legacy best-effort email path for non-uuid eventIds (pre-outbox direct emits).
   * @param opts - Event identity + copy.
   * @param email - Resolved recipient address.
   * @returns Void.
   */
  private async sendLegacyEmail(
    opts: {
      title: string;
      template: string;
      vars: Record<string, unknown>;
      eventId: string;
      userId: string | null;
      aggregateId?: string | null;
    },
    email: string | null,
  ): Promise<void> {
    if (!this.emailProvider || !email) return;
    try {
      const result = await this.emailProvider.send(
        email,
        opts.title,
        opts.template,
        opts.vars,
      );
      await this.saveNotificationLog({
        userId: opts.userId ?? 'unknown',
        template: opts.template,
        aggregateId: opts.aggregateId ?? null,
        eventId: opts.eventId,
        provider: this.configService?.get<string>('EMAIL_PROVIDER') ?? 'noop',
        messageId: result?.messageId ?? null,
      });
    } catch (e: any) {
      this.logger.warn(
        `email send failed eventId=${opts.eventId}: ${e?.message}`,
      );
    }
    this.processedFallback.add(opts.eventId);
  }

  /**
   * Handles order.created events with idempotency guard before email send.
   * @param data - Event envelope/payload containing eventId, version, correlationId, orderId, userId.
   * @param context - RmqContext for manual acknowledgement after CONSUMED commit.
   * @returns Void — duplicate returns early with incrementCounter + ACK.
   */
  @EventPattern('order.created')
  async handleOrderCreated(
    @Payload() data: any,
    @Ctx() context?: RmqContext,
  ): Promise<void> {
    const { eventId, eventType, payload, aggregateId, userId, template } =
      this.extractEnvelope(data);
    await this.processDomainEvent({
      eventId,
      eventType: eventType === 'unknown' ? 'order.created' : eventType,
      userId,
      title: 'Order Created',
      body: `Order ${aggregateId ?? 'unknown'} created`,
      template,
      vars: payload,
      aggregateId,
      context,
    });
  }

  /**
   * Handles order.completed events with idempotency guard.
   * @param data - Event payload.
   * @param context - RmqContext for manual acknowledgement after CONSUMED commit.
   * @returns Void.
   */
  @EventPattern('order.completed')
  async handleOrderCompleted(
    @Payload() data: any,
    @Ctx() context?: RmqContext,
  ): Promise<void> {
    const { eventId, eventType, payload, aggregateId, userId, template } =
      this.extractEnvelope(data);
    await this.processDomainEvent({
      eventId,
      eventType: eventType === 'unknown' ? 'order.completed' : eventType,
      userId,
      title: 'Order Completed',
      body: `Order ${aggregateId ?? 'unknown'} completed`,
      template,
      vars: payload,
      aggregateId,
      context,
    });
  }

  /**
   * Handles order.cancelled events with idempotency guard.
   * @param data - Event payload.
   * @param context - RmqContext for manual acknowledgement after CONSUMED commit.
   * @returns Void.
   */
  @EventPattern('order.cancelled')
  async handleOrderCancelled(
    @Payload() data: any,
    @Ctx() context?: RmqContext,
  ): Promise<void> {
    const { eventId, eventType, payload, aggregateId, userId, template } =
      this.extractEnvelope(data);
    await this.processDomainEvent({
      eventId,
      eventType: eventType === 'unknown' ? 'order.cancelled' : eventType,
      userId,
      title: 'Order Cancelled',
      body: `Order ${aggregateId ?? 'unknown'} cancelled`,
      template,
      vars: payload,
      aggregateId,
      context,
    });
  }

  /**
   * Handles reservation.expired events with idempotency guard.
   * @param data - Event payload.
   * @param context - RmqContext for manual acknowledgement after CONSUMED commit.
   * @returns Void.
   */
  @EventPattern('reservation.expired')
  async handleReservationExpired(
    @Payload() data: any,
    @Ctx() context?: RmqContext,
  ): Promise<void> {
    const { eventId, eventType, payload, aggregateId, userId, template } =
      this.extractEnvelope(data);
    await this.processDomainEvent({
      eventId,
      eventType: eventType === 'unknown' ? 'reservation.expired' : eventType,
      userId,
      title: 'Reservation Expired',
      body: `Reservation ${aggregateId ?? 'unknown'} expired`,
      template,
      vars: payload,
      aggregateId,
      context,
    });
  }

  /**
   * Handles email.verification_requested events (trust-critical, always both channels).
   * @param data - Flat auth payload {userId, email, rawToken, expiresAt} (no outbox envelope).
   * @param context - RmqContext for manual acknowledgement after commit.
   * @returns Void — fail-open skip when the user row is missing; never throws to the broker.
   */
  @EventPattern('email.verification_requested')
  async handleVerificationRequested(
    @Payload() data: any,
    @Ctx() context?: RmqContext,
  ): Promise<void> {
    const payload: any = data?.data ?? data ?? {};
    const userId: string | null = payload.userId ?? data?.userId ?? null;
    const email: string | null = payload.email ?? data?.email ?? null;
    const rawToken: string | undefined =
      payload.rawToken ?? data?.rawToken ?? undefined;
    // Dedup on the token hash: each emit carries a unique rawToken, replays carry the same one
    const tokenHash = rawToken
      ? createHash('sha256').update(rawToken).digest('hex')
      : randomUUID();
    const key = `notification:processed:verify:${tokenHash}`;
    const isFirst = await this.tryAcquireDedupKey(key);
    if (!isFirst) {
      this.logger.log(`verification duplicate userId=${userId} skipped`);
      await this.incrementCounter();
      this.ack(context);
      return;
    }
    try {
      // Real email lookup: payload address wins, User row is the fallback — never a placeholder
      const contact = await this.resolveUserContact(userId, email ?? undefined);
      const to = contact.email;
      if (!to) {
        // Fail-open skip when neither payload nor User row yields an address
        this.logger.warn(`verification skipped, no email userId=${userId}`);
        this.ack(context);
        return;
      }
      const frontend =
        this.configService?.get<string>('FRONTEND_URL') ??
        'https://app.example.com';
      const link = rawToken
        ? `${frontend}/verify-email?token=${rawToken}&email=${encodeURIComponent(to)}`
        : frontend;
      const eventId = randomUUID();
      const channels: DispatchChannel[] = this.dispatcher
        ? this.dispatcher.dispatch(
            { eventId, type: 'verify', userId: userId ?? 'unknown' },
            { ...contact.prefs, emailVerified: contact.prefs.emailVerified },
          )
        : ['system', 'email'];
      await this.upsertDeliveriesPending(eventId, channels);
      if (channels.includes('system') && userId) {
        await this.upsertNotificationRow(
          {
            eventId,
            eventType: 'verify',
            userId,
            title: 'Verify your email',
            body: `Verify your email: ${link}`,
            vars: { link, email: to },
          },
          'system',
        );
      }
      if (channels.includes('email') && userId) {
        await this.upsertNotificationRow(
          {
            eventId,
            eventType: 'verify',
            userId,
            title: 'Verify your email',
            body: `Verify your email: ${link}`,
            vars: { link, email: to },
          },
          'email',
        );
      }
      for (const channel of channels) {
        try {
          const result = await this.sendViaChannel(
            channel,
            {
              userId: userId ?? 'unknown',
              title: 'Verify your email',
              template: 'verify',
              vars: { link, email: to, firstName: '' },
              eventId,
              eventType: 'verify',
              body: `Verify your email: ${link}`,
            },
            to,
          );
          await this.finalizeDelivery(eventId, channel, true, result.messageId);
          if (channel === 'system' && userId) {
            this.gateway?.broadcastToUser(userId, {
              type: 'verify',
              title: 'Verify your email',
              body: `Verify your email: ${link}`,
              channel: 'system',
              eventId,
            });
          }
        } catch (e: any) {
          this.logger.warn(
            `verify channel failed userId=${userId} channel=${channel}: ${e?.message}`,
          );
          await this.finalizeDelivery(eventId, channel, false);
        }
      }
      await this.saveNotificationLog({
        userId: userId ?? 'unknown',
        template: 'verify',
        aggregateId: null,
        eventId,
        provider: this.configService?.get<string>('EMAIL_PROVIDER') ?? 'noop',
        messageId: null,
      });
      this.processedFallback.add(key);
      this.ack(context);
    } catch (e: any) {
      this.logger.error(
        `verify processing failed userId=${userId}: ${e?.message}`,
        e?.stack,
      );
      // No ACK — RabbitMQ requeues per queue config
    }
  }

  /**
   * Handles auth.password_reset_requested events (trust-critical, always both channels).
   * @param data - Flat auth payload {userId, email, rawToken, expiresAt} (no outbox envelope).
   * @param context - RmqContext for manual acknowledgement after commit.
   * @returns Void — fail-open skip when the user row is missing; never throws to the broker.
   */
  @EventPattern('auth.password_reset_requested')
  async handlePasswordResetRequested(
    @Payload() data: any,
    @Ctx() context?: RmqContext,
  ): Promise<void> {
    const payload: any = data?.data ?? data ?? {};
    const userId: string | null = payload.userId ?? data?.userId ?? null;
    const email: string | null = payload.email ?? data?.email ?? null;
    const rawToken: string | undefined =
      payload.rawToken ?? data?.rawToken ?? undefined;
    const tokenHash = rawToken
      ? createHash('sha256').update(rawToken).digest('hex')
      : randomUUID();
    const key = `notification:processed:reset:${tokenHash}`;
    const isFirst = await this.tryAcquireDedupKey(key);
    if (!isFirst) {
      this.logger.log(`reset duplicate userId=${userId} skipped`);
      await this.incrementCounter();
      this.ack(context);
      return;
    }
    try {
      // Real email lookup: payload address wins, User row is the fallback — never a placeholder
      const contact = await this.resolveUserContact(userId, email ?? undefined);
      const to = contact.email;
      if (!to) {
        // Fail-open skip when neither payload nor User row yields an address
        this.logger.warn(`reset skipped, no email userId=${userId}`);
        this.ack(context);
        return;
      }
      const frontend =
        this.configService?.get<string>('FRONTEND_URL') ??
        'https://app.example.com';
      const link = rawToken
        ? `${frontend}/reset-password?token=${rawToken}&email=${encodeURIComponent(to)}`
        : frontend;
      const eventId = randomUUID();
      const channels: DispatchChannel[] = this.dispatcher
        ? this.dispatcher.dispatch(
            { eventId, type: 'reset', userId: userId ?? 'unknown' },
            { ...contact.prefs },
          )
        : ['system', 'email'];
      await this.upsertDeliveriesPending(eventId, channels);
      if (userId) {
        for (const channel of channels) {
          await this.upsertNotificationRow(
            {
              eventId,
              eventType: 'reset',
              userId,
              title: 'Reset your password',
              body: 'Reset your password link expires in 15m',
              vars: { link, email: to, expiresIn: '15m' },
            },
            channel,
          );
        }
      }
      for (const channel of channels) {
        try {
          const result = await this.sendViaChannel(
            channel,
            {
              userId: userId ?? 'unknown',
              title: 'Reset your password',
              template: 'reset',
              vars: { link, email: to, expiresIn: '15m' },
              eventId,
              eventType: 'reset',
              body: 'Reset your password link expires in 15m',
            },
            to,
          );
          await this.finalizeDelivery(eventId, channel, true, result.messageId);
          if (channel === 'system' && userId) {
            this.gateway?.broadcastToUser(userId, {
              type: 'reset',
              title: 'Reset your password',
              body: 'Reset your password link expires in 15m',
              channel: 'system',
              eventId,
            });
          }
        } catch (e: any) {
          this.logger.warn(
            `reset channel failed userId=${userId} channel=${channel}: ${e?.message}`,
          );
          await this.finalizeDelivery(eventId, channel, false);
        }
      }
      await this.saveNotificationLog({
        userId: userId ?? 'unknown',
        template: 'reset',
        aggregateId: null,
        eventId,
        provider: this.configService?.get<string>('EMAIL_PROVIDER') ?? 'noop',
        messageId: null,
      });
      this.processedFallback.add(key);
      this.ack(context);
    } catch (e: any) {
      this.logger.error(
        `reset processing failed userId=${userId}: ${e?.message}`,
        e?.stack,
      );
      // No ACK — RabbitMQ requeues per queue config
    }
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
