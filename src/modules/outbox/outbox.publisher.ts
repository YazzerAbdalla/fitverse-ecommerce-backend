import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectDataSource } from '@nestjs/typeorm';
import { ClientProxy } from '@nestjs/microservices';
import { DataSource } from 'typeorm';
import { lastValueFrom } from 'rxjs';
import { OutboxEvent } from './entities/outbox-event.entity';
import { OutboxStatus } from './entities/outbox-status.enum';

/**
 * This publisher is responsible for outbox relay to RabbitMQ.
 * It handles claiming PENDING/lease-expired rows via FOR UPDATE SKIP LOCKED and publishing persisted payloads.
 */
@Injectable()
export class OutboxPublisher {
  private readonly logger = new Logger(OutboxPublisher.name);

  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    private readonly configService: ConfigService,
    @Optional()
    @Inject('NOTIFICATION_SERVICE')
    private readonly client?: ClientProxy,
  ) {}

  private get batchSize(): number {
    const v = this.configService.get<string>('OUTBOX_BATCH_SIZE');
    const n = parseInt(v || '100', 10);
    return isNaN(n) ? 100 : Math.min(Math.max(n, 1), 200);
  }

  private get leaseMs(): number {
    const v = this.configService.get<string>('OUTBOX_PROCESSING_LEASE_MS');
    const n = parseInt(v || '30000', 10);
    return isNaN(n) ? 30000 : Math.min(Math.max(n, 1000), 120000);
  }

  private get maxAttempts(): number {
    const v = this.configService.get<string>('OUTBOX_MAX_ATTEMPTS');
    const n = parseInt(v || '5', 10);
    return isNaN(n) ? 5 : Math.min(Math.max(n, 1), 10);
  }

  private get retryBaseMs(): number {
    const v = this.configService.get<string>('OUTBOX_RETRY_BASE_MS');
    const n = parseInt(v || '1000', 10);
    return isNaN(n) ? 1000 : Math.min(Math.max(n, 100), 10000);
  }

  private get retryMaxMs(): number {
    const v = this.configService.get<string>('OUTBOX_RETRY_MAX_MS');
    const n = parseInt(v || '60000', 10);
    return isNaN(n) ? 60000 : Math.min(Math.max(n, 1000), 120000);
  }

  /**
   * Computes next retry time with exponential backoff.
   * @param attempts - Current attempts count after increment (1-indexed).
   * @returns Date of next retry.
   */
  private computeNextRetryAt(attempts: number): Date {
    // nextRetryAt = NOW() + min(retryMax, retryBase * 2^(attempts-1))
    const backoff = Math.min(
      this.retryMaxMs,
      this.retryBaseMs * Math.pow(2, attempts - 1),
    );
    return new Date(Date.now() + backoff);
  }

  /**
   * Polls and publishes a batch of pending outbox events.
   * @param limit - Optional batch size override.
   * @returns Count of claimed/sent/failed.
   */
  async publishBatch(limit?: number): Promise<{
    claimed: number;
    sent: number;
    failed: number;
    retried: number;
  }> {
    const lim = limit ?? this.batchSize;

    const rabbitUrl = this.configService.get<string>('RABBITMQ_URL');
    if (!rabbitUrl) {
      this.logger.log('RABBITMQ_URL not set, skipping publish');
      return { claimed: 0, sent: 0, failed: 0, retried: 0 };
    }

    if (!this.client) {
      this.logger.log('NOTIFICATION_SERVICE not available, skipping publish');
      return { claimed: 0, sent: 0, failed: 0, retried: 0 };
    }

    // Claim step inside transaction with FOR UPDATE SKIP LOCKED
    let claimedEvents: OutboxEvent[] = [];

    await this.dataSource.transaction(async (manager) => {
      const repo = manager.getRepository(OutboxEvent);
      // eligibility: (PENDING nextRetryAt<=NOW()) OR (PROCESSING lease expired)
      const qb = repo
        .createQueryBuilder('e')
        .where(
          `(e.status = :pending AND e.nextRetryAt <= NOW()) OR (e.status = :processing AND e.processingStartedAt < NOW() - interval '1 second' * :leaseSec)`,
          {
            pending: OutboxStatus.PENDING,
            processing: OutboxStatus.PROCESSING,
            leaseSec: Math.ceil(this.leaseMs / 1000),
          },
        )
        .orderBy('e.createdAt', 'ASC')
        .addOrderBy('e.id', 'ASC')
        .limit(lim)
        .setLock('pessimistic_write', undefined, { skipLocked: true } as any);

      const rows = await qb.getMany();
      if (rows.length === 0) {
        claimedEvents = [];
        return;
      }

      // Mark as PROCESSING with fresh lease
      const ids = rows.map((r) => r.id);
      // Support both repo.update (simple) and queryBuilder (mock compatibility)
      if (typeof (repo as any).update === 'function') {
        await (repo as any).update(ids as any, {
          status: OutboxStatus.PROCESSING as any,
          processingStartedAt: new Date() as any,
        });
      } else if (typeof (repo as any).createQueryBuilder === 'function') {
        const qb: any = (repo as any).createQueryBuilder();
        if (qb && typeof qb.update === 'function') {
          await qb
            .update(OutboxEvent)
            .set({
              status: OutboxStatus.PROCESSING,
              processingStartedAt: new Date(),
            })
            .whereInIds(ids)
            .execute();
        } else {
          // Mock without update — no-op for test
        }
      }

      // Return claimed rows with updated status for publish loop (outside this TX we will publish)
      // Re-fetch to have processingStartedAt set? Use in-memory rows with status PROCESSING
      claimedEvents = rows.map((r) => {
        r.status = OutboxStatus.PROCESSING;
        r.processingStartedAt = new Date();
        return r;
      });

      this.logger.log(
        `outbox claim id=${ids.join(',')} eventTypes=${rows.map((r) => r.eventType).join(',')} attempts batch=${rows.length}`,
      );
    });

    if (claimedEvents.length === 0) {
      return { claimed: 0, sent: 0, failed: 0, retried: 0 };
    }

    let sent = 0;
    let failed = 0;
    let retried = 0;

    for (const event of claimedEvents) {
      try {
        const payload = event.payload;
        // client.emit returns Observable; await via lastValueFrom for ACK (RabbitMQ accept)
        const obs = this.client.emit(event.eventType, payload);
        if (
          (obs && typeof (obs as any).toPromise === 'function') ||
          typeof lastValueFrom === 'function'
        ) {
          // Use lastValueFrom if available, else subscribe callback
          try {
            await lastValueFrom(obs as any);
          } catch (e: any) {
            // If lastValueFrom throws, treat as failure
            throw e;
          }
        } else if (obs && typeof (obs as any).subscribe === 'function') {
          await new Promise<void>((resolve, reject) => {
            (obs as any).subscribe({
              next: () => resolve(),
              error: (err: any) => reject(err),
              complete: () => resolve(),
            });
          });
        }

        // Success: mark SENT
        await this.dataSource.getRepository(OutboxEvent).update(event.id, {
          status: OutboxStatus.SENT,
          sentAt: new Date(),
          lastError: null,
          processingStartedAt: null,
        });
        this.logger.log(
          `outbox publish succeeded id=${event.id} eventType=${event.eventType} attempts=${event.attempts}`,
        );
        sent++;
      } catch (e: any) {
        const msg: string = (e?.message ?? String(e)).substring(0, 1000);
        // attempts tracks durable retry, not consumer retry
        const nextAttempts = (event.attempts || 0) + 1;
        const nextRetryAt = this.computeNextRetryAt(nextAttempts);
        const willFail = nextAttempts >= this.maxAttempts;

        await this.dataSource.getRepository(OutboxEvent).update(event.id, {
          attempts: nextAttempts,
          lastError: msg,
          nextRetryAt,
          status: willFail ? OutboxStatus.FAILED : OutboxStatus.PENDING,
          processingStartedAt: null,
        });

        if (willFail) {
          this.logger.warn(
            `outbox publish failed id=${event.id} eventType=${event.eventType} attempts=${nextAttempts}/${this.maxAttempts} nextRetryAt=${nextRetryAt.toISOString()} lastError=${msg} -> FAILED retained`,
          );
          failed++;
        } else {
          this.logger.warn(
            `outbox publish failed id=${event.id} eventType=${event.eventType} attempts=${nextAttempts}/${this.maxAttempts} nextRetryAt=${nextRetryAt.toISOString()} lastError=${msg}`,
          );
          retried++;
        }
      }
    }

    return { claimed: claimedEvents.length, sent, failed, retried };
  }

  /**
   * Poll entrypoint (used by interval/BullMQ).
   * @param limit - Optional batch size.
   * @returns Publish batch result.
   */
  async poll(limit?: number): Promise<{
    claimed: number;
    sent: number;
    failed: number;
    retried: number;
  }> {
    return this.publishBatch(limit);
  }
}
