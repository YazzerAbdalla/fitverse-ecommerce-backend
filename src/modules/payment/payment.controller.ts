import {
  Body,
  Controller,
  Get,
  HttpCode,
  Param,
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
  ApiTooManyRequestsResponse,
  ApiUnauthorizedResponse,
} from '@nestjs/swagger';
import type { Request } from 'express';
import { RateLimitGuard } from '../auth/guards/rate-limit.guard';
import { Auth } from '../auth/decorators/auth.decorator';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { UserRoles } from '../users/enum/roles';
import { PaymentService } from './payment.service';
import { CreatePaymentIntentDto } from './dto/create-payment-intent.dto';
import { ConfirmPaymentDto } from './dto/confirm-payment.dto';

/**
 * This controller exposes the payment simulation endpoints (demo, no real provider).
 * It is thin: request parsing plus auth/throttle annotations only; all business
 * logic and transaction boundaries live in PaymentService.
 */
@Controller('payments')
export class PaymentController {
  constructor(private readonly paymentService: PaymentService) {}

  /**
   * Resolves the tracing correlation id at the request boundary.
   *
   * @param request - Incoming HTTP request.
   * @returns Single correlation id string.
   */
  private resolveCorrelationId(request: Request): string {
    const correlationId =
      request?.headers?.['x-request-id'] ||
      request?.headers?.['x-correlation-id'] ||
      randomUUID();
    return Array.isArray(correlationId)
      ? correlationId[0]
      : String(correlationId);
  }

  /**
   * Starts a simulated payment intent for the caller's pending order.
   *
   * @param userId - Authenticated user id from JWT sub.
   * @param intentDto - Order reference (amount is server-copied).
   * @returns The pending payment (201, idempotent on existing pending).
   */
  @Post('intent')
  @UseGuards(RateLimitGuard)
  @Auth()
  @ApiBearerAuth('JWT-auth')
  @ApiOperation({ summary: 'Start simulated payment for own pending order' })
  @ApiOkResponse({ description: 'Pending payment (new or existing)' })
  @ApiUnauthorizedResponse({ description: 'Missing or invalid JWT' })
  @ApiForbiddenResponse({
    description: 'Not the order owner (owner-only writes)',
  })
  @ApiNotFoundResponse({ description: 'Order not found' })
  @ApiConflictResponse({
    description: 'Order not PENDING or terminal payment exists',
  })
  @ApiTooManyRequestsResponse({ description: 'Rate limit exceeded' })
  async createIntent(
    @CurrentUser('sub') userId: string,
    @Body() intentDto: CreatePaymentIntentDto,
  ) {
    // Owner-only writes (018 Q1): no role is forwarded, so no admin bypass can engage.
    return this.paymentService.createPaymentIntent(userId, intentDto.orderId);
  }

  /**
   * Confirms a pending payment with a simulated outcome.
   *
   * @param userId - Authenticated user id from JWT sub.
   * @param paymentId - Payment id.
   * @param confirmDto - Simulated result plus fixed-enum failure reason on decline.
   * @param request - Incoming request for correlation id.
   * @returns The payment paired with its order.
   */
  @Post(':id/confirm')
  @UseGuards(RateLimitGuard)
  @Auth()
  @ApiBearerAuth('JWT-auth')
  @ApiOperation({
    summary: 'Confirm payment (success → COMPLETED, declined → FAILED)',
  })
  @ApiOkResponse({
    description: 'Payment + order (terminal re-confirm is idempotent 200)',
  })
  @ApiUnauthorizedResponse({ description: 'Missing or invalid JWT' })
  @ApiForbiddenResponse({ description: 'Not the payment owner' })
  @ApiNotFoundResponse({ description: 'Payment or order not found' })
  @ApiTooManyRequestsResponse({ description: 'Rate limit exceeded' })
  async confirm(
    @CurrentUser('sub') userId: string,
    @Param('id') paymentId: string,
    @Body() confirmDto: ConfirmPaymentDto,
    @Req() request: Request,
  ) {
    return this.paymentService.confirmPayment(
      paymentId,
      userId,
      confirmDto.result,
      confirmDto.failureReason,
      this.resolveCorrelationId(request),
    );
  }

  /**
   * Cancels the caller's pending payment before confirm.
   *
   * @param userId - Authenticated user id from JWT sub.
   * @param paymentId - Payment id.
   * @param request - Incoming request for correlation id.
   * @returns The cancelled payment paired with its order.
   */
  @Post(':id/cancel')
  @HttpCode(200)
  @Auth()
  @ApiBearerAuth('JWT-auth')
  @ApiOperation({ summary: 'Cancel own pending payment → CANCELLED' })
  @ApiOkResponse({ description: 'Cancelled payment + order' })
  @ApiUnauthorizedResponse({ description: 'Missing or invalid JWT' })
  @ApiForbiddenResponse({ description: 'Not the payment owner' })
  @ApiNotFoundResponse({ description: 'Payment or order not found' })
  @ApiConflictResponse({ description: 'Payment already terminal' })
  async cancel(
    @CurrentUser('sub') userId: string,
    @Param('id') paymentId: string,
    @Req() request: Request,
  ) {
    return this.paymentService.cancelPayment(
      paymentId,
      userId,
      this.resolveCorrelationId(request),
    );
  }

  /**
   * Lists payments newest-first (owner-scoped; admin may filter by user).
   *
   * @param userId - Authenticated user id from JWT sub.
   * @param role - Caller role for the admin read bypass.
   * @param page - Requested page.
   * @param limit - Requested page size.
   * @param status - Optional status filter.
   * @param filterUserId - Optional admin-only user filter.
   * @returns Paginated payments.
   */
  @Get()
  @Auth()
  @ApiBearerAuth('JWT-auth')
  @ApiOperation({ summary: 'List own payments paginated (admin: any user)' })
  @ApiOkResponse({ description: 'Paginated payments' })
  @ApiUnauthorizedResponse({ description: 'Missing or invalid JWT' })
  @ApiForbiddenResponse({ description: 'Non-admin listing another user' })
  async list(
    @CurrentUser('sub') userId: string,
    @CurrentUser('role') role: UserRoles,
    @Query('page') page?: string,
    @Query('limit') limit?: string,
    @Query('status') status?: string,
    @Query('userId') filterUserId?: string,
  ) {
    return this.paymentService.listPayments(
      userId,
      role,
      page,
      limit,
      status,
      filterUserId,
    );
  }

  /**
   * Fetches a single payment (owner or admin).
   *
   * @param userId - Authenticated user id from JWT sub.
   * @param role - Caller role for the admin read bypass.
   * @param paymentId - Payment id.
   * @returns The payment.
   */
  @Get(':id')
  @Auth()
  @ApiBearerAuth('JWT-auth')
  @ApiOperation({ summary: 'Get payment by id (owner or admin)' })
  @ApiOkResponse({ description: 'Payment' })
  @ApiUnauthorizedResponse({ description: 'Missing or invalid JWT' })
  @ApiForbiddenResponse({ description: 'Not owner and not admin' })
  @ApiNotFoundResponse({ description: 'Payment not found' })
  async getById(
    @CurrentUser('sub') userId: string,
    @CurrentUser('role') role: UserRoles,
    @Param('id') paymentId: string,
  ) {
    return this.paymentService.getPaymentById(paymentId, userId, role);
  }
}
