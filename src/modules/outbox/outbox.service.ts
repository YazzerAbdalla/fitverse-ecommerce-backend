import {
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { EntityManager } from 'typeorm';
import { randomUUID } from 'crypto';
import { OutboxEvent } from './entities/outbox-event.entity';
import { OutboxStatus } from './entities/outbox-status.enum';

/**
 * This service is responsible for transactional outbox writes.
 * It handles durable event insertion inside the business transaction so commit guarantees event existence.
 */
@Injectable()
export class OutboxService {
  private readonly logger = new Logger(OutboxService.name);

  /**
   * Creates an outbox event inside the caller's transaction.
   * OutboxService owns the common envelope; business services provide domain data only.
   * Persisted payload is exact payload later published (no reconstruction).
   * @param manager - EntityManager of the enclosing DataSource.transaction (caller owns commit/rollback).
   * @param params - Event metadata; data contains domain fields (orderId, userId, etc.), envelope is built here.
   * @returns Persisted OutboxEvent (PENDING, attempts 0, nextRetryAt NOW()). SENT means published to RabbitMQ, not consumed.
   */
  async createEvent(
    manager: EntityManager,
    params: {
      eventType: string;
      aggregateType: string;
      aggregateId: string;
      data: Record<string, unknown>;
      correlationId?: string;
      payload?: Record<string, unknown>; // deprecated: for backward compat, if provided will be used as data
    },
  ): Promise<OutboxEvent> {
    const id = randomUUID();
    const occurredAt = new Date().toISOString();
    const correlationId = params.correlationId || randomUUID();
    // Business services provide data; envelope is built here to avoid manual envelope duplication
    const data =
      (params as any).payload && !(params as any).data
        ? ((params as any).payload as Record<string, unknown>)
        : params.data || {};
    // Support legacy flat payload with envelope fields already inside data (e.g., version, eventId); extract data if needed
    // If legacy payload already contains envelope fields, treat entire payload as data fallback
    const envelope: Record<string, unknown> = {
      version: 1,
      eventId: id,
      eventType: params.eventType,
      occurredAt,
      correlationId,
      data,
    };

    const repo = manager.getRepository(OutboxEvent);
    const event = repo.create({
      id,
      eventType: params.eventType,
      aggregateType: params.aggregateType,
      aggregateId: params.aggregateId,
      payload: envelope,
      status: OutboxStatus.PENDING,
      attempts: 0,
      nextRetryAt: new Date(),
      lastError: null,
      processingStartedAt: null,
      processingToken: null,
      sentAt: null,
    });

    const saved = await repo.save(event);
    // OutboxEvent INSERT inside same transaction — no client.emit
    // SENT will mean OutboxPublisher published to RabbitMQ, not that consumer processed
    this.logger.debug(
      `outbox created id=${saved.id} eventType=${saved.eventType} aggregateId=${saved.aggregateId} correlationId=${correlationId}`,
    );
    return saved;
  }

  /**
   * Requeues a FAILED outbox event to PENDING inside the caller's transaction.
   * Enforces FOR UPDATE lock and FAILED-only guard; second requeue on already PENDING throws 409.
   * @param manager - EntityManager of the enclosing transaction (caller owns commit/rollback).
   * @param id - OutboxEvent id to requeue.
   * @returns Requeued OutboxEvent with status PENDING.
   * @throws NotFoundException if OutboxEvent not found.
   * @throws ConflictException if status is not FAILED (already PENDING/PROCESSING/SENT).
   */
  async requeue(manager: EntityManager, id: string): Promise<OutboxEvent> {
    const repo = manager.getRepository(OutboxEvent);
    // Lock OutboxEvent FOR UPDATE inside transaction (single-winner requeue)
    const event = await repo.findOne({
      where: { id },
      lock: { mode: 'pessimistic_write' },
    } as any);
    // Not found → 404
    if (!event) {
      throw new NotFoundException(`OutboxEvent ${id} not found`);
    }
    // Only FAILED can be requeued; already PENDING/PROCESSING/SENT → 409 do not double-requeue
    if (event.status !== OutboxStatus.FAILED) {
      throw new ConflictException(
        `OutboxEvent not in FAILED status (status=${event.status})`,
      );
    }
    // Reset to PENDING for publisher reclaim
    event.status = OutboxStatus.PENDING;
    event.attempts = 0;
    event.nextRetryAt = new Date();
    event.lastError = null;
    event.processingStartedAt = null;
    (event as any).processingToken = null;
    const saved = await repo.save(event);
    this.logger.log(`outbox requeue id=${id} eventType=${saved.eventType}`);
    return saved;
  }
}
