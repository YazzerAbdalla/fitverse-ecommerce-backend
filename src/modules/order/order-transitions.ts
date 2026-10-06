/**
 * This module owns the order status transition rules and ownership checks.
 * It is the single authority for which order transitions are legal, so the
 * checkout/completion/cancellation/retrieval paths cannot drift apart.
 *
 * Responsibility (SRP): order transition table + ownership predicate +
 * inventory CHECK-violation mapping, nothing else.
 * Used by: OrderService, OrderCheckoutService, OrderCompletionService,
 * OrderCancellationService (all in this module).
 */
import { ConflictException, ForbiddenException } from '@nestjs/common';
import { QueryFailedError } from 'typeorm';
import { Order } from './entities/order.entity';
import { OrderStatus } from './order-status.enum';
import { UserRoles } from '../users/enum/roles';

/**
 * Allowed order status transitions (single source of truth).
 * COMPLETED→COMPLETED is idempotent and short-circuited by callers before
 * consulting this map for any other edge.
 */
export const ALLOWED_ORDER_TRANSITIONS: Record<OrderStatus, OrderStatus[]> = {
  [OrderStatus.PENDING]: [
    OrderStatus.COMPLETED,
    OrderStatus.CANCELLED,
    OrderStatus.FAILED,
  ],
  [OrderStatus.COMPLETED]: [OrderStatus.COMPLETED],
  [OrderStatus.CANCELLED]: [],
  [OrderStatus.FAILED]: [],
};

/**
 * Validates an order status transition against the shared table.
 *
 * @param fromStatus - Current order status.
 * @param toStatus - Target order status.
 * @throws ConflictException if the transition is not allowed.
 */
export function validateOrderTransition(
  fromStatus: OrderStatus,
  toStatus: OrderStatus,
): void {
  // Idempotent COMPLETED→COMPLETED short-circuit (no inventory effect).
  if (
    fromStatus === OrderStatus.COMPLETED &&
    toStatus === OrderStatus.COMPLETED
  ) {
    return;
  }
  const allowedTargets = ALLOWED_ORDER_TRANSITIONS[fromStatus] ?? [];
  if (!allowedTargets.includes(toStatus)) {
    throw new ConflictException(
      `Invalid order transition: ${fromStatus} -> ${toStatus}`,
    );
  }
}

/**
 * Asserts that the requesting user owns the order or is an admin.
 *
 * @param order - Order carrying the owner id.
 * @param requestingUserId - JWT sub of the caller.
 * @param callerRole - Caller role for the admin bypass.
 * @throws ForbiddenException if the caller is neither owner nor admin.
 */
export function assertOrderOwner(
  order: Pick<Order, 'userId'>,
  requestingUserId: string,
  callerRole?: UserRoles,
): void {
  // Owner-scoped reads/writes; admins bypass for support and operations.
  if (order.userId !== requestingUserId && callerRole !== UserRoles.Admin) {
    throw new ForbiddenException('You are not allowed to access this order');
  }
}

/**
 * Maps a PostgreSQL CHECK-violation during inventory mutation to 409.
 * Any other error propagates untouched so genuine failures stay visible.
 *
 * @param mutationError - Caught error from the inventory save.
 * @param contextMessage - Human context prefixed to the 409 message.
 * @throws ConflictException on CHECK/23514 violations; rethrows otherwise.
 */
export function mapInventoryCheckViolation(
  mutationError: unknown,
  contextMessage: string,
): never {
  const errorMessage =
    mutationError instanceof Error ? mutationError.message : '';
  const errorCode =
    mutationError instanceof QueryFailedError
      ? (mutationError.driverError as { code?: string } | undefined)?.code
      : (mutationError as { code?: string } | null)?.code;
  // DB CHECK backstop (stock >= 0, reserved bounds) surfaces as 409, never 500.
  if (
    errorCode === '23514' ||
    errorMessage.includes('CHK_') ||
    errorMessage.includes('check constraint') ||
    errorMessage.includes('violates check')
  ) {
    throw new ConflictException(`${contextMessage}: ${errorMessage}`);
  }
  throw mutationError;
}
