import {
  Inject,
  Injectable,
  Logger,
  NotFoundException,
  Optional,
} from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource, EntityManager, In } from 'typeorm';
import { CACHE_MANAGER } from '@nestjs/cache-manager';
import type { Cache } from 'cache-manager';
import { Order } from './entities/order.entity';
import { OrderStatus } from './order-status.enum';
import { Reservation } from '../reservation/entities/reservation.entity';
import { ReservationStatus } from '../reservation/entities/reservation-status.enum';
import { Inventory } from '../inventory/entities/inventory.entity';
import { ReservationService } from '../reservation/reservation.service';
import { UserRoles } from '../users/enum/roles';
import { OutboxService } from '../outbox/outbox.service';
import { randomUUID } from 'crypto';
import {
  assertOrderOwner,
  mapInventoryCheckViolation,
  validateOrderTransition as validateSharedOrderTransition,
} from './order-transitions';
import { OrderItem } from './entities/order-items.entity';

/** Completed order enriched with its reservation link and items. */
export interface CompleteOrderResult {
  id: string;
  userId: string;
  status: OrderStatus;
  total: number;
  created_at: Date;
  updated_at: Date;
  orderItems: OrderItem[];
  reservationId: string | null;
  expiresAt: Date | null;
  reservation: Reservation | null;
}

/**
 * This service is responsible for order sale domain.
 * It handles atomic Order PENDING→COMPLETED sale with Reservation and Inventory and enforces idempotent guards.
 */
@Injectable()
export class OrderCompletionService {
  private readonly logger = new Logger(OrderCompletionService.name);

  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    private readonly reservationService: ReservationService,
    @Optional()
    @Inject(OutboxService)
    private readonly outboxService?: OutboxService,
    @Optional()
    @Inject(CACHE_MANAGER)
    private readonly cacheManager?: Cache,
  ) {}

  /**
   * Increments the idempotent-skip metric for complete (fail-open).
   * Uses only the typed cache-manager `Cache` API — never the underlying
   * store client internals. The get+set pair is not atomic under concurrency;
   * that is acceptable for an observability-only counter (fail-open, never
   * authoritative, a lost increment changes no business outcome).
   *
   * @returns Void.
   */
  private async incrementCompleteIdempotentSkipCounter(): Promise<void> {
    // Each idempotent COMPLETED→COMPLETED skip bumps this 24h counter.
    const counterKey = 'idempotency:duplicate:skipped:complete';
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
      // Fail-open: a metrics failure must never fail the business flow.
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
   * Validates an Order status transition (delegates to the shared table).
   * @param from - Current Order status.
   * @param to - Target Order status.
   * @throws ConflictException if transition is not allowed.
   */
  validateOrderTransition(from: OrderStatus, to: OrderStatus): void {
    validateSharedOrderTransition(from, to);
  }

  /**
   * Asserts that requesting user owns the order or is Admin.
   * @param order - Order to check.
   * @param requestingUserId - Current user id from JWT sub.
   * @param role - Current user role.
   * @throws ForbiddenException if not owner and not Admin.
   */
  assertOrderOwner(
    order: Order,
    requestingUserId: string,
    role?: UserRoles,
  ): void {
    assertOrderOwner(order, requestingUserId, role);
  }

  /**
   * Completes an order sale, owning the transaction boundary (TI-3).
   * Controllers call this (never DataSource).
   * @param requestingUserId - Current user id.
   * @param orderId - Order id to complete.
   * @param role - Current user role for admin bypass.
   * @param correlationId - Tracing correlationId.
   * @returns Completed Order enriched with reservationId and items.
   * @throws NotFoundException if order/reservation/inventory missing.
   * @throws ForbiddenException if not owner.
   * @throws ConflictException if invalid transition or DB CHECK violation (mapped to 409).
   */
  async completeOrder(
    requestingUserId: string,
    orderId: string,
    role?: UserRoles,
    correlationId?: string,
  ): Promise<CompleteOrderResult> {
    return this.dataSource.transaction((manager) =>
      this.completeOrderWithManager(
        manager,
        requestingUserId,
        orderId,
        role,
        correlationId,
      ),
    );
  }

  /**
   * Completes an order sale inside the caller's transaction.
   * Locks Order FOR UPDATE → assertOrderOwner → validateOrderTransition → locks Reservation FOR UPDATE → validates → locks sorted Inventories → stock-=qty reserved-=qty → saves Order+Reservation.
   * @param manager - EntityManager of the enclosing transaction (caller owns commit/rollback).
   * @param requestingUserId - Current user id.
   * @param orderId - Order id to complete.
   * @param role - Current user role for admin bypass.
   * @returns Completed Order enriched with reservationId and items.
   * @throws NotFoundException if order/reservation/inventory missing.
   * @throws ForbiddenException if not owner.
   * @throws ConflictException if invalid transition or DB CHECK violation (mapped to 409).
   */
  async completeOrderWithManager(
    manager: EntityManager,
    requestingUserId: string,
    orderId: string,
    role?: UserRoles,
    correlationId?: string,
  ): Promise<CompleteOrderResult> {
    const orderRepo = manager.getRepository(Order);

    // 1. Lock Order FOR UPDATE
    const order = await orderRepo.findOne({
      where: { id: orderId },
      lock: { mode: 'pessimistic_write' },
    });
    if (!order) {
      throw new NotFoundException(`Order ${orderId} not found`);
    }

    // Load with relations for response (lock already held)
    const orderWithItems = await orderRepo.findOne({
      where: { id: orderId },
      relations: { orderItems: { product: true } },
    });
    const currentOrder = orderWithItems ?? order;

    this.assertOrderOwner(currentOrder, requestingUserId, role);

    // Idempotent guard before FOR UPDATE Reservation/Inventories (spec Q2 A): COMPLETED→COMPLETED must not mutate inventory
    // 2. Idempotent COMPLETED→COMPLETED — no inventory re-mutation (spec D1)
    if (currentOrder.status === OrderStatus.COMPLETED) {
      // Order already COMPLETED → idempotent 200 with zero inventory delta (before any Reservation/Inventories lock)
      this.logger.log(
        `order complete idempotent skip id=${orderId} status=COMPLETED`,
      );
      // Also log legacy message for operator search
      this.logger.log(
        `Idempotent order complete for ${orderId} already COMPLETED — no inventory change`,
      );
      await this.incrementCompleteIdempotentSkipCounter();
      const idempotentReservationRepo = manager.getRepository(Reservation);
      const idempotentReservation = await idempotentReservationRepo.findOne({
        where: { orderId },
        relations: { items: true },
      });
      return {
        ...currentOrder,
        status: OrderStatus.COMPLETED,
        reservationId: idempotentReservation?.id ?? null,
        expiresAt: idempotentReservation?.expiresAt ?? null,
        reservation: idempotentReservation,
      };
    }

    // 3. Validate PENDING→COMPLETED
    this.validateOrderTransition(currentOrder.status, OrderStatus.COMPLETED);

    // 4. Lock Reservation FOR UPDATE by orderId (no outer join: FOR UPDATE
    // cannot be applied to the nullable side of a relations join).
    const reservationRepo = manager.getRepository(Reservation);
    const lockedReservation = await reservationRepo.findOne({
      where: { orderId },
      lock: { mode: 'pessimistic_write' },
    });
    if (!lockedReservation) {
      throw new NotFoundException(`Reservation for order ${orderId} not found`);
    }
    const reservation = await reservationRepo.findOne({
      where: { orderId },
      relations: { items: true },
    });
    if (!reservation) {
      throw new NotFoundException(`Reservation for order ${orderId} not found`);
    }

    // Idempotent at reservation level too (already COMPLETED)
    if (reservation.status === ReservationStatus.COMPLETED) {
      // Order was PENDING but Reservation already COMPLETED is data inconsistency
      // Still allow idempotent completion (no inventory) after Order saved
      this.logger.warn(
        `Order ${orderId} PENDING but Reservation ${reservation.id} already COMPLETED — idempotent`,
      );
    } else {
      this.reservationService.validateTransition(
        reservation.status,
        ReservationStatus.COMPLETED,
      );
    }

    // 5. No items? Still allow COMPLETED without inventory mutation (edge)
    if (!reservation.items || reservation.items.length === 0) {
      // OutboxEvent INSERT inside same transaction — OutboxService owns envelope (version, eventId, occurredAt, correlationId)
      const noItemsCorrelationId = correlationId || randomUUID();
      if (this.outboxService) {
        try {
          await this.outboxService.createEvent(manager, {
            eventType: 'order.completed',
            aggregateType: 'Order',
            aggregateId: orderId,
            correlationId: noItemsCorrelationId,
            data: {
              orderId,
              userId: currentOrder.userId,
              previousStatus: 'PENDING',
              newStatus: 'COMPLETED',
              reservationId: reservation.id,
              items: [],
              completedAt: new Date().toISOString(),
            },
          });
        } catch (outboxError: unknown) {
          const errorMessage =
            outboxError instanceof Error
              ? outboxError.message
              : String(outboxError);
          this.logger.warn(
            `outbox order.completed insert failed for ${orderId}: ${errorMessage}`,
          );
        }
      }
      currentOrder.status = OrderStatus.COMPLETED;
      reservation.status = ReservationStatus.COMPLETED;
      const savedOrder = await orderRepo.save(currentOrder);
      const savedReservation = await reservationRepo.save(reservation);
      this.logger.log(
        `Order ${orderId} PENDING → COMPLETED (no items) via reservation ${reservation.id}`,
      );
      return {
        ...savedOrder,
        reservationId: savedReservation.id,
        expiresAt: savedReservation.expiresAt,
        reservation: savedReservation,
        orderItems: currentOrder.orderItems,
      };
    }

    // 6. Deterministic lock ordering
    const sortedInventoryIds = [
      ...new Set(
        reservation.items.map((reservationItem) => reservationItem.inventoryId),
      ),
    ].sort();

    // 7. Lock Inventories FOR UPDATE
    let lockedInventories: Inventory[] = [];
    if (sortedInventoryIds.length > 0) {
      lockedInventories = await manager.find(Inventory, {
        where: { id: In(sortedInventoryIds) },
        lock: { mode: 'pessimistic_write' },
      });
      if (lockedInventories.length !== sortedInventoryIds.length) {
        const foundInventoryIds = new Set(
          lockedInventories.map((inventoryRow) => inventoryRow.id),
        );
        const missingInventoryId = sortedInventoryIds.find(
          (inventoryId) => !foundInventoryIds.has(inventoryId),
        );
        throw new NotFoundException(
          `Inventory ${missingInventoryId} not found`,
        );
      }
    }
    const inventoryById = new Map(
      lockedInventories.map((inventoryRow) => [inventoryRow.id, inventoryRow]),
    );

    // 8. Mutate per item: stock-=qty reserved-=qty
    const inventoryRepository = manager.getRepository(Inventory);
    try {
      for (const reservationItem of reservation.items) {
        const lockedInventory = inventoryById.get(reservationItem.inventoryId);
        if (!lockedInventory) {
          throw new NotFoundException(
            `Inventory ${reservationItem.inventoryId} not found`,
          );
        }
        // DB CHECK backstop (spec D3) → 409, no explicit available check
        lockedInventory.stock -= reservationItem.quantity;
        lockedInventory.reservedAmount -= reservationItem.quantity;
        await inventoryRepository.save(lockedInventory);
      }
    } catch (inventoryError: unknown) {
      mapInventoryCheckViolation(
        inventoryError,
        `Inventory invariant violation on order complete ${orderId}`,
      );
    }

    // 9. OutboxEvent INSERT inside same transaction — OutboxService owns envelope
    const effectiveCorrelationId = correlationId || randomUUID();
    if (this.outboxService) {
      try {
        await this.outboxService.createEvent(manager, {
          eventType: 'order.completed',
          aggregateType: 'Order',
          aggregateId: orderId,
          correlationId: effectiveCorrelationId,
          data: {
            orderId,
            userId: currentOrder.userId,
            previousStatus: 'PENDING',
            newStatus: 'COMPLETED',
            reservationId: reservation.id,
            items: reservation.items.map((reservationItem) => ({
              inventoryId: reservationItem.inventoryId,
              quantity: reservationItem.quantity,
            })),
            completedAt: new Date().toISOString(),
          },
        });
      } catch (outboxError: unknown) {
        const errorMessage =
          outboxError instanceof Error
            ? outboxError.message
            : String(outboxError);
        this.logger.warn(
          `outbox order.completed insert failed for ${orderId}: ${errorMessage}`,
        );
      }
    }

    // 10. Save Order COMPLETED + Reservation COMPLETED
    currentOrder.status = OrderStatus.COMPLETED;
    if (reservation.status !== ReservationStatus.COMPLETED) {
      reservation.status = ReservationStatus.COMPLETED;
    }
    const savedOrder = await orderRepo.save(currentOrder);
    const savedReservation = await reservationRepo.save(reservation);

    this.logger.log(
      `Order ${orderId} PENDING → COMPLETED via reservation ${reservation.id} (stock bulk −${reservation.items.reduce((runningTotal, reservationItem) => runningTotal + reservationItem.quantity, 0)})`,
    );

    // Reload enriched for response
    const fullOrder = await orderRepo.findOne({
      where: { id: savedOrder.id },
      relations: { orderItems: { product: true } },
    });

    return {
      ...(fullOrder ?? savedOrder),
      reservationId: savedReservation.id,
      expiresAt: savedReservation.expiresAt,
      reservation: savedReservation,
    };
  }
}
