import {
  ConflictException,
  ForbiddenException,
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

/**
 * Allowed Order status transitions for sale.
 * COMPLETED→COMPLETED is idempotent and short-circuited before validation.
 */
const ALLOWED_ORDER_TRANSITIONS: Record<OrderStatus, OrderStatus[]> = {
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
    private readonly cache?: Cache,
  ) {}

  /**
   * Increments idempotency duplicate skipped counter for order complete (fail-open).
   * @returns Void.
   */
  private async incrementCounter(): Promise<void> {
    // Each idempotent COMPLETED→COMPLETED skip increments INCR idempotency:duplicate:skipped:complete EX 86400
    const key = 'idempotency:duplicate:skipped:complete';
    try {
      if (!this.cache) return;
      const anyCache: any = this.cache as any;
      const store: any = anyCache.store ?? anyCache.stores?.[0];
      const client =
        store?.client ?? store?.store?.client ?? anyCache.client ?? null;
      if (client && typeof client.incr === 'function') {
        await client.incr(key);
        // Ensure 24h expiry (86400s) per Q5 B
        if (typeof client.expire === 'function') {
          await client.expire(key, 86400);
        } else if (typeof client.pexpire === 'function') {
          await client.pexpire(key, 86400000);
        }
        return;
      }
      // Fallback to cache-manager get/set
      const current = (await this.cache.get<number>(key)) ?? 0;
      await this.cache.set(key, current + 1, 86400000);
    } catch (e: any) {
      // Fail-open: log warn but do not throw on counter failure
      this.logger.warn(
        `Redis fail-open for idempotency counter ${key}: ${e?.message}`,
      );
    }
  }

  /**
   * Validates an Order status transition.
   * @param from - Current Order status.
   * @param to - Target Order status.
   * @throws ConflictException if transition is not allowed.
   */
  validateOrderTransition(from: OrderStatus, to: OrderStatus): void {
    if (from === OrderStatus.COMPLETED && to === OrderStatus.COMPLETED) {
      return;
    }
    const allowed = ALLOWED_ORDER_TRANSITIONS[from] ?? [];
    if (!allowed.includes(to)) {
      throw new ConflictException(`Invalid order transition: ${from} -> ${to}`);
    }
  }

  /**
   * Asserts that requesting user owns the order or is Admin.
   * @param order - Order to check.
   * @param requestingUserId - Current user id from JWT sub.
   * @param role - Current user role.
   * @throws ForbiddenException if not owner and not Admin.
   */
  assertOwner(order: Order, requestingUserId: string, role?: UserRoles): void {
    // Owner-scoped (User) vs Admin bypass per spec FR-008
    if (order.userId !== requestingUserId && role !== UserRoles.Admin) {
      throw new ForbiddenException('You are not allowed to access this order');
    }
  }

  /**
   * Completes an order sale atomically.
   * Locks Order FOR UPDATE → assertOwner → validateOrderTransition → locks Reservation FOR UPDATE → validates → locks sorted Inventories → stock-=qty reserved-=qty → saves Order+Reservation.
   * @param manager - EntityManager of the enclosing transaction (caller owns commit/rollback).
   * @param requestingUserId - Current user id.
   * @param orderId - Order id to complete.
   * @param role - Current user role for admin bypass.
   * @returns Completed Order enriched with reservationId and items.
   * @throws NotFoundException if order/reservation/inventory missing.
   * @throws ForbiddenException if not owner.
   * @throws ConflictException if invalid transition or DB CHECK violation (mapped to 409).
   */
  async complete(
    manager: EntityManager,
    requestingUserId: string,
    orderId: string,
    role?: UserRoles,
    correlationId?: string,
  ): Promise<any> {
    const orderRepo = manager.getRepository(Order);

    // 1. Lock Order FOR UPDATE
    const order = await orderRepo.findOne({
      where: { id: orderId },
      lock: { mode: 'pessimistic_write' },
    } as any);
    if (!order) {
      throw new NotFoundException(`Order ${orderId} not found`);
    }

    // Load with relations for response (lock already held)
    const orderWithItems = await orderRepo.findOne({
      where: { id: orderId },
      relations: { orderItems: { product: true } },
    });
    const currentOrder = orderWithItems ?? order;

    this.assertOwner(currentOrder, requestingUserId, role);

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
      await this.incrementCounter();
      const reservationRepoIdem = manager.getRepository(Reservation);
      const resIdem = await reservationRepoIdem.findOne({
        where: { orderId },
        relations: { items: true },
      });
      return {
        ...currentOrder,
        status: OrderStatus.COMPLETED,
        reservationId: resIdem?.id ?? null,
        expiresAt: resIdem?.expiresAt ?? null,
        reservation: resIdem,
      };
    }

    // 3. Validate PENDING→COMPLETED
    this.validateOrderTransition(currentOrder.status, OrderStatus.COMPLETED);

    // 4. Lock Reservation FOR UPDATE by orderId (no outer join)
    const reservationRepo = manager.getRepository(Reservation);
    const lockedReservation = await reservationRepo.findOne({
      where: { orderId },
      lock: { mode: 'pessimistic_write' },
    } as any);
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
      const corrIdNoItems = correlationId || randomUUID();
      if (this.outboxService) {
        try {
          await this.outboxService.createEvent(manager, {
            eventType: 'order.completed',
            aggregateType: 'Order',
            aggregateId: orderId,
            correlationId: corrIdNoItems,
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
        } catch (e: any) {
          this.logger.warn(
            `outbox order.completed insert failed for ${orderId}: ${e?.message}`,
          );
        }
      }
      currentOrder.status = OrderStatus.COMPLETED;
      reservation.status = ReservationStatus.COMPLETED;
      const savedOrder = await orderRepo.save(currentOrder);
      const savedRes = await reservationRepo.save(reservation);
      this.logger.log(
        `Order ${orderId} PENDING → COMPLETED (no items) via reservation ${reservation.id}`,
      );
      return {
        ...savedOrder,
        reservationId: savedRes.id,
        expiresAt: savedRes.expiresAt,
        reservation: savedRes,
        orderItems: (savedOrder as any).orderItems ?? currentOrder.orderItems,
      };
    }

    // 6. Deterministic lock ordering
    const sortedIds = [
      ...new Set(reservation.items.map((i) => i.inventoryId)),
    ].sort();

    // 7. Lock Inventories FOR UPDATE
    let lockedInventories: Inventory[] = [];
    if (sortedIds.length > 0) {
      lockedInventories = await manager.find(Inventory, {
        where: { id: In(sortedIds) },
        lock: { mode: 'pessimistic_write' },
      });
      if (lockedInventories.length !== sortedIds.length) {
        const foundIds = new Set(lockedInventories.map((r) => r.id));
        const missing = sortedIds.find((mid) => !foundIds.has(mid))!;
        throw new NotFoundException(`Inventory ${missing} not found`);
      }
    }
    const inventoryMap = new Map(lockedInventories.map((inv) => [inv.id, inv]));

    // 8. Mutate per item: stock-=qty reserved-=qty
    const inventoryRepo = manager.getRepository(Inventory);
    try {
      for (const item of reservation.items) {
        const inv = inventoryMap.get(item.inventoryId)!;
        // DB CHECK backstop (spec D3) → 409, no explicit available check
        inv.stock -= item.quantity;
        inv.reservedAmount -= item.quantity;
        await inventoryRepo.save(inv);
      }
    } catch (e: any) {
      const msg = e?.message ?? '';
      // DB CHECK backstop (spec D3) → 409
      if (
        msg.includes('CHK_') ||
        msg.includes('check constraint') ||
        msg.includes('violates check') ||
        e?.code === '23514'
      ) {
        throw new ConflictException(
          `Inventory invariant violation on order complete ${orderId}: ${msg}`,
        );
      }
      throw e;
    }

    // 9. OutboxEvent INSERT inside same transaction — OutboxService owns envelope
    const corrId = correlationId || randomUUID();
    if (this.outboxService) {
      try {
        await this.outboxService.createEvent(manager, {
          eventType: 'order.completed',
          aggregateType: 'Order',
          aggregateId: orderId,
          correlationId: corrId,
          data: {
            orderId,
            userId: currentOrder.userId,
            previousStatus: 'PENDING',
            newStatus: 'COMPLETED',
            reservationId: reservation.id,
            items: reservation.items.map((i) => ({
              inventoryId: i.inventoryId,
              quantity: i.quantity,
            })),
            completedAt: new Date().toISOString(),
          },
        });
      } catch (e: any) {
        this.logger.warn(
          `outbox order.completed insert failed for ${orderId}: ${e?.message}`,
        );
      }
    }

    // 10. Save Order COMPLETED + Reservation COMPLETED
    currentOrder.status = OrderStatus.COMPLETED;
    if (reservation.status !== ReservationStatus.COMPLETED) {
      reservation.status = ReservationStatus.COMPLETED;
    }
    const savedOrder = await orderRepo.save(currentOrder);
    const savedRes = await reservationRepo.save(reservation);

    this.logger.log(
      `Order ${orderId} PENDING → COMPLETED via reservation ${reservation.id} (stock bulk −${reservation.items.reduce((s, i) => s + i.quantity, 0)})`,
    );

    // Reload enriched for response
    const fullOrder = await orderRepo.findOne({
      where: { id: savedOrder.id },
      relations: { orderItems: { product: true } },
    });

    return {
      ...(fullOrder ?? savedOrder),
      reservationId: savedRes.id,
      expiresAt: savedRes.expiresAt,
      reservation: savedRes,
    };
  }
}
