import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
  Optional,
} from '@nestjs/common';
import { CACHE_MANAGER } from '@nestjs/cache-manager';
import type { Cache } from 'cache-manager';
import { InjectDataSource, InjectRepository } from '@nestjs/typeorm';
import { DataSource, EntityManager, Repository } from 'typeorm';
import { randomUUID } from 'crypto';
import { Payment } from './entities/payment.entity';
import { PaymentStatus } from './entities/payment-status.enum';
import type {
  ConfirmResult,
  PaymentFailureReason,
} from './dto/confirm-payment.dto';
import { Order } from '../order/entities/order.entity';
import { OrderStatus } from '../order/order-status.enum';
import { OrderCompletionService } from '../order/order-completion.service';
import {
  OrderCancellationService,
  type OrderCancelReason,
} from '../order/order-cancellation.service';
import { UserRoles } from '../users/enum/roles';

/**
 * Outcome of confirming a simulated payment, pairing the payment with its order.
 */
export interface ConfirmPaymentResult {
  payment: Payment;
  order: Order;
}

/**
 * Paginated payment list in the shared `{ data, meta }` envelope shape.
 */
export interface ListPaymentsResult {
  data: Payment[];
  meta: {
    totalItems: number;
    itemCount: number;
    itemsPerPage: number;
    totalPages: number;
    currentPage: number;
  };
}

/**
 * This service is responsible for the payment simulation domain (demo, no real provider).
 * It handles owner-only intent/confirm/cancel inside single transactions and enforces
 * one payment per order, terminal idempotency, and fixed lock ordering.
 */
@Injectable()
export class PaymentService {
  private readonly logger = new Logger(PaymentService.name);

  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    @InjectRepository(Payment)
    private readonly paymentRepository: Repository<Payment>,
    private readonly orderCompletionService: OrderCompletionService,
    private readonly orderCancellationService: OrderCancellationService,
    @Optional()
    @Inject(CACHE_MANAGER)
    private readonly cacheManager?: Cache,
  ) {}

  /**
   * Increments the idempotent re-confirm skip counter (fail-open observability only).
   *
   * @returns Void.
   */
  private async incrementConfirmIdempotentSkipCounter(): Promise<void> {
    const counterKey = 'idempotency:duplicate:skipped:payment-confirm';
    try {
      if (!this.cacheManager) {
        return;
      }
      const currentCount =
        (await this.cacheManager.get<number>(counterKey)) ?? 0;
      // cache-manager set() TTL is milliseconds; 24h matches the event-dedup window.
      const twentyFourHoursMs = 24 * 60 * 60 * 1000;
      await this.cacheManager.set(
        counterKey,
        currentCount + 1,
        twentyFourHoursMs,
      );
    } catch (counterError: unknown) {
      const errorMessage =
        counterError instanceof Error
          ? counterError.message
          : String(counterError);
      this.logger.warn(
        `Redis fail-open for idempotency counter ${counterKey}: ${errorMessage}`,
      );
    }
  }

  /**
   * Asserts that the caller owns the payment (owner-only writes, no admin bypass).
   *
   * @param lockedPayment - Payment row carrying the owner id.
   * @param requestingUserId - JWT sub of the caller.
   * @throws ForbiddenException if the caller is not the owner.
   */
  private assertPaymentOwner(
    lockedPayment: Pick<Payment, 'userId'>,
    requestingUserId: string,
  ): void {
    // Owner-only writes (018 Q1): even admins cannot intent/confirm/cancel foreign payments.
    if (lockedPayment.userId !== requestingUserId) {
      throw new ForbiddenException(
        'You are not allowed to access this payment',
      );
    }
  }

  /**
   * Asserts that the caller owns the order (owner-only intent, no admin bypass).
   *
   * @param lockedOrder - Order row carrying the owner id.
   * @param requestingUserId - JWT sub of the caller.
   * @throws ForbiddenException if the caller is not the owner.
   */
  private assertOrderOwnerForIntent(
    lockedOrder: Pick<Order, 'userId'>,
    requestingUserId: string,
  ): void {
    // Owner-only intent (018 Q1): admins use order reads, never payment intent on foreign orders.
    if (lockedOrder.userId !== requestingUserId) {
      throw new ForbiddenException('You are not allowed to access this order');
    }
  }

  /**
   * Starts a simulated payment intent for the caller's pending order.
   * Idempotent when a pending payment already exists for the order.
   *
   * @param requestingUserId - JWT sub of the shopper (must own the order).
   * @param orderId - Order to pay for.
   * @returns The pending payment (new or existing).
   * @throws NotFoundException if the order is missing.
   * @throws ForbiddenException if the caller does not own the order.
   * @throws ConflictException if the order is not pending or a terminal payment exists.
   */
  async createPaymentIntent(
    requestingUserId: string,
    orderId: string,
  ): Promise<Payment> {
    return this.dataSource.transaction(async (manager) => {
      const orderRepository = manager.getRepository(Order);
      // Lock the order first: serializes intent vs concurrent checkout-complete/cancel/expire.
      const lockedOrder = await orderRepository.findOne({
        where: { id: orderId },
        lock: { mode: 'pessimistic_write' },
      });
      if (!lockedOrder) {
        throw new NotFoundException(`Order ${orderId} not found`);
      }
      this.assertOrderOwnerForIntent(lockedOrder, requestingUserId);
      // Only pending orders may start a payment; terminal orders conflict.
      if (lockedOrder.status !== OrderStatus.PENDING) {
        throw new ConflictException(
          `Order ${orderId} is ${lockedOrder.status}, only PENDING orders can start a payment`,
        );
      }
      const paymentRepository = manager.getRepository(Payment);
      const existingPayment = await paymentRepository.findOne({
        where: { orderId },
      });
      if (existingPayment) {
        // One payment per order: pending intent is returned as-is (idempotent POST).
        if (existingPayment.status === PaymentStatus.PENDING) {
          this.logger.log(
            `payment intent idempotent orderId=${orderId} paymentId=${existingPayment.id}`,
          );
          return existingPayment;
        }
        throw new ConflictException(
          `Order ${orderId} already has a terminal payment ${existingPayment.id}`,
        );
      }
      // Amount is always copied from the order total; clients never supply it.
      const pendingPayment = paymentRepository.create({
        orderId: lockedOrder.id,
        userId: lockedOrder.userId,
        amount: lockedOrder.total,
        currency: 'usd',
        status: PaymentStatus.PENDING,
        provider: 'simulation',
        failureReason: null,
      });
      const savedPayment = await paymentRepository.save(pendingPayment);
      this.logger.log(
        `payment intent created paymentId=${savedPayment.id} orderId=${orderId} amount=${savedPayment.amount}`,
      );
      return savedPayment;
    });
  }

  /**
   * Confirms a pending payment with a simulated outcome.
   * Success completes the order (sale); decline fails the order and releases the hold.
   * Terminal re-confirms return the already-processed result with zero delta.
   *
   * @param paymentId - Payment to confirm.
   * @param requestingUserId - JWT sub of the shopper (must own the payment).
   * @param confirmResult - Simulated outcome (success or declined).
   * @param failureReason - Decline reason (required by convention on declined, fixed enum).
   * @param correlationId - Tracing correlation id (generated when absent).
   * @returns The payment paired with its order.
   * @throws NotFoundException if the payment or order is missing.
   * @throws ForbiddenException if the caller does not own the payment.
   * @throws BadRequestException if a declined confirm lacks a valid failure reason.
   */
  async confirmPayment(
    paymentId: string,
    requestingUserId: string,
    confirmResult: ConfirmResult,
    failureReason?: PaymentFailureReason,
    correlationId?: string,
  ): Promise<ConfirmPaymentResult> {
    const effectiveCorrelationId = correlationId ?? randomUUID();
    if (
      confirmResult === 'declined' &&
      (failureReason === undefined || failureReason === null)
    ) {
      throw new BadRequestException(
        'failureReason is required when result is declined',
      );
    }
    return this.dataSource.transaction(async (manager) => {
      const paymentRepository = manager.getRepository(Payment);
      // Lock the payment first: serializes concurrent confirms (single-winner, TI-6).
      const lockedPayment = await paymentRepository.findOne({
        where: { id: paymentId },
        lock: { mode: 'pessimistic_write' },
      });
      if (!lockedPayment) {
        throw new NotFoundException(`Payment ${paymentId} not found`);
      }
      this.assertPaymentOwner(lockedPayment, requestingUserId);
      const orderRepository = manager.getRepository(Order);
      if (lockedPayment.status !== PaymentStatus.PENDING) {
        // Terminal re-confirm: already-processed 200 with zero inventory delta,
        // checked before any Order/Reservation/Inventory lock.
        this.logger.log(
          `payment confirm idempotent skip paymentId=${paymentId} status=${lockedPayment.status}`,
        );
        await this.incrementConfirmIdempotentSkipCounter();
        const linkedOrder = await orderRepository.findOne({
          where: { id: lockedPayment.orderId },
        });
        if (!linkedOrder) {
          throw new NotFoundException(
            `Order ${lockedPayment.orderId} not found`,
          );
        }
        return { payment: lockedPayment, order: linkedOrder };
      }
      if (confirmResult === 'success') {
        // Delegate stock math to the single sale authority (D1); the payment
        // row is marked inside the same transaction (all-or-nothing).
        const completionResult =
          await this.orderCompletionService.completeOrderWithManager(
            manager,
            requestingUserId,
            lockedPayment.orderId,
            undefined,
            effectiveCorrelationId,
          );
        lockedPayment.status = PaymentStatus.SUCCEEDED;
        lockedPayment.failureReason = null;
        const succeededPayment = await paymentRepository.save(lockedPayment);
        this.logger.log(
          `payment confirmed success paymentId=${paymentId} orderId=${lockedPayment.orderId}`,
        );
        return {
          payment: succeededPayment,
          order: completionResult as unknown as Order,
        };
      }
      // Declined: fail the order and release the hold (stock untouched, D2).
      const validatedReason = failureReason as PaymentFailureReason;
      await this.orderCancellationService.cancelOrderWithManager(
        manager,
        lockedPayment.orderId,
        'failed',
        effectiveCorrelationId,
        requestingUserId,
        undefined,
      );
      lockedPayment.status = PaymentStatus.FAILED;
      lockedPayment.failureReason = validatedReason;
      const failedPayment = await paymentRepository.save(lockedPayment);
      const failedOrder = await orderRepository.findOne({
        where: { id: lockedPayment.orderId },
      });
      if (!failedOrder) {
        throw new NotFoundException(`Order ${lockedPayment.orderId} not found`);
      }
      this.logger.log(
        `payment confirmed declined paymentId=${paymentId} orderId=${lockedPayment.orderId} reason=${validatedReason}`,
      );
      return { payment: failedPayment, order: failedOrder };
    });
  }

  /**
   * Cancels the caller's pending payment before confirm.
   * Cancelled payments release the hold without changing stock.
   *
   * @param paymentId - Payment to cancel.
   * @param requestingUserId - JWT sub of the shopper (must own the payment).
   * @param correlationId - Tracing correlation id (generated when absent).
   * @returns The cancelled payment paired with its order.
   * @throws NotFoundException if the payment or order is missing.
   * @throws ForbiddenException if the caller does not own the payment.
   * @throws ConflictException if the payment is already terminal.
   */
  async cancelPayment(
    paymentId: string,
    requestingUserId: string,
    correlationId?: string,
  ): Promise<ConfirmPaymentResult> {
    const effectiveCorrelationId = correlationId ?? randomUUID();
    return this.dataSource.transaction(async (manager) => {
      const paymentRepository = manager.getRepository(Payment);
      // Lock the payment first: serializes cancel vs concurrent confirm.
      const lockedPayment = await paymentRepository.findOne({
        where: { id: paymentId },
        lock: { mode: 'pessimistic_write' },
      });
      if (!lockedPayment) {
        throw new NotFoundException(`Payment ${paymentId} not found`);
      }
      this.assertPaymentOwner(lockedPayment, requestingUserId);
      // Terminal payments cannot be cancelled (confirm stays idempotent instead).
      if (lockedPayment.status !== PaymentStatus.PENDING) {
        throw new ConflictException(
          `Payment ${paymentId} is ${lockedPayment.status} and cannot be cancelled`,
        );
      }
      const cancelReason: OrderCancelReason = 'user';
      await this.orderCancellationService.cancelOrderWithManager(
        manager,
        lockedPayment.orderId,
        cancelReason,
        effectiveCorrelationId,
        requestingUserId,
        undefined,
      );
      lockedPayment.status = PaymentStatus.CANCELLED;
      lockedPayment.failureReason = null;
      const cancelledPayment = await paymentRepository.save(lockedPayment);
      const cancelledOrder = await manager
        .getRepository(Order)
        .findOne({ where: { id: lockedPayment.orderId } });
      if (!cancelledOrder) {
        throw new NotFoundException(`Order ${lockedPayment.orderId} not found`);
      }
      this.logger.log(
        `payment cancelled paymentId=${paymentId} orderId=${lockedPayment.orderId}`,
      );
      return { payment: cancelledPayment, order: cancelledOrder };
    });
  }

  /**
   * Fetches a single payment (owner or admin).
   *
   * @param paymentId - Payment id.
   * @param requestingUserId - JWT sub of the caller.
   * @param callerRole - Caller role for the admin read bypass.
   * @returns The payment.
   * @throws NotFoundException if the payment is missing.
   * @throws ForbiddenException if the caller is neither owner nor admin.
   */
  async getPaymentById(
    paymentId: string,
    requestingUserId: string,
    callerRole?: UserRoles,
  ): Promise<Payment> {
    const foundPayment = await this.paymentRepository.findOne({
      where: { id: paymentId },
    });
    if (!foundPayment) {
      throw new NotFoundException(`Payment ${paymentId} not found`);
    }
    // Reads are owner-or-admin; only writes are owner-only (018 Q1).
    if (
      foundPayment.userId !== requestingUserId &&
      callerRole !== UserRoles.Admin
    ) {
      throw new ForbiddenException(
        'You are not allowed to access this payment',
      );
    }
    return foundPayment;
  }

  /**
   * Lists payments newest-first with pagination and optional status filter.
   * Shoppers see only their own rows; admins may filter by user.
   *
   * @param requestingUserId - JWT sub of the caller.
   * @param callerRole - Caller role for the admin read bypass.
   * @param rawPage - Requested page (defaults to 1).
   * @param rawLimit - Requested page size (defaults to 20, clamped to 1..100).
   * @param statusFilter - Optional status filter (fixed enum).
   * @param filterUserId - Optional admin-only user filter.
   * @returns Paginated payments with shared meta envelope.
   * @throws ForbiddenException if a non-admin requests another user's rows.
   * @throws BadRequestException on invalid pagination or status filter.
   */
  async listPayments(
    requestingUserId: string,
    callerRole?: UserRoles,
    rawPage?: string,
    rawLimit?: string,
    statusFilter?: string,
    filterUserId?: string,
  ): Promise<ListPaymentsResult> {
    const parsedPage = rawPage === undefined ? 1 : Number(rawPage);
    const parsedLimit = rawLimit === undefined ? 20 : Number(rawLimit);
    // Pagination guards reject non-integers and out-of-range values before any query.
    if (!Number.isInteger(parsedPage) || parsedPage < 1) {
      throw new BadRequestException('page must be a positive integer');
    }
    if (
      !Number.isInteger(parsedLimit) ||
      parsedLimit < 1 ||
      parsedLimit > 100
    ) {
      throw new BadRequestException(
        'limit must be an integer between 1 and 100',
      );
    }
    let statusValue: PaymentStatus | undefined;
    if (statusFilter !== undefined && statusFilter !== '') {
      const allowedStatuses: PaymentStatus[] = [
        PaymentStatus.PENDING,
        PaymentStatus.SUCCEEDED,
        PaymentStatus.FAILED,
        PaymentStatus.CANCELLED,
      ];
      // Status filter is restricted to the fixed enum (Q5); anything else is bad input.
      if (!allowedStatuses.includes(statusFilter as PaymentStatus)) {
        throw new BadRequestException(
          `status must be one of ${allowedStatuses.join(' | ')}`,
        );
      }
      statusValue = statusFilter as PaymentStatus;
    }
    let scopedUserId = requestingUserId;
    if (filterUserId !== undefined && filterUserId !== '') {
      // Admin-only user filter: shoppers may only list their own rows.
      if (callerRole !== UserRoles.Admin && filterUserId !== requestingUserId) {
        throw new ForbiddenException(
          'You are not allowed to list other users payments',
        );
      }
      scopedUserId = filterUserId;
    }
    // Offset pagination: skip rows of previous pages to return the requested slice.
    const skipCount = (parsedPage - 1) * parsedLimit;
    const [paymentRows, totalCount] = await this.paymentRepository.findAndCount(
      {
        where: {
          userId: scopedUserId,
          ...(statusValue !== undefined ? { status: statusValue } : {}),
        },
        order: { createdAt: 'DESC' },
        skip: skipCount,
        take: parsedLimit,
      },
    );
    const totalPages =
      totalCount === 0 ? 0 : Math.ceil(totalCount / parsedLimit);
    return {
      data: paymentRows,
      meta: {
        totalItems: totalCount,
        itemCount: paymentRows.length,
        itemsPerPage: parsedLimit,
        totalPages,
        currentPage: parsedPage,
      },
    };
  }

  /**
   * Composes a payment inside the caller's transaction (reserved for composed flows).
   *
   * @param manager - EntityManager of the enclosing transaction (caller owns commit/rollback).
   * @param requestingUserId - Owner of the order.
   * @param orderId - Order to pay for.
   * @returns The pending payment.
   */
  async createPaymentIntentWithManager(
    manager: EntityManager,
    requestingUserId: string,
    orderId: string,
  ): Promise<Payment> {
    const orderRepository = manager.getRepository(Order);
    const lockedOrder = await orderRepository.findOne({
      where: { id: orderId },
      lock: { mode: 'pessimistic_write' },
    });
    if (!lockedOrder) {
      throw new NotFoundException(`Order ${orderId} not found`);
    }
    this.assertOrderOwnerForIntent(lockedOrder, requestingUserId);
    if (lockedOrder.status !== OrderStatus.PENDING) {
      throw new ConflictException(
        `Order ${orderId} is ${lockedOrder.status}, only PENDING orders can start a payment`,
      );
    }
    const paymentRepository = manager.getRepository(Payment);
    const existingPayment = await paymentRepository.findOne({
      where: { orderId },
    });
    if (existingPayment) {
      if (existingPayment.status === PaymentStatus.PENDING) {
        return existingPayment;
      }
      throw new ConflictException(
        `Order ${orderId} already has a terminal payment ${existingPayment.id}`,
      );
    }
    const pendingPayment = paymentRepository.create({
      orderId: lockedOrder.id,
      userId: lockedOrder.userId,
      amount: lockedOrder.total,
      currency: 'usd',
      status: PaymentStatus.PENDING,
      provider: 'simulation',
      failureReason: null,
    });
    return paymentRepository.save(pendingPayment);
  }
}
