import {
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
  Optional,
} from '@nestjs/common';
import { EntityManager, In } from 'typeorm';
import { Order } from './entities/order.entity';
import { OrderStatus } from './order-status.enum';
import { Reservation } from '../reservation/entities/reservation.entity';
import { ReservationStatus } from '../reservation/entities/reservation-status.enum';
import { Inventory } from '../inventory/entities/inventory.entity';
import { UserRoles } from '../users/enum/roles';
import { OutboxService } from '../outbox/outbox.service';
import { randomUUID } from 'crypto';

/**
 * This service is responsible for order cancellation domain.
 * It handles atomic PENDING→CANCELLED|FAILED with Reservation release and outbox.
 */
@Injectable()
export class OrderCancellationService {
  private readonly logger = new Logger(OrderCancellationService.name);

  constructor(
    @Optional()
    @Inject(OutboxService)
    private readonly outboxService?: OutboxService,
  ) {}

  /**
   * Validates order cancellation transition.
   * @param from - Current status.
   * @param to - Target status.
   * @throws ConflictException if invalid.
   */
  private validateTransition(from: OrderStatus, to: OrderStatus): void {
    // Only PENDING can go to CANCELLED or FAILED
    if (from !== OrderStatus.PENDING) {
      throw new ConflictException(`Invalid order transition: ${from} -> ${to}`);
    }
    if (to !== OrderStatus.CANCELLED && to !== OrderStatus.FAILED) {
      throw new ConflictException(`Invalid cancellation target: ${to}`);
    }
  }

  /**
   * Asserts owner or admin.
   * @param order - Order entity.
   * @param requestingUserId - JWT sub.
   * @param role - User role.
   * @throws ForbiddenException if not owner and not admin.
   */
  private assertOwner(
    order: Order,
    requestingUserId: string,
    role?: UserRoles,
  ): void {
    if (order.userId !== requestingUserId && role !== UserRoles.Admin) {
      throw new ForbiddenException('You are not allowed to access this order');
    }
  }

  /**
   * Cancels a pending order atomically with reservation release and outbox event.
   * @param manager - EntityManager of enclosing transaction.
   * @param orderId - Order id to cancel.
   * @param reason - Cancellation reason (user|failed|expired).
   * @param correlationId - Tracing correlationId.
   * @param requestingUserId - Optional owner check (if provided, assert).
   * @param role - Optional role for admin bypass.
   * @returns Cancelled order.
   * @throws NotFoundException if order/reservation missing.
   * @throws ForbiddenException if not owner.
   * @throws ConflictException if invalid transition.
   */
  async cancel(
    manager: EntityManager,
    orderId: string,
    reason: 'user' | 'failed' | 'expired',
    correlationId?: string,
    requestingUserId?: string,
    role?: UserRoles,
  ): Promise<Order> {
    const corrId = correlationId || randomUUID();

    // 1. Lock Order FOR UPDATE
    const orderRepo = manager.getRepository(Order);
    const order = await orderRepo.findOne({
      where: { id: orderId },
      lock: { mode: 'pessimistic_write' } as any,
    });
    if (!order) {
      throw new NotFoundException(`Order ${orderId} not found`);
    }

    if (requestingUserId) {
      this.assertOwner(order, requestingUserId, role);
    }

    // If already terminal, idempotent guard — no duplicate outbox
    if (
      order.status === OrderStatus.CANCELLED ||
      order.status === OrderStatus.FAILED
    ) {
      this.logger.log(
        `Idempotent cancel for order ${orderId} already ${order.status}`,
      );
      return order;
    }
    if (order.status === OrderStatus.COMPLETED) {
      throw new ConflictException(
        `Invalid order transition: ${order.status} -> CANCELLED`,
      );
    }

    const targetStatus =
      reason === 'failed' ? OrderStatus.FAILED : OrderStatus.CANCELLED;
    this.validateTransition(order.status, targetStatus);

    // 2. Find Reservation by orderId if exists
    const reservationRepo = manager.getRepository(Reservation);
    const reservation = await reservationRepo.findOne({
      where: { orderId },
      relations: { items: true },
      lock: { mode: 'pessimistic_write' } as any,
    });

    // 3. Release reservedAmount if Reservation still RESERVED
    if (reservation && reservation.status === ReservationStatus.RESERVED) {
      if (reservation.items && reservation.items.length > 0) {
        const sortedIds = [
          ...new Set(reservation.items.map((i) => i.inventoryId)),
        ].sort();
        const inventories = await manager.find(Inventory, {
          where: { id: In(sortedIds) },
          lock: { mode: 'pessimistic_write' },
        });
        const inventoryMap = new Map(inventories.map((inv) => [inv.id, inv]));
        for (const item of reservation.items) {
          const inv = inventoryMap.get(item.inventoryId);
          if (!inv)
            throw new NotFoundException(
              `Inventory ${item.inventoryId} not found`,
            );
          // V1 release reserved only — stock unchanged per spec FR-005
          inv.reservedAmount -= item.quantity;
          await manager.getRepository(Inventory).save(inv);
        }
      }
      reservation.status = ReservationStatus.CANCELLED;
      await reservationRepo.save(reservation);
    } else if (
      reservation &&
      reservation.status !== ReservationStatus.RESERVED
    ) {
      // Already terminal reservation — do not touch inventory, still allow order cancel
      this.logger.warn(
        `Order ${orderId} cancel: reservation ${reservation.id} already ${reservation.status}, skip inventory release`,
      );
    }

    // 4. OutboxEvent INSERT inside same transaction — no client.emit
    if (this.outboxService) {
      try {
        await this.outboxService.createEvent(manager, {
          eventType: 'order.cancelled',
          aggregateType: 'Order',
          aggregateId: orderId,
          payload: {
            version: 1,
            eventType: 'order.cancelled',
            correlationId: corrId,
            orderId,
            userId: order.userId,
            previousStatus: 'PENDING',
            newStatus: targetStatus,
            reason,
            reservationId: reservation?.id ?? null,
          },
          correlationId: corrId,
        });
      } catch (e: any) {
        this.logger.warn(
          `outbox order.cancelled insert failed for ${orderId}: ${e?.message}`,
        );
      }
    }

    // 5. Update Order status
    order.status = targetStatus;
    const saved = await orderRepo.save(order);

    this.logger.log(
      `Order ${orderId} PENDING → ${targetStatus} (reason=${reason}) via outbox correlationId=${corrId}`,
    );

    return saved;
  }
}
