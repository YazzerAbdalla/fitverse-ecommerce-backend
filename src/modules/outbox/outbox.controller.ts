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
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { OutboxEvent } from './entities/outbox-event.entity';
import { OutboxStatus } from './entities/outbox-status.enum';
import { Auth } from '../auth/decorators/auth.decorator';
import { UserRoles } from '../users/enum/roles';

/**
 * This controller exposes outbox admin ops.
 * It handles pagination and requeue for FAILED events.
 */
@ApiTags('outbox')
@Controller('admin/outbox')
export class OutboxController {
  constructor(
    @InjectRepository(OutboxEvent)
    private readonly outboxRepo: Repository<OutboxEvent>,
  ) {}

  /**
   * Lists outbox events paginated (admin).
   * @param status - Optional status filter.
   * @param eventType - Optional eventType filter.
   * @param page - Page number.
   * @param limit - Page size.
   * @returns Paginated outbox events.
   */
  @Get()
  @UseGuards()
  @Auth(UserRoles.Admin)
  @ApiBearerAuth('JWT-auth')
  @ApiOperation({ summary: 'List outbox events (admin)' })
  async findAll(
    @Query('status') status?: string,
    @Query('eventType') eventType?: string,
    @Query('page') page?: string,
    @Query('limit') limit?: string,
  ) {
    const p = Math.max(parseInt(page || '1', 10) || 1, 1);
    const l = Math.min(parseInt(limit || '20', 10) || 20, 100);
    const where: any = {};
    if (status) where.status = status;
    if (eventType) where.eventType = eventType;

    const [data, total] = await this.outboxRepo.findAndCount({
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
   * Requeues a FAILED outbox event for retry.
   * @param id - OutboxEvent id.
   * @returns Requeued event.
   */
  @Patch(':id/requeue')
  @Auth(UserRoles.Admin)
  @ApiBearerAuth('JWT-auth')
  @ApiOperation({ summary: 'Requeue FAILED outbox event' })
  @ApiResponse({ status: 200, description: 'Requeued' })
  @ApiResponse({ status: 404, description: 'Not found' })
  @ApiResponse({ status: 409, description: 'Not FAILED' })
  async requeue(@Param('id') id: string) {
    const event = await this.outboxRepo.findOne({ where: { id } });
    if (!event) {
      return { statusCode: 404, message: `OutboxEvent ${id} not found` };
    }
    if (event.status !== OutboxStatus.FAILED) {
      return {
        statusCode: 409,
        message: `Only FAILED can be requeued, current ${event.status}`,
      };
    }
    event.status = OutboxStatus.PENDING;
    event.attempts = 0;
    event.nextRetryAt = new Date();
    event.lastError = null;
    event.processingStartedAt = null;
    const saved = await this.outboxRepo.save(event);
    return saved;
  }
}
