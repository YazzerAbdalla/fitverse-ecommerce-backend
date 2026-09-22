import {
  Body,
  Controller,
  Get,
  Param,
  Patch,
  Post,
  Query,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiResponse } from '@nestjs/swagger';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { Auth } from '../auth/decorators/auth.decorator';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { UserRoles } from '../users/enum/roles';
import { CheckoutDto } from './dto/checkout.dto';
import { CompleteOrderDto } from './dto/complete-order.dto';
import { OrderService } from './order.service';
import { OrderCheckoutService } from './order-checkout.service';
import { OrderCompletionService } from './order-completion.service';

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
    @InjectDataSource() private readonly dataSource: DataSource,
  ) {}

  @Post('checkout')
  @Auth()
  @ApiBearerAuth('JWT-auth')
  @ApiOperation({ summary: 'Checkout cart → Order + Reservation' })
  @ApiResponse({ status: 201, description: 'Order created' })
  async checkout(@CurrentUser('sub') userId: string, @Body() dto: CheckoutDto) {
    const result = await this.orderCheckoutService.checkout(userId);
    // Return shape per contracts: {id, userId, status, total, createdAt, reservationId, expiresAt, items}
    const order: any = result.order;
    return {
      id: order.id,
      userId: order.userId,
      status: order.status,
      total: order.total,
      createdAt: order.created_at,
      expiresAt: result.reservation?.expiresAt ?? order.expiresAt ?? null,
      reservationId: result.reservation?.id ?? null,
      items: (result.items || order.orderItems || []).map((it: any) => ({
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
  @Auth()
  @ApiBearerAuth('JWT-auth')
  @ApiOperation({
    summary: 'Checkout cart (alias deprecated, use POST /order/checkout)',
  })
  async createAlias(
    @CurrentUser('sub') userId: string,
    @Body() dto: CheckoutDto,
  ) {
    return this.checkout(userId, dto);
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
  async complete(
    @CurrentUser('sub') userId: string,
    @CurrentUser('role') role: UserRoles,
    @Param('id') id: string,
    @Body() dto: CompleteOrderDto,
  ) {
    const result: any = await this.dataSource.transaction((manager) =>
      this.orderCompletionService.complete(manager, userId, id, role),
    );
    // Normalize response shape per contracts/order-complete.md
    return {
      id: result.id,
      status: result.status,
      total: result.total,
      userId: result.userId,
      createdAt: result.created_at ?? result.createdAt,
      updatedAt: result.updated_at ?? result.updatedAt,
      reservationId: result.reservationId ?? result.reservation?.id ?? null,
      expiresAt: result.expiresAt ?? result.reservation?.expiresAt ?? null,
      reservation: result.reservation
        ? {
            id: result.reservation.id,
            status: result.reservation.status,
            expiresAt: result.reservation.expiresAt,
            orderId: result.reservation.orderId,
          }
        : null,
      items: (result.orderItems || []).map((it: any) => ({
        id: it.id,
        productId: it.productId,
        quantity: it.quantity,
        unitPrice: it.unit_price ?? it.unitPrice,
        unit_price: it.unit_price ?? it.unitPrice,
        subtotal: it.subtotal ?? it.quantity * (it.unit_price ?? it.unitPrice),
        productName: it.productNameSnapshot ?? it.product?.name ?? null,
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
  @Auth()
  @ApiBearerAuth('JWT-auth')
  @ApiOperation({
    summary: 'Complete pending order (alias PATCH, use POST)',
  })
  async completePatch(
    @CurrentUser('sub') userId: string,
    @CurrentUser('role') role: UserRoles,
    @Param('id') id: string,
    @Body() dto: CompleteOrderDto,
  ) {
    return this.complete(userId, role, id, dto);
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
