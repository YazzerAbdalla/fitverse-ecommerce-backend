import { Injectable, Logger } from '@nestjs/common';
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
   * @param manager - EntityManager of the enclosing DataSource.transaction (caller owns commit/rollback).
   * @param params - Event metadata; payload must contain version and correlationId (added if missing).
   * @returns Persisted OutboxEvent (PENDING, attempts 0, nextRetryAt NOW()).
   */
  async createEvent(
    manager: EntityManager,
    params: {
      eventType: string;
      aggregateType: string;
      aggregateId: string;
      payload: Record<string, unknown>;
      correlationId?: string;
    },
  ): Promise<OutboxEvent> {
    const id = randomUUID();
    const occurredAt = new Date().toISOString();
    // Ensure payload contains required envelope fields; do not overwrite if already set
    const payload: Record<string, unknown> = {
      ...params.payload,
    };
    // eventId == outbox.id for stable dedup
    if (!payload['eventId']) payload['eventId'] = id;
    if (!payload['eventType']) payload['eventType'] = params.eventType;
    if (!payload['version']) payload['version'] = 1;
    if (!payload['occurredAt']) payload['occurredAt'] = occurredAt;
    // correlationId from caller or from payload or generate
    const correlationId =
      params.correlationId ||
      (payload['correlationId'] as string) ||
      randomUUID();
    if (!payload['correlationId']) payload['correlationId'] = correlationId;

    const repo = manager.getRepository(OutboxEvent);
    const event = repo.create({
      id,
      eventType: params.eventType,
      aggregateType: params.aggregateType,
      aggregateId: params.aggregateId,
      payload,
      status: OutboxStatus.PENDING,
      attempts: 0,
      nextRetryAt: new Date(),
      lastError: null,
      processingStartedAt: null,
      sentAt: null,
    });

    const saved = await repo.save(event);
    // OutboxEvent INSERT inside same transaction — no client.emit
    this.logger.debug(
      `outbox created id=${saved.id} eventType=${saved.eventType} aggregateId=${saved.aggregateId} correlationId=${correlationId}`,
    );
    return saved;
  }
}
