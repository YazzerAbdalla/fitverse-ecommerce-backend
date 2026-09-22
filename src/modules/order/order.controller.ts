import { Body, Controller, Get, Param, Post, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiResponse } from '@nestjs/swagger';
import { Auth } from '../auth/decorators/auth.decorator';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { UserRoles } from '../users/enum/roles';
import { CheckoutDto } from './dto/checkout.dto';
import { OrderService } from './order.service';
import { OrderCheckoutService } from './order-checkout.service';

/**
 * This controller exposes order endpoints.
 * It handles checkout and read operations thinly.
 */
@Controller('order')
export class OrderController {
  constructor(
    private readonly orderService: OrderService,
    private readonly orderCheckoutService: OrderCheckoutService,
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
