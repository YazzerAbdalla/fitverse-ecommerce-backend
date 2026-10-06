import {
  Body,
  Controller,
  Get,
  Param,
  Patch,
  Post,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import { randomUUID } from 'crypto';
import {
  ApiBearerAuth,
  ApiConflictResponse,
  ApiForbiddenResponse,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiResponse,
  ApiTooManyRequestsResponse,
  ApiUnauthorizedResponse,
} from '@nestjs/swagger';
import type { Request } from 'express';
import { RateLimitGuard } from '../auth/guards/rate-limit.guard';
import { Auth } from '../auth/decorators/auth.decorator';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { UserRoles } from '../users/enum/roles';
import { OrderService } from './order.service';
import type { OrderItem } from './entities/order-items.entity';
import { OrderCheckoutService } from './order-checkout.service';
import { OrderCompletionService } from './order-completion.service';
import { OrderCancellationService } from './order-cancellation.service';

/**
 * This controller exposes order endpoints.
 * It handles checkout and read operations thinly.
 */
@Controller('order')
export class OrderController {
  constructor(
    private readonly orderService: OrderService,
    private readonly orderCheckoutService: OrderCheckoutService,
    private readonly orderCompletionService: OrderCompletionService,
    private readonly orderCancellationService: OrderCancellationService,
  ) {}

  @Post('checkout')
  @UseGuards(RateLimitGuard)
  @Auth()
  @ApiBearerAuth('JWT-auth')
  @ApiOperation({
    summary: 'Checkout cart → Order + Reservation',
    description:
      'Async event: order.created via transactional outbox (OutboxEvent PENDING→OutboxPublisher→RabbitMQ)',
  })
  @ApiResponse({ status: 201, description: 'Order created' })
  @ApiResponse({
    status: 429,
    description: 'Too Many Requests — Retry-After: 3600',
  })
  async checkout(
    @CurrentUser('sub') userId: string,
    @Req() req: Request & { headers: Record<string, string | string[]> },
  ) {
    const correlationId =
      req?.headers?.['x-request-id'] ||
      req?.headers?.['x-correlation-id'] ||
      randomUUID();
    const result = await this.orderCheckoutService.checkoutUserCart(
      userId,
      Array.isArray(correlationId) ? correlationId[0] : String(correlationId),
    );
    // Return shape per contracts: {id, userId, status, total, createdAt, reservationId, expiresAt, items}
    const order = result.order;
    return {
      id: order.id,
      userId: order.userId,
      status: order.status,
      total: order.total,
      createdAt: order.created_at,
      expiresAt: result.reservation?.expiresAt ?? null,
      reservationId: result.reservation?.id ?? null,
      items: (result.items || order.orderItems || []).map((it) => ({
        id: it.id,
        productId: it.productId,
        quantity: it.quantity,
        unitPrice: it.unit_price ?? it.unitPrice,
        unit_price: it.unit_price ?? it.unitPrice,
        subtotal: it.subtotal ?? it.quantity * (it.unit_price ?? it.unitPrice),
        productName: it.productNameSnapshot ?? it.product?.name,
      })),
    };
  }

  // Alias deprecated POST /order -> checkout
  @Post()
  @UseGuards(RateLimitGuard)
  @Auth()
  @ApiBearerAuth('JWT-auth')
  @ApiOperation({
    summary: 'Checkout cart (alias deprecated, use POST /order/checkout)',
  })
  async createAlias(
    @CurrentUser('sub') userId: string,
    @Req() req: Request & { headers: Record<string, string | string[]> },
  ) {
    return this.checkout(userId, req);
  }

  /**
   * Completes a pending order sale.
   * It is thin — all business logic is in OrderCompletionService.
   * @param userId - Authenticated user id from JWT sub.
   * @param role - Current user role for admin bypass.
   * @param id - Order id to complete.
   * @param dto - Empty CompleteOrderDto (any extra field → 400).
   * @returns Completed Order enriched with reservationId and items.
   * @throws ForbiddenException if not owner and not Admin.
   * @throws NotFoundException if order/reservation/inventory missing.
   * @throws ConflictException if invalid transition or DB CHECK violation.
   */
  @Post(':id/complete')
  @UseGuards(RateLimitGuard)
  @Auth()
  @ApiBearerAuth('JWT-auth')
  @ApiOperation({ summary: 'Complete pending order → sale (stock-=qty)' })
  @ApiResponse({ status: 200, description: 'Order completed' })
  @ApiResponse({ status: 403, description: 'Forbidden — not owner' })
  @ApiResponse({
    status: 404,
    description: 'Order/Reservation/Inventory not found',
  })
  @ApiResponse({
    status: 409,
    description: 'Invalid transition or insufficient stock',
  })
  @ApiResponse({
    status: 429,
    description: 'Too Many Requests — Retry-After: 3600',
  })
  async completeOrder(
    @CurrentUser('sub') userId: string,
    @CurrentUser('role') role: UserRoles,
    @Param('id') id: string,
    @Req() req: Request & { headers: Record<string, string | string[]> },
  ) {
    const correlationId =
      req?.headers?.['x-request-id'] ||
      req?.headers?.['x-correlation-id'] ||
      randomUUID();
    // Transaction boundary owned by the service (TI-3); the controller stays thin.
    const result = await this.orderCompletionService.completeOrder(
      userId,
      id,
      role,
      Array.isArray(correlationId) ? correlationId[0] : String(correlationId),
    );
    // Normalize response shape per contracts/order-complete.md
    return {
      id: result.id,
      status: result.status,
      total: result.total,
      userId: result.userId,
      createdAt: result.created_at,
      updatedAt: result.updated_at,
      reservationId: result.reservationId,
      expiresAt: result.expiresAt,
      reservation: result.reservation
        ? {
            id: result.reservation.id,
            status: result.reservation.status,
            expiresAt: result.reservation.expiresAt,
            orderId: result.reservation.orderId,
          }
        : null,
      items: (result.orderItems || []).map((orderItemRow: OrderItem) => ({
        id: orderItemRow.id,
        productId: orderItemRow.productId,
        quantity: orderItemRow.quantity,
        unitPrice: orderItemRow.unit_price,
        unit_price: orderItemRow.unit_price,
        subtotal:
          orderItemRow.subtotal ??
          orderItemRow.quantity * orderItemRow.unit_price,
        productName:
          orderItemRow.productNameSnapshot ??
          orderItemRow.product?.name ??
          null,
      })),
    };
  }

  /**
   * Alias PATCH for POST /order/:id/complete (idempotent).
   * @param userId - Authenticated user id.
   * @param role - Current user role.
   * @param id - Order id.
   * @param dto - Empty body.
   * @returns Completed Order.
   */
  @Patch(':id/complete')
  @UseGuards(RateLimitGuard)
  @Auth()
  @ApiBearerAuth('JWT-auth')
  @ApiOperation({
    summary: 'Complete pending order (alias PATCH, use POST)',
  })
  async completePatch(
    @CurrentUser('sub') userId: string,
    @CurrentUser('role') role: UserRoles,
    @Param('id') id: string,
    @Req() req: Request & { headers: Record<string, string | string[]> },
  ) {
    return this.completeOrder(userId, role, id, req);
  }

  /**
   * Cancels a pending order (user or admin). Centralized outbox.
   * @param userId - JWT sub.
   * @param role - User role.
   * @param orderId - Order id.
   * @param request - Request for correlationId.
   * @returns Cancelled order with reason and reservation link.
   */
  @Post(':id/cancel')
  @UseGuards(RateLimitGuard)
  @Auth()
  @ApiBearerAuth('JWT-auth')
  @ApiOperation({
    summary: 'Cancel pending order → order.cancelled via outbox',
    description:
      'Async event: order.cancelled via transactional outbox (OutboxEvent PENDING→OutboxPublisher→RabbitMQ)',
  })
  @ApiOkResponse({ description: 'Order cancelled with reason + reservationId' })
  @ApiUnauthorizedResponse({ description: 'Missing or invalid JWT' })
  @ApiForbiddenResponse({ description: 'Not owner and not Admin' })
  @ApiNotFoundResponse({ description: 'Order or linked inventory not found' })
  @ApiConflictResponse({ description: 'Order already COMPLETED' })
  @ApiTooManyRequestsResponse({ description: 'Rate limit exceeded' })
  async cancelOrder(
    @CurrentUser('sub') userId: string,
    @CurrentUser('role') role: UserRoles,
    @Param('id') orderId: string,
    @Req() request: Request,
  ) {
    // Correlation id resolved at the request boundary, never in the service.
    const correlationId =
      request?.headers?.['x-request-id'] ||
      request?.headers?.['x-correlation-id'] ||
      randomUUID();
    const headerCorrelationId = Array.isArray(correlationId)
      ? correlationId[0]
      : String(correlationId);
    // Transaction boundary owned by the service (TI-3); the controller stays thin.
    const cancelOrderResult = await this.orderCancellationService.cancelOrder(
      orderId,
      'user',
      userId,
      role,
      headerCorrelationId,
    );
    return {
      id: cancelOrderResult.order.id,
      status: cancelOrderResult.order.status,
      total: cancelOrderResult.order.total,
      userId: cancelOrderResult.order.userId,
      reason: cancelOrderResult.reason,
      reservationId: cancelOrderResult.reservationId,
    };
  }

  @Get()
  @Auth()
  @ApiBearerAuth('JWT-auth')
  @ApiOperation({ summary: 'List own orders paginated' })
  async findAll(
    @CurrentUser('sub') userId: string,
    @CurrentUser('role') role: UserRoles,
    @Query('page') page?: string,
    @Query('limit') limit?: string,
    @Query('status') status?: string,
    @Query('userId') filterUserId?: string,
  ) {
    return this.orderService.findAll(
      userId,
      {
        page: page ? parseInt(page, 10) : 1,
        limit: limit ? parseInt(limit, 10) : 20,
        status,
      },
      role,
      filterUserId ? { userId: filterUserId } : undefined,
    );
  }

  @Get(':id')
  @Auth()
  @ApiBearerAuth('JWT-auth')
  @ApiOperation({ summary: 'Get order by id (owner or admin)' })
  async findOne(
    @CurrentUser('sub') userId: string,
    @CurrentUser('role') role: UserRoles,
    @Param('id') id: string,
  ) {
    return this.orderService.findOne(userId, id, role);
  }
}
