/**
 * This service is responsible for order cancellation domain.
 * It handles atomic PENDING→CANCELLED|FAILED with reservation release and
 * a durable order.cancelled record in the same transaction.
 *
 * Responsibility (SRP): cancel orchestration only (lock → release → record).
 * Used by: OrderController (user cancel), future payment-failure path.
 * Depends on: OutboxService (record insert, required), CACHE_MANAGER
 * (idempotency metric, fail-open observability only).
 */
import {
  Inject,
  Injectable,
  Logger,
  NotFoundException,
  Optional,
} from '@nestjs/common';
import { CACHE_MANAGER } from '@nestjs/cache-manager';
import type { Cache } from 'cache-manager';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource, EntityManager, In } from 'typeorm';
import { Order } from './entities/order.entity';
import { OrderStatus } from './order-status.enum';
import { Reservation } from '../reservation/entities/reservation.entity';
import { ReservationStatus } from '../reservation/entities/reservation-status.enum';
import { Inventory } from '../inventory/entities/inventory.entity';
import { UserRoles } from '../users/enum/roles';
import { OutboxService } from '../outbox/outbox.service';
import { randomUUID } from 'crypto';
import { assertOrderOwner, validateOrderTransition } from './order-transitions';

/** Reason a cancellation closes an order (user, payment failure, expiry). */
export type OrderCancelReason = 'user' | 'failed' | 'expired';

/** Enriched result of a cancellation (D10: avoids a second lookup). */
export interface CancelOrderResult {
  order: Order;
  reservationId: string | null;
  reason: OrderCancelReason;
}

/**
 * This service is responsible for order cancellation domain.
 * It handles atomic PENDING→CANCELLED|FAILED with Reservation release and outbox.
 */
@Injectable()
export class OrderCancellationService {
  private readonly logger = new Logger(OrderCancellationService.name);

  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    private readonly outboxService: OutboxService,
    @Optional()
    @Inject(CACHE_MANAGER)
    private readonly cacheManager?: Cache,
  ) {}

  /**
   * Increments the idempotent-skip metric for cancel (fail-open).
   * Absence of cache only drops the metric; business flow never depends on it.
   *
   * @returns Void.
   */
  private async incrementIdempotentSkipCounter(): Promise<void> {
    const counterKey = 'idempotency:duplicate:skipped:cancel';
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
   * Cancels a pending order, owning the transaction boundary (TI-3).
   * Controllers call this (never DataSource); composed flows (payment
   * failure) use cancelOrderWithManager inside their own transaction.
   *
   * @param orderId - Order id to cancel.
   * @param reason - Cancellation reason (user|failed|expired).
   * @param requestingUserId - Owner check (asserted).
   * @param role - Optional role for admin bypass.
   * @param correlationId - Tracing correlationId.
   * @returns Cancelled order with reservation link and reason.
   * @throws NotFoundException if order/reservation missing.
   * @throws ForbiddenException if not owner.
   * @throws ConflictException if invalid transition.
   */
  async cancelOrder(
    orderId: string,
    reason: OrderCancelReason,
    requestingUserId: string,
    role?: UserRoles,
    correlationId?: string,
  ): Promise<CancelOrderResult> {
    return this.dataSource.transaction((manager) =>
      this.cancelOrderWithManager(
        manager,
        orderId,
        reason,
        correlationId,
        requestingUserId,
        role,
      ),
    );
  }

  /**
   * Cancels a pending order inside the caller's transaction.
   * A failed order.cancelled record insert propagates so the caller rolls back
   * (Q2/A: a committed cancel is never silent to downstream consumers).
   *
   * @param manager - EntityManager of the enclosing transaction (caller owns commit/rollback).
   * @param orderId - Order id to cancel.
   * @param reason - Cancellation reason (user|failed|expired).
   * @param correlationId - Tracing correlationId.
   * @param requestingUserId - Optional owner check (if provided, assert).
   * @param role - Optional role for admin bypass.
   * @returns Cancelled order with reservation link and reason.
   * @throws NotFoundException if order/reservation missing.
   * @throws ForbiddenException if not owner.
   * @throws ConflictException if invalid transition.
   */
  async cancelOrderWithManager(
    manager: EntityManager,
    orderId: string,
    reason: OrderCancelReason,
    correlationId?: string,
    requestingUserId?: string,
    role?: UserRoles,
  ): Promise<CancelOrderResult> {
    const effectiveCorrelationId = correlationId || randomUUID();

    this.logger.debug(`order cancel start id=${orderId} reason=${reason}`);
    // 1. Lock Order FOR UPDATE (serializes cancel vs complete vs expire races).
    const orderRepository = manager.getRepository(Order);
    const lockedOrder = await orderRepository.findOne({
      where: { id: orderId },
      lock: { mode: 'pessimistic_write' },
    });
    if (!lockedOrder) {
      throw new NotFoundException(`Order ${orderId} not found`);
    }

    if (requestingUserId) {
      assertOrderOwner(lockedOrder, requestingUserId, role);
    }

    // Idempotent guard before any inventory lock: already-terminal orders
    // return with zero delta and no new outbox row.
    if (
      lockedOrder.status === OrderStatus.CANCELLED ||
      lockedOrder.status === OrderStatus.FAILED
    ) {
      this.logger.log(
        `Idempotent cancel for order ${orderId} already ${lockedOrder.status}`,
      );
      await this.incrementIdempotentSkipCounter();
      const existingReservation = await manager
        .getRepository(Reservation)
        .findOne({ where: { orderId } });
      return {
        order: lockedOrder,
        reservationId: existingReservation?.id ?? null,
        reason,
      };
    }

    // Cancellation never completes an order: the target is derived from the
    // reason (FAILED for payment failure, CANCELLED otherwise), so COMPLETED
    // is unreachable by construction (the type system proves it).
    const targetStatus =
      reason === 'failed' ? OrderStatus.FAILED : OrderStatus.CANCELLED;
    validateOrderTransition(lockedOrder.status, targetStatus);

    // 2. Lock the reservation row WITHOUT relations: FOR UPDATE cannot be
    // applied to the nullable side of the outer join that relations would
    // add (same pattern as ReservationService transitions).
    this.logger.debug(`order cancel lock reservation orderId=${orderId}`);
    const reservationRepository = manager.getRepository(Reservation);
    const lockedReservation = await reservationRepository.findOne({
      where: { orderId },
      lock: { mode: 'pessimistic_write' },
    });

    // 3. Release reservedAmount if Reservation still RESERVED. The lock is
    // held for the transaction duration, so reload items under the same lock.
    let linkedReservationId: string | null = null;
    if (
      lockedReservation &&
      lockedReservation.status === ReservationStatus.RESERVED
    ) {
      linkedReservationId = lockedReservation.id;
      const reservationWithItems = await reservationRepository.findOne({
        where: { id: lockedReservation.id },
        relations: { items: true },
      });
      const reservationItems = reservationWithItems?.items ?? [];
      if (reservationItems.length > 0) {
        // Deterministic lock ordering prevents deadlocks on multi-line orders.
        const sortedInventoryIds = [
          ...new Set(
            reservationItems.map(
              (reservationItem) => reservationItem.inventoryId,
            ),
          ),
        ].sort();
        this.logger.debug(
          `order cancel lock inventories orderId=${orderId} count=${sortedInventoryIds.length}`,
        );
        const lockedInventories = await manager.find(Inventory, {
          where: { id: In(sortedInventoryIds) },
          lock: { mode: 'pessimistic_write' },
        });
        const inventoryById = new Map(
          lockedInventories.map((inventoryRow) => [
            inventoryRow.id,
            inventoryRow,
          ]),
        );
        const inventoryRepository = manager.getRepository(Inventory);
        for (const reservationItem of reservationItems) {
          const lockedInventory = inventoryById.get(
            reservationItem.inventoryId,
          );
          if (!lockedInventory) {
            throw new NotFoundException(
              `Inventory ${reservationItem.inventoryId} not found`,
            );
          }
          // Pre-sale release only: reserved decreases, shelf stock unchanged.
          lockedInventory.reservedAmount -= reservationItem.quantity;
          await inventoryRepository.save(lockedInventory);
        }
      }
      lockedReservation.status = ReservationStatus.CANCELLED;
      await reservationRepository.save(lockedReservation);
    } else if (lockedReservation) {
      // Already terminal reservation — close the order without touching
      // inventory a second time (no double-release on retries/replays).
      linkedReservationId = lockedReservation.id;
      this.logger.warn(
        `Order ${orderId} cancel: reservation ${lockedReservation.id} already ${lockedReservation.status}, skip inventory release`,
      );
    }

    // 4. OutboxEvent INSERT inside same transaction — OutboxService owns envelope.
    // No try/catch: a record failure must roll back the cancel (Q2/A, TI-4).
    this.logger.debug(`order cancel record order.cancelled orderId=${orderId}`);
    await this.outboxService.createEvent(manager, {
      eventType: 'order.cancelled',
      aggregateType: 'Order',
      aggregateId: orderId,
      correlationId: effectiveCorrelationId,
      data: {
        orderId,
        userId: lockedOrder.userId,
        previousStatus: 'PENDING',
        newStatus: targetStatus,
        reason,
        reservationId: linkedReservationId,
      },
    });

    // 5. Update Order status.
    lockedOrder.status = targetStatus;
    const savedOrder = await orderRepository.save(lockedOrder);

    this.logger.log(
      `Order ${orderId} PENDING → ${targetStatus} (reason=${reason}) via outbox correlationId=${effectiveCorrelationId}`,
    );

    return { order: savedOrder, reservationId: linkedReservationId, reason };
  }
}
