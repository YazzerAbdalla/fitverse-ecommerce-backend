import {
  Controller,
  Get,
  Param,
  Patch,
  Query,
  UseGuards,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOperation,
  ApiParam,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { OutboxEvent } from './entities/outbox-event.entity';
import { OutboxService } from './outbox.service';
import { Auth } from '../auth/decorators/auth.decorator';
import { UserRoles } from '../users/enum/roles';
import { JwtGuard } from '../auth/guards/jwt.guard';
import { RolesGuard } from '../auth/guards/roles.guard';

/**
 * This controller exposes outbox admin operations.
 * It handles paginated listing and requeue of FAILED outbox events.
 */
@ApiTags('outbox')
@Controller('admin/outbox')
@UseGuards(JwtGuard, RolesGuard)
export class OutboxAdminController {
  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    private readonly outboxService: OutboxService,
  ) {}

  /**
   * Lists outbox events paginated (Admin only).
   * Supports filters status, eventType, aggregateId with createdAt DESC ordering.
   * @param status - Optional status filter (FAILED default per spec).
   * @param eventType - Optional eventType filter.
   * @param aggregateId - Optional aggregateId filter.
   * @param page - Page number (1-indexed).
   * @param limit - Page size (max 100).
   * @returns Paginated outbox events with meta.
   */
  @Get()
  @Auth(UserRoles.Admin)
  @ApiBearerAuth('JWT-auth')
  @ApiOperation({ summary: 'List outbox events (Admin only)' })
  @ApiResponse({ status: 200, description: 'Paginated outbox events' })
  @ApiResponse({ status: 403, description: 'Forbidden — Admin only' })
  async findAll(
    @Query('status') status?: string,
    @Query('eventType') eventType?: string,
    @Query('aggregateId') aggregateId?: string,
    @Query('page') page?: string,
    @Query('limit') limit?: string,
  ) {
    // Pagination: page 1-indexed, limit clamped 1..100
    const p = Math.max(parseInt(page || '1', 10) || 1, 1);
    const l = Math.min(parseInt(limit || '20', 10) || 20, 100);
    // Build where with status, eventType, aggregateId filters (Admin ops queryable FAILED retained)
    const where: any = {};
    if (status) where.status = status;
    if (eventType) where.eventType = eventType;
    if (aggregateId) where.aggregateId = aggregateId;

    const repo = this.dataSource.getRepository(OutboxEvent);
    const [data, total] = await repo.findAndCount({
      where,
      order: { createdAt: 'DESC' },
      skip: (p - 1) * l,
      take: l,
    });

    return {
      data,
      meta: {
        totalItems: total,
        itemCount: data.length,
        itemsPerPage: l,
        totalPages: Math.ceil(total / l) || 1,
        currentPage: p,
      },
    };
  }

  /**
   * Requeues a FAILED outbox event to PENDING (Admin only).
   * Second requeue on already PENDING throws 409 (do not double-requeue).
   * @param id - OutboxEvent id (uuid).
   * @returns Requeued event {id, status: PENDING, attempts: 0, nextRetryAt, eventType}.
   * @throws NotFoundException if id not found.
   * @throws ConflictException if status != FAILED.
   */
  @Patch(':id/requeue')
  @Auth(UserRoles.Admin)
  @ApiBearerAuth('JWT-auth')
  @ApiOperation({ summary: 'Requeue FAILED outbox event (Admin only)' })
  @ApiParam({ name: 'id', type: 'string', format: 'uuid' })
  @ApiResponse({ status: 200, description: 'PENDING' })
  @ApiResponse({ status: 404, description: 'OutboxEvent not found' })
  @ApiResponse({ status: 409, description: 'OutboxEvent not in FAILED status' })
  @ApiResponse({ status: 403, description: 'Forbidden — Admin only' })
  async requeue(@Param('id') id: string) {
    // Transaction owns SELECT FOR UPDATE → check FAILED → UPDATE PENDING attempts=0
    const event = await this.dataSource.transaction((manager) =>
      this.outboxService.requeue(manager, id),
    );
    return {
      id: event.id,
      status: event.status,
      attempts: event.attempts,
      nextRetryAt: event.nextRetryAt,
      eventType: event.eventType,
    };
  }
}

/**
 * Alias for backward compatibility — existing imports may reference OutboxController.
 */
export const OutboxController = OutboxAdminController;
