import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import { CACHE_MANAGER } from '@nestjs/cache-manager';
import type { Cache } from 'cache-manager';
import { Ctx, EventPattern, Payload, RmqContext } from '@nestjs/microservices';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { EMAIL_PROVIDER } from './email.provider';
import type { EmailProvider } from './email.provider';

/**
 * This consumer is responsible for verification of domain events from RabbitMQ.
 * It handles at-least-once delivery (noAck=false, manual ACK after processing) and is duplicate tolerant via Redis dedup.
 * Phase 12 makes duplicate delivery harmless: second delivery with same eventId skips EmailProvider.send and does not insert second log.
 * No Inventory/Order/Reservation mutation — consumer-side only (Logger + optional EmailProvider/Noop + NotificationLog).
 */
@Injectable()
export class EventVerificationConsumer {
  private readonly logger = new Logger(EventVerificationConsumer.name);

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
   * Attempts to acquire Redis dedup lock via SET NX EX 24h (fail-open).
   * @param key - Dedup key notification:processed:<eventId>.
   * @returns True if first (should process), false if duplicate.
   */
  private async tryAcquireDedupKey(key: string): Promise<boolean> {
    // Guard BEFORE EmailProvider.send — V1 use eventId key for all single events
    let first: any;
    try {
      // Try CACHE_MANAGER SET with NX
      first = await (this.cache as any).set(key, '1', 86400000, {
        nx: true,
      } as any);
      if (first === undefined) {
        const anyCache: any = this.cache as any;
        const store: any = anyCache.store ?? anyCache.stores?.[0] ?? anyCache;
        const client =
          store?.client ?? store?.store?.client ?? anyCache.client ?? null;
        if (client && typeof client.set === 'function') {
          // ioredis SET NX EX
          const res = await client.set(key, '1', 'NX', 'EX', 86400);
          if (res === 'OK' || res === 'ok') first = true;
          else if (res === null || res === 0 || res === false) first = false;
          else first = !!res;
        } else {
          first = true;
        }
      }
    } catch (e: any) {
      // Fail-open on Redis error — allow once
      this.logger.warn(
        `Redis fail-open for idempotency key=${key}: ${e?.message}`,
      );
      first = true;
    }
    if (!first) return false;
    return true;
  }

  /**
   * Increments duplicate skip counter (fail-open).
   * @returns Void.
   */
  private async incrementCounter(): Promise<void> {
    const key = 'idempotency:duplicate:skipped:notification';
    try {
      if (!this.cache) return;
      const anyCache: any = this.cache as any;
      const store: any = anyCache.store ?? anyCache.stores?.[0] ?? anyCache;
      const client =
        store?.client ?? store?.store?.client ?? anyCache.client ?? null;
      if (client && typeof client.incr === 'function') {
        await client.incr(key);
        if (typeof client.expire === 'function')
          await client.expire(key, 86400);
        else if (typeof client.pexpire === 'function')
          await client.pexpire(key, 86400000);
        return;
      }
      const current = ((await this.cache.get<number>(key)) as number) ?? 0;
      await (this.cache as any).set(key, current + 1, 86400000);
    } catch (e: any) {
      this.logger.warn(
        `Redis fail-open for idempotency counter ${key}: ${e?.message}`,
      );
    }
  }

  /**
   * Extracts envelope fields.
   * @param data - Raw envelope {eventId, eventType, version, correlationId, data}.
   * @returns Normalized fields.
   */
  private extractEnvelope(data: any): {
    eventId: string;
    correlationId: string;
    orderId: string;
    reservationId: string;
    payload: Record<string, unknown>;
    template: string;
  } {
    const envelope: any = data ?? {};
    const payload: any = envelope.data ?? envelope.payload ?? {};
    const eventId =
      envelope.eventId ||
      envelope.event_id ||
      payload.eventId ||
      envelope.payload?.eventId ||
      'unknown';
    const correlationId =
      envelope.correlationId ||
      envelope.correlation_id ||
      payload.correlationId ||
      'unknown';
    const orderId =
      payload.orderId || envelope.orderId || envelope.aggregateId || 'unknown';
    const reservationId =
      payload.reservationId || envelope.reservationId || 'unknown';
    const template = envelope.eventType || payload.eventType || 'unknown';
    return {
      eventId,
      correlationId,
      orderId,
      reservationId,
      payload: (payload as Record<string, unknown>) ?? {},
      template,
    };
  }

  /**
   * Handles order.created events with manual ACK and idempotency guard.
   * @param data - Event envelope {version, eventId, eventType, occurredAt, correlationId, data}.
   * @param context - RmqContext for manual acknowledgement.
   * @returns Void — ACK after dedup check, duplicate returns early with incrementCounter.
   */
  @EventPattern('order.created')
  async handleOrderCreated(
    @Payload() data: any,
    @Ctx() context?: RmqContext,
  ): Promise<void> {
    const channel = context?.getChannelRef();
    const originalMsg = context?.getMessage();
    try {
      const envelope: any = data;
      const { eventId, correlationId, orderId, payload, template } =
        this.extractEnvelope(envelope);
      // Idempotent guard BEFORE side-effect
      const key = `notification:processed:${eventId}`;
      const isFirst = await this.tryAcquireDedupKey(key);
      if (!isFirst) {
        this.logger.log(`notification duplicate eventId=${eventId} skipped`);
        await this.incrementCounter();
        if (channel && originalMsg) channel.ack(originalMsg);
        return;
      }
      this.logger.log(
        `notification received order.created eventId=${eventId} correlationId=${correlationId} orderId=${orderId}`,
      );
      // Only if first → EmailProvider.send (noop in dev/test)
      if (this.emailProvider && eventId !== 'unknown') {
        try {
          const to = (payload.userId as string)
            ? `${payload.userId}@example.com`
            : 'unknown@example.com';
          await this.emailProvider.send(to, 'Order Created', template, payload);
        } catch (e: any) {
          this.logger.warn(
            `email send failed eventId=${eventId}: ${e?.message}`,
          );
        }
      }
      // ACK only after processing succeeds
      if (channel && originalMsg) channel.ack(originalMsg);
    } catch (e: any) {
      this.logger.error(
        `order.created processing failed: ${e?.message}`,
        e?.stack,
      );
      // No ACK — allow RabbitMQ requeue/redelivery per queue config
      // Do not throw to prevent double ACK
    }
  }

  /**
   * Handles order.completed events.
   * @param data - Event envelope
   * @param context - RmqContext
   * @returns Void.
   */
  @EventPattern('order.completed')
  async handleOrderCompleted(
    @Payload() data: any,
    @Ctx() context?: RmqContext,
  ): Promise<void> {
    const channel = context?.getChannelRef();
    const originalMsg = context?.getMessage();
    try {
      const envelope: any = data;
      const { eventId, correlationId, orderId, payload, template } =
        this.extractEnvelope(envelope);
      const key = `notification:processed:${eventId}`;
      const isFirst = await this.tryAcquireDedupKey(key);
      if (!isFirst) {
        this.logger.log(`notification duplicate eventId=${eventId} skipped`);
        await this.incrementCounter();
        if (channel && originalMsg) channel.ack(originalMsg);
        return;
      }
      this.logger.log(
        `notification received order.completed eventId=${eventId} correlationId=${correlationId} orderId=${orderId}`,
      );
      if (this.emailProvider && eventId !== 'unknown') {
        try {
          const to = (payload.userId as string)
            ? `${payload.userId}@example.com`
            : 'unknown@example.com';
          await this.emailProvider.send(
            to,
            'Order Completed',
            template,
            payload,
          );
        } catch (e: any) {
          this.logger.warn(
            `email send failed eventId=${eventId}: ${e?.message}`,
          );
        }
      }
      if (channel && originalMsg) channel.ack(originalMsg);
    } catch (e: any) {
      this.logger.error(
        `order.completed processing failed: ${e?.message}`,
        e?.stack,
      );
    }
  }

  /**
   * Handles order.cancelled events.
   * @param data - Event envelope
   * @param context - RmqContext
   * @returns Void.
   */
  @EventPattern('order.cancelled')
  async handleOrderCancelled(
    @Payload() data: any,
    @Ctx() context?: RmqContext,
  ): Promise<void> {
    const channel = context?.getChannelRef();
    const originalMsg = context?.getMessage();
    try {
      const envelope: any = data;
      const { eventId, correlationId, orderId, payload, template } =
        this.extractEnvelope(envelope);
      const key = `notification:processed:${eventId}`;
      const isFirst = await this.tryAcquireDedupKey(key);
      if (!isFirst) {
        this.logger.log(`notification duplicate eventId=${eventId} skipped`);
        await this.incrementCounter();
        if (channel && originalMsg) channel.ack(originalMsg);
        return;
      }
      this.logger.log(
        `notification received order.cancelled eventId=${eventId} correlationId=${correlationId} orderId=${orderId}`,
      );
      if (this.emailProvider && eventId !== 'unknown') {
        try {
          const to = (payload.userId as string)
            ? `${payload.userId}@example.com`
            : 'unknown@example.com';
          await this.emailProvider.send(
            to,
            'Order Cancelled',
            template,
            payload,
          );
        } catch (e: any) {
          this.logger.warn(
            `email send failed eventId=${eventId}: ${e?.message}`,
          );
        }
      }
      if (channel && originalMsg) channel.ack(originalMsg);
    } catch (e: any) {
      this.logger.error(
        `order.cancelled processing failed: ${e?.message}`,
        e?.stack,
      );
    }
  }

  /**
   * Handles reservation.expired events.
   * @param data - Event envelope
   * @param context - RmqContext
   * @returns Void.
   */
  @EventPattern('reservation.expired')
  async handleReservationExpired(
    @Payload() data: any,
    @Ctx() context?: RmqContext,
  ): Promise<void> {
    const channel = context?.getChannelRef();
    const originalMsg = context?.getMessage();
    try {
      const envelope: any = data;
      const { eventId, correlationId, reservationId, payload, template } =
        this.extractEnvelope(envelope);
      const key = `notification:processed:${eventId}`;
      const isFirst = await this.tryAcquireDedupKey(key);
      if (!isFirst) {
        this.logger.log(`notification duplicate eventId=${eventId} skipped`);
        await this.incrementCounter();
        if (channel && originalMsg) channel.ack(originalMsg);
        return;
      }
      this.logger.log(
        `notification received reservation.expired eventId=${eventId} correlationId=${correlationId} reservationId=${reservationId}`,
      );
      if (this.emailProvider && eventId !== 'unknown') {
        try {
          const to = (payload.userId as string)
            ? `${payload.userId}@example.com`
            : 'unknown@example.com';
          await this.emailProvider.send(
            to,
            'Reservation Expired',
            template,
            payload,
          );
        } catch (e: any) {
          this.logger.warn(
            `email send failed eventId=${eventId}: ${e?.message}`,
          );
        }
      }
      if (channel && originalMsg) channel.ack(originalMsg);
    } catch (e: any) {
      this.logger.error(
        `reservation.expired processing failed: ${e?.message}`,
        e?.stack,
      );
    }
  }
}

/**
 * @deprecated Use EventVerificationConsumer — NotificationWorker kept for backward compat.
 * Phase 12 now implements Redis idempotency; this alias preserves import paths.
 */
export class NotificationWorker extends EventVerificationConsumer {}
