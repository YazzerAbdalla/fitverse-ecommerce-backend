import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import { CACHE_MANAGER } from '@nestjs/cache-manager';
import type { Cache } from 'cache-manager';
import { ConfigService } from '@nestjs/config';
import { InjectDataSource } from '@nestjs/typeorm';
import { randomUUID } from 'crypto';
import { DataSource } from 'typeorm';
import type { Job } from 'bullmq';
import { Notification } from './entities/notification.entity';
import { NotificationDelivery } from './entities/notification-delivery.entity';
import { NotificationChannel } from './entities/notification-channel.enum';
import { NotificationStatus } from './entities/notification-status.enum';
import { NotificationLog } from './entities/notification-log.entity';
import User from '../users/entity/user.entity';
import { NotificationDispatcher } from './notification.dispatcher';
import type { DispatchChannel } from './notification.dispatcher';
import { NotificationChannelFactory } from './channels/notification-channel.factory';
import { NotificationsGateway } from './notifications.gateway';

/**
 * This processor is responsible for BullMQ sales/new_product bulk fan-out.
 * It handles notification.sendBulk + notification.new_product jobs paged by EMAIL_SALES_BATCH_SIZE with per-user SET NX dedup.
 * Attempts/backoff are set at enqueue (attempts 3 exponential); each job pages Users WHERE marketingOptIn && emailOptIn && emailVerified.
 */
@Processor('notification')
@Injectable()
export class NotificationBulkProcessor extends WorkerHost {
  private readonly logger = new Logger(NotificationBulkProcessor.name);

  constructor(
    @Inject(CACHE_MANAGER) private readonly cache: Cache,
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
  ) {
    super();
  }

  /**
   * Routes BullMQ jobs to the matching bulk handler.
   * @param job - BullMQ job (notification.sendBulk | notification.new_product).
   * @returns Handler result counts.
   */
  async process(job: Job): Promise<{ sent: number; skipped: number }> {
    // Unknown job names are ignored (never throw → no poison retry storm)
    if (job.name === 'notification.sendBulk') {
      return this.handleSendBulk(job.data);
    }
    if (job.name === 'notification.new_product') {
      return this.handleNewProduct(job.data);
    }
    this.logger.debug(`skip job ${job.name}`);
    return { sent: 0, skipped: 0 };
  }

  /**
   * Resolves the bulk page size from config (default 500).
   * @returns Page size for user cursor pagination.
   */
  private get batchSize(): number {
    const raw = this.configService?.get<string>('EMAIL_SALES_BATCH_SIZE');
    const n = parseInt(raw ?? '500', 10);
    return isNaN(n) || n <= 0 ? 500 : n;
  }

  /**
   * Acquires a per-user dedup key via cache SET NX (fail-open on Redis errors).
   * @param key - Dedup key notification:send:<template>:<campaign>:<userId>.
   * @returns True on first acquisition, false on duplicate.
   */
  private async tryAcquireDedupKey(key: string): Promise<boolean> {
    try {
      const first = await (this.cache as any).set(key, '1', 86400000, {
        nx: true,
      } as any);
      if (first === undefined) return true;
      if (!first) return false;
      return true;
    } catch (e: any) {
      this.logger.warn(
        `Redis fail-open for bulk dedup key=${key}: ${e?.message}`,
      );
      return true;
    }
  }

  /**
   * Pages eligible users (marketingOptIn && emailOptIn && emailVerified) with a cursor.
   * @returns Eligible user rows ordered by id.
   */
  private async pageEligibleUsers(): Promise<User[]> {
    if (!this.dataSource) return [];
    const take = this.batchSize;
    const users: User[] = [];
    let skip = 0;
    // Cursor pagination keeps each SELECT bounded at EMAIL_SALES_BATCH_SIZE rows
    for (;;) {
      const repo = this.dataSource.getRepository(User);
      const page = await repo.find({
        where: {
          marketingOptIn: true,
          emailOptIn: true,
          emailVerified: true,
        },
        order: { id: 'ASC' } as any,
        take,
        skip,
      });
      if (page.length === 0) break;
      users.push(...page);
      if (page.length < take) break;
      skip += page.length;
    }
    return users;
  }

  /**
   * Handles a sales bulk job with runtime per-user dispatch gating.
   * @param data - Job data {campaignId, template, subject, body, productIds}.
   * @returns Counts {sent, skipped}.
   */
  async handleSendBulk(data: {
    campaignId: string;
    template?: string;
    subject: string;
    body: string;
    productIds?: string[];
  }): Promise<{ sent: number; skipped: number }> {
    const campaignId = data.campaignId ?? randomUUID();
    const template = data.template ?? 'sales';
    const users = await this.pageEligibleUsers();
    let sent = 0;
    let skipped = 0;
    for (const user of users) {
      // Redis-only dedup before send so replay of the same campaignId sends 0 new
      const key = `notification:send:${template}:${campaignId}:${user.id}`;
      const isFirst = await this.tryAcquireDedupKey(key);
      if (!isFirst) {
        skipped++;
        continue;
      }
      const eventId = randomUUID();
      const channels: DispatchChannel[] = this.dispatcher
        ? this.dispatcher.dispatch(
            { eventId, type: template, userId: user.id },
            {
              marketingOptIn: user.marketingOptIn,
              emailOptIn: user.emailOptIn,
              emailVerified: user.emailVerified,
            },
          )
        : ['system', 'email'];
      await this.deliverToUser({
        eventId,
        type: template,
        userId: user.id,
        email: user.email,
        title: data.subject,
        body: data.body,
        vars: { campaignId, body: data.body, firstName: user.firstName },
        channels,
        logTemplate: template,
      });
      sent++;
    }
    this.logger.log(
      `sendBulk done campaign=${campaignId} sent=${sent} skipped=${skipped} eligible=${users.length}`,
    );
    return { sent, skipped };
  }

  /**
   * Handles a new-product fan-out job (same gate + per-product dedup key).
   * @param data - Job data {productId, name, price}.
   * @returns Counts {sent, skipped}.
   */
  async handleNewProduct(data: {
    productId: string;
    name?: string;
    price?: number;
  }): Promise<{ sent: number; skipped: number }> {
    const productId = data.productId;
    const users = await this.pageEligibleUsers();
    let sent = 0;
    let skipped = 0;
    for (const user of users) {
      // Per-product dedup so the same product fans out once per user even on retry
      const key = `notification:send:new_product:${productId}:${user.id}`;
      const isFirst = await this.tryAcquireDedupKey(key);
      if (!isFirst) {
        skipped++;
        continue;
      }
      const eventId = randomUUID();
      const channels: DispatchChannel[] = this.dispatcher
        ? this.dispatcher.dispatch(
            { eventId, type: 'new_product', userId: user.id },
            {
              marketingOptIn: user.marketingOptIn,
              emailOptIn: user.emailOptIn,
              emailVerified: user.emailVerified,
            },
          )
        : ['system', 'email'];
      await this.deliverToUser({
        eventId,
        type: 'new_product',
        userId: user.id,
        email: user.email,
        title: `New product: ${data.name ?? productId}`,
        body: `${data.name ?? 'A new product'} is now available`,
        vars: { productId, productName: data.name, price: data.price },
        channels,
        logTemplate: 'new_product',
      });
      sent++;
    }
    this.logger.log(
      `new_product done product=${productId} sent=${sent} skipped=${skipped}`,
    );
    return { sent, skipped };
  }

  /**
   * Delivers one user payload via resolved channels with delivery-leg accounting.
   * @param opts - Delivery identity (eventId, type, userId, email, title, body, vars, channels).
   * @returns Void — per-channel throw records attempts/backoff, never aborts the bulk loop.
   */
  private async deliverToUser(opts: {
    eventId: string;
    type: string;
    userId: string;
    email: string;
    title: string;
    body: string;
    vars: Record<string, unknown>;
    channels: DispatchChannel[];
    logTemplate: string;
  }): Promise<void> {
    if (!this.dataSource) return;
    const deliveryRepo = this.dataSource.getRepository(NotificationDelivery);
    const notifRepo = this.dataSource.getRepository(Notification);
    const logRepo = this.dataSource.getRepository(NotificationLog);
    for (const channel of opts.channels) {
      const enumChannel =
        channel === 'email'
          ? NotificationChannel.EMAIL
          : NotificationChannel.SYSTEM;
      try {
        // Unique guard on (eventId, channel) keeps duplicate consume to 0 new rows
        await deliveryRepo
          .createQueryBuilder()
          .insert()
          .into(NotificationDelivery)
          .values({
            eventId: opts.eventId,
            channel: enumChannel,
            status: NotificationStatus.PENDING,
            attempts: 0,
            nextRetryAt: new Date(),
          })
          .orIgnore()
          .execute();
        await notifRepo
          .createQueryBuilder()
          .insert()
          .into(Notification)
          .values({
            userId: opts.userId,
            eventId: opts.eventId,
            channel: enumChannel,
            type: opts.type,
            title: opts.title,
            body: opts.body,
            data: opts.vars,
            status: NotificationStatus.PENDING,
            isRead: false,
          } as any)
          .orIgnore()
          .execute();
        let messageId: string | null = null;
        if (this.channelFactory) {
          const strategy = this.channelFactory.create(channel);
          const result = await strategy.send({
            to: opts.email,
            userId: opts.userId,
            subject: opts.title,
            template: opts.logTemplate,
            vars: opts.vars,
            eventId: opts.eventId,
            type: opts.type,
            title: opts.title,
            body: opts.body,
          });
          messageId = result.messageId ?? null;
        }
        await deliveryRepo.update(
          { eventId: opts.eventId, channel: enumChannel },
          {
            status: NotificationStatus.DELIVERED,
            messageId,
            deliveredAt: new Date(),
          },
        );
        await notifRepo.update(
          { eventId: opts.eventId, channel: enumChannel },
          { status: NotificationStatus.DELIVERED, deliveredAt: new Date() },
        );
        if (channel === 'system') {
          this.gateway?.broadcastToUser(opts.userId, {
            type: opts.type,
            title: opts.title,
            body: opts.body,
            channel: 'system',
            eventId: opts.eventId,
          });
        }
        // Audit row per send (best-effort, orIgnore on eventId keeps replay to 0 new rows)
        try {
          await logRepo
            .createQueryBuilder()
            .insert()
            .into(NotificationLog)
            .values({
              userId: opts.userId,
              template: opts.logTemplate,
              subject: opts.title,
              aggregateId: null,
              eventId: `${opts.eventId}:${opts.userId}`,
              provider:
                this.configService?.get<string>('EMAIL_PROVIDER') ?? 'noop',
              messageId,
            })
            .orIgnore()
            .execute();
        } catch {
          // Audit insert is observability-only — never fails the delivery
        }
      } catch (e: any) {
        // Per-user failure never aborts pagination — record attempts/backoff for retry
        this.logger.warn(
          `bulk channel failed user=${opts.userId} channel=${channel}: ${e?.message}`,
        );
        try {
          const existing = await deliveryRepo.findOne({
            where: { eventId: opts.eventId, channel: enumChannel },
          });
          const attempts = (existing?.attempts ?? 0) + 1;
          const backoffMs = Math.min(60000, 1000 * Math.pow(2, attempts - 1));
          await deliveryRepo.update(
            { eventId: opts.eventId, channel: enumChannel },
            {
              status:
                attempts >= 3
                  ? NotificationStatus.FAILED
                  : NotificationStatus.SENT,
              attempts,
              nextRetryAt: new Date(Date.now() + backoffMs),
            },
          );
        } catch {
          // Backoff accounting is best-effort
        }
      }
    }
  }
}
