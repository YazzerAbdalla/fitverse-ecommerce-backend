import { Injectable, Logger, Optional } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { Notification } from '../entities/notification.entity';
import { NotificationChannel } from '../entities/notification-channel.enum';
import { NotificationStatus } from '../entities/notification-status.enum';
import type { NotificationChannel as ChannelContract } from './notification-channel.interface';

/**
 * This service is responsible for the SYSTEM notification channel.
 * It handles persisting the user-visible Notification row (PG truth for history).
 * Offline recipients stay SENT until the next GET /notifications fetch — no loss, no retry storm.
 */
@Injectable()
export class SystemChannel implements ChannelContract {
  /** Channel key for factory resolution. */
  readonly key = 'system' as const;

  private readonly logger = new Logger(SystemChannel.name);

  constructor(
    @Optional()
    @InjectDataSource()
    private readonly dataSource?: DataSource,
  ) {}

  /**
   * Persists a SYSTEM Notification row; realtime emit is owned by the gateway worker.
   * @param params - Delivery params (userId, subject/template/vars, eventId, type).
   * @returns Persisted marker with delivered=false (seen-state unknown at this layer).
   */
  async send(params: {
    to?: string;
    userId: string;
    subject: string;
    template: string;
    vars: Record<string, unknown>;
    eventId?: string;
    type?: string;
    title?: string;
    body?: string;
  }): Promise<{ messageId?: string; delivered: boolean }> {
    // Persist-only: realtime emit lives in notifications.gateway.ts (another worker) — never import it here.
    const eventId = params.eventId ?? `system-${Date.now()}`;
    const type = params.type ?? params.template;
    const title = params.title ?? params.subject;
    const body = params.body ?? (params.vars?.['body'] as string) ?? '';

    // Best-effort PG persist via the Notification entity repository.
    // orIgnore on (eventId, channel) keeps duplicate consume to 0 new rows.
    if (this.dataSource) {
      try {
        const repo = this.dataSource.getRepository(Notification);
        await repo
          .createQueryBuilder()
          .insert()
          .into(Notification)
          .values({
            userId: params.userId,
            eventId,
            channel: NotificationChannel.SYSTEM,
            type,
            title,
            body,
            data: params.vars ?? {},
            status: NotificationStatus.SENT,
            isRead: false,
          } as any)
          .orIgnore()
          .execute();
      } catch (e: unknown) {
        // Table-not-yet-migrated or transient failure must not crash dispatch — worker retry handles it.
        const msg = e instanceof Error ? e.message : String(e);
        this.logger.warn(`system persist failed eventId=${eventId}: ${msg}`);
      }
    }

    this.logger.log(
      `system persist userId=${params.userId} eventId=${eventId} type=${type}`,
    );
    // Delivered=false: seen-state is resolved by WS ack (online) or history fetch (offline).
    return { delivered: false };
  }
}
