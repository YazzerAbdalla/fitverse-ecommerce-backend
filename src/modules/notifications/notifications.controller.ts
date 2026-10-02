import {
  Body,
  Controller,
  ForbiddenException,
  Get,
  HttpCode,
  NotFoundException,
  Param,
  Patch,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiResponse } from '@nestjs/swagger';
import { ConfigService } from '@nestjs/config';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { Auth } from '../auth/decorators/auth.decorator';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import type { JwtPayloadProps } from '../auth/types';
import { RateLimitGuard } from '../auth/guards/rate-limit.guard';
import { UserRoles } from '../users/enum/roles';
import { CreateSalesNotificationDto } from './dto/create-sales-notification.dto';
import { NotificationHistoryQueryDto } from './dto/notification-history-query.dto';
import { TestEmailDto } from './dto/test-email.dto';
import { EmailChannel } from './channels/email.channel';
import { NotificationService } from './notification.service';
import { Notification } from './entities/notification.entity';

/**
 * This controller exposes notification endpoints.
 * It handles sales bulk enqueue plus user history/unread/read receipts thinly (business rules live in services).
 */
@Controller()
export class NotificationsController {
  constructor(
    private readonly notificationService: NotificationService,
    private readonly emailChannel: EmailChannel,
    private readonly configService: ConfigService,
    @InjectDataSource() private readonly dataSource: DataSource,
  ) {}

  // ---- Sales routes ----

  /**
   * Enqueues an admin sales broadcast for async bulk fan-out.
   * @param dto - Sales campaign payload (title, body, optional productIds).
   * @param actor - Authenticated caller (must be Admin).
   * @returns 202 envelope with the enqueued jobId (campaignId).
   * @throws ForbiddenException if caller is not Admin.
   */
  @Post('admin/notifications/sales')
  @HttpCode(202)
  @UseGuards(RateLimitGuard)
  @Auth(UserRoles.Admin)
  @ApiBearerAuth('JWT-auth')
  @ApiOperation({ summary: 'Enqueue sales bulk' })
  @ApiResponse({ status: 202, description: 'Bulk notification enqueued' })
  @ApiResponse({ status: 401, description: 'Unauthorized' })
  @ApiResponse({ status: 403, description: 'Forbidden — Admin only' })
  @ApiResponse({
    status: 429,
    description: 'Too Many Requests — Retry-After: 3600',
  })
  async enqueueSales(
    @Body() dto: CreateSalesNotificationDto,
    @CurrentUser() actor: JwtPayloadProps,
  ): Promise<{ jobId: string; message: string }> {
    const { jobId } = await this.notificationService.sendSalesCampaign(
      dto,
      actor,
    );
    return { jobId, message: 'Bulk notification enqueued' };
  }

  // ---- Config probe routes ----

  /**
   * Sends a one-off test email to verify SMTP/provider configuration.
   * Bypasses outbox/dedup/history — it is a config probe, not a business notification.
   * @param dto - Recipient plus optional subject/body.
   * @returns Provider accept result including the active provider name.
   */
  @Post('admin/notifications/test-email')
  @UseGuards(RateLimitGuard)
  @Auth(UserRoles.Admin)
  @ApiBearerAuth('JWT-auth')
  @ApiOperation({ summary: 'Send test email (SMTP config probe)' })
  @ApiResponse({ status: 200, description: 'Provider accepted the message' })
  @ApiResponse({ status: 401, description: 'Unauthorized' })
  @ApiResponse({ status: 403, description: 'Forbidden — Admin only' })
  @ApiResponse({
    status: 429,
    description: 'Too Many Requests — Retry-After: 3600',
  })
  async sendTestEmail(@Body() dto: TestEmailDto): Promise<{
    to: string;
    provider: string;
    messageId?: string;
    delivered: boolean;
  }> {
    // Active provider is echoed so noop vs real SMTP is unambiguous in the response
    const provider = this.configService.get<string>('EMAIL_PROVIDER') ?? 'noop';
    const result = await this.emailChannel.send({
      to: dto.to,
      userId: 'admin-probe',
      subject: dto.subject ?? 'Mini E-Commerce SMTP test',
      template: 'test',
      vars: { body: dto.body ?? 'SMTP configuration probe' },
    });
    return {
      to: dto.to,
      provider,
      messageId: result.messageId,
      delivered: result.delivered,
    };
  }

  // ---- History routes ----
  /**
   * Lists the caller's notification history (owner paginated, newest first).
   * @param query - Pagination + optional isRead/channel/type filters (+ Admin-only userId scope).
   * @param user - Authenticated JWT payload.
   * @returns Paginated {data, meta} in the shared offset shape.
   * @throws ForbiddenException when a non-Admin scopes another user's inbox.
   */
  @Get('notifications')
  @Auth()
  @ApiBearerAuth('JWT-auth')
  @ApiOperation({ summary: 'List own notification history' })
  @ApiResponse({ status: 200, description: 'Paginated notifications' })
  @ApiResponse({ status: 401, description: 'Unauthorized' })
  @ApiResponse({ status: 403, description: 'Forbidden — non-owner scope' })
  async listHistory(
    @Query() query: NotificationHistoryQueryDto,
    @CurrentUser() user: JwtPayloadProps,
  ): Promise<{ data: Notification[]; meta: Record<string, number> }> {
    // Admin may scope another inbox via ?userId=; non-Admin scoping another user is forbidden
    const targetUserId =
      query.userId && query.userId !== user.sub ? query.userId : user.sub;
    if (
      query.userId &&
      query.userId !== user.sub &&
      user.role !== UserRoles.Admin
    ) {
      throw new ForbiddenException('You are not allowed to read this inbox.');
    }
    const page = query.page ?? 1;
    const limit = Math.min(query.limit ?? 20, 100);
    // skip = (page - 1) * limit keeps offset pagination consistent with products/order listings
    const skip = (page - 1) * limit;
    const repo = this.dataSource.getRepository(Notification);
    const where: Record<string, unknown> = { userId: targetUserId };
    if (query.isRead !== undefined) where.isRead = query.isRead;
    if (query.channel) where.channel = query.channel.toUpperCase();
    if (query.type) where.type = query.type;
    const [data, totalItems] = await repo.findAndCount({
      where: where,
      order: { sentAt: 'DESC' },
      take: limit,
      skip,
    });
    const totalPages = Math.max(1, Math.ceil(totalItems / limit));
    return {
      data,
      meta: {
        totalItems,
        itemCount: data.length,
        itemsPerPage: limit,
        totalPages,
        currentPage: page,
      },
    };
  }

  /**
   * Counts the caller's unread notifications.
   * @param user - Authenticated JWT payload.
   * @returns Unread count {unreadCount}.
   */
  @Get('notifications/unread-count')
  @Auth()
  @ApiBearerAuth('JWT-auth')
  @ApiOperation({ summary: 'Count unread notifications' })
  @ApiResponse({ status: 200, description: 'Unread count' })
  @ApiResponse({ status: 401, description: 'Unauthorized' })
  async unreadCount(
    @CurrentUser() user: JwtPayloadProps,
  ): Promise<{ unreadCount: number }> {
    // Filtered count on (userId, isRead=false) uses IDX_notification_userId_isRead
    const unreadCount = await this.dataSource
      .getRepository(Notification)
      .count({ where: { userId: user.sub, isRead: false } });
    return { unreadCount };
  }

  /**
   * Marks all of the caller's unread notifications as read.
   * @param user - Authenticated JWT payload.
   * @returns Updated count {updated}.
   */
  @Patch('notifications/read-all')
  @Auth()
  @ApiBearerAuth('JWT-auth')
  @ApiOperation({ summary: 'Mark all notifications as read' })
  @ApiResponse({ status: 200, description: 'Bulk read receipt' })
  @ApiResponse({ status: 401, description: 'Unauthorized' })
  async readAll(
    @CurrentUser() user: JwtPayloadProps,
  ): Promise<{ updated: number }> {
    // Single UPDATE scopes to the owner inbox only — Admin reads others via :id/read with assertOwner
    const result = await this.dataSource
      .createQueryBuilder()
      .update(Notification)
      .set({ isRead: true, readAt: new Date() })
      .where('userId = :userId AND "isRead" = false', { userId: user.sub })
      .execute();
    return { updated: result.affected ?? 0 };
  }

  /**
   * Marks one notification as read (idempotent re-read returns 200).
   * @param id - Notification UUID.
   * @param user - Authenticated JWT payload.
   * @returns Read receipt {id, isRead:true, readAt}.
   * @throws NotFoundException when the row does not exist.
   * @throws ForbiddenException when the row belongs to another user (non-Admin).
   */
  @Patch('notifications/:id/read')
  @Auth()
  @ApiBearerAuth('JWT-auth')
  @ApiOperation({ summary: 'Mark one notification as read' })
  @ApiResponse({ status: 200, description: 'Read receipt' })
  @ApiResponse({ status: 401, description: 'Unauthorized' })
  @ApiResponse({ status: 403, description: 'Forbidden — non-owner' })
  @ApiResponse({ status: 404, description: 'Notification not found' })
  async markRead(
    @Param('id') id: string,
    @CurrentUser() user: JwtPayloadProps,
  ): Promise<{ id: string; isRead: boolean; readAt: Date | null }> {
    return this.dataSource.transaction(async (manager) => {
      const repo = manager.getRepository(Notification);
      // FOR UPDATE serializes concurrent read-all vs single-read for the same row
      const row = await repo.findOne({
        where: { id },
        lock: { mode: 'pessimistic_write' },
      });
      if (!row) {
        throw new NotFoundException(`Notification ${id} not found.`);
      }
      // Owner-or-Admin check: non-Admin reading another inbox is forbidden
      if (row.userId !== user.sub && user.role !== UserRoles.Admin) {
        throw new ForbiddenException(
          'You are not allowed to read this notification.',
        );
      }
      // Idempotent re-read: already-read rows return 200 with the original readAt
      if (!row.isRead) {
        row.isRead = true;
        row.readAt = new Date();
        await repo.save(row);
      }
      return { id: row.id, isRead: row.isRead, readAt: row.readAt };
    });
  }
}
