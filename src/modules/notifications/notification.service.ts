import { randomUUID } from 'crypto';
import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
  Optional,
} from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import type { Queue } from 'bullmq';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource, In } from 'typeorm';
import { CreateSalesNotificationDto } from './dto/create-sales-notification.dto';
import type { JwtPayload } from '../auth/types';
import { UserRoles } from '../users/enum/roles';
import { Product } from '../products/entities/product.entity';

/**
 * This service is responsible for sales/new_product fan-out enqueueing.
 * It handles admin bulk campaign enqueue and product-created fan-out, and enforces Admin-only enqueue.
 */
@Injectable()
export class NotificationService {
  private readonly logger = new Logger(NotificationService.name);

  constructor(
    @InjectQueue('notification') private readonly queue: Queue,
    @Optional() @InjectDataSource() private readonly dataSource?: DataSource,
  ) {}

  /**
   * Enqueues a sales bulk job for later worker fan-out.
   * @param dto - Sales campaign payload (title 1-200, body, optional productIds).
   * @param actor - Authenticated caller payload (must carry Admin role).
   * @returns The enqueued job id (campaignId).
   * @throws ForbiddenException if actor is not Admin.
   * @throws BadRequestException if title/body are empty or exceed limits.
   * @throws NotFoundException if any productIds entry does not exist.
   */
  async sendSalesCampaign(
    dto: CreateSalesNotificationDto,
    actor: JwtPayload,
  ): Promise<{ jobId: string }> {
    // Admin-only gate: non-Admin callers never reach BullMQ (no job enqueued)
    if (!actor || actor.role !== UserRoles.Admin) {
      throw new ForbiddenException(
        'Only Admin can enqueue sales notifications.',
      );
    }
    // Defensive length check (DTO/ValidationPipe already enforces, service re-validates untrusted input)
    if (!dto.title || dto.title.length < 1 || dto.title.length > 200) {
      throw new BadRequestException('Title must be between 1 and 200 chars.');
    }
    if (!dto.body || dto.body.length < 1) {
      throw new BadRequestException('Body must not be empty.');
    }
    // productIds existence check before enqueue — unknown ids enqueue nothing
    if (dto.productIds && dto.productIds.length > 0 && this.dataSource) {
      const repo = this.dataSource.getRepository(Product);
      const found = await repo.find({
        where: { id: In(dto.productIds) },
      });
      const foundIds = new Set(found.map((p) => p.id));
      // Missing = requested id with no matching Product row
      const missing = dto.productIds.filter((id) => !foundIds.has(id));
      if (missing.length > 0) {
        throw new NotFoundException(
          `Product(s) not found: ${missing.join(', ')}`,
        );
      }
    }
    const campaignId = randomUUID();
    // Design choice: enqueue the campaign payload and let the worker resolve
    // channels at handle time (NotificationDispatcher) — user prefs
    // (marketingOptIn/emailOptIn/emailVerified) may change between enqueue and
    // handle, so resolving now would freeze stale eligibility.
    await this.queue.add(
      'notification.sendBulk',
      {
        campaignId,
        template: 'sales',
        subject: dto.title,
        body: dto.body,
        productIds: dto.productIds ?? [],
      },
      {
        jobId: campaignId,
        attempts: 3,
        backoff: { type: 'exponential', delay: 1000 },
      },
    );
    this.logger.log(
      `sales bulk enqueued campaignId=${campaignId} subject=${dto.title}`,
    );
    return { jobId: campaignId };
  }

  /**
   * Enqueues a new-product fan-out event (fire-and-forget, never throws).
   * @param product - Created product snapshot (id, name, price).
   * @returns Void — failures are logged only so product creation is unaffected.
   */
  async onProductCreated(product: {
    id: string;
    name?: string;
    price?: number;
  }): Promise<void> {
    try {
      // Same deferred-dispatch choice as sales: worker resolves channels at handle time.
      await this.queue.add(
        'notification.new_product',
        { productId: product.id, name: product.name, price: product.price },
        { attempts: 3, backoff: { type: 'exponential', delay: 1000 } },
      );
      this.logger.log(`new_product enqueued productId=${product.id}`);
    } catch (e) {
      // Fire-and-forget: enqueue failure must never break product creation
      this.logger.error(
        `new_product enqueue failed productId=${product.id}: ${(e as Error).message}`,
      );
    }
  }
}
