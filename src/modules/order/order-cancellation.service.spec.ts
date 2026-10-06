/**
 * This spec verifies the order cancellation matrix (mocked EntityManager).
 * It covers pre-sale release, failed-path disposition, idempotency, guards,
 * and the Q2/A rollback on outbox record failure.
 * Used by: Phase 8 US1 (T006); implementation lands in T009.
 */
import { ConflictException, ForbiddenException } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { DataSource } from 'typeorm';
import { OrderCancellationService } from './order-cancellation.service';
import { OrderStatus } from './order-status.enum';
import { ReservationStatus } from '../reservation/entities/reservation-status.enum';
import { Order } from './entities/order.entity';
import { Reservation } from '../reservation/entities/reservation.entity';
import { Inventory } from '../inventory/entities/inventory.entity';
import { OutboxService } from '../outbox/outbox.service';
import { UserRoles } from '../users/enum/roles';
import {
  UnitRepositoryStub,
  createUnitManagerStub,
  createUnitRepositoryStub,
} from './test/cancel-fixtures';

/** Mutable held-inventory row the stubbed save echoes back. */
interface HeldInventoryRow {
  id: string;
  stock: number;
  reservedAmount: number;
}

/** Assembled stubs for one cancel unit test. */
interface CancelUnitStubs {
  orderRepositoryStub: UnitRepositoryStub;
  reservationRepositoryStub: UnitRepositoryStub;
  inventoryRepositoryStub: UnitRepositoryStub;
  outboxServiceStub: { createEvent: jest.Mock };
  cancellationService: OrderCancellationService;
}

/** Creates the service with stubbed collaborators. */
async function createCancelUnitStubs(): Promise<CancelUnitStubs> {
  const orderRepositoryStub = createUnitRepositoryStub();
  const reservationRepositoryStub = createUnitRepositoryStub();
  const inventoryRepositoryStub = createUnitRepositoryStub();
  const outboxServiceStub = { createEvent: jest.fn() };
  const module: TestingModule = await Test.createTestingModule({
    providers: [
      OrderCancellationService,
      { provide: DataSource, useValue: {} },
      { provide: OutboxService, useValue: outboxServiceStub },
    ],
  }).compile();
  return {
    orderRepositoryStub,
    reservationRepositoryStub,
    inventoryRepositoryStub,
    outboxServiceStub,
    cancellationService: module.get<OrderCancellationService>(
      OrderCancellationService,
    ),
  };
}

/** Builds a PENDING order row owned by the given user. */
function buildPendingOrder(orderOwnerId: string): Order {
  return {
    id: 'order-cancel-unit-1',
    userId: orderOwnerId,
    status: OrderStatus.PENDING,
    total: 200,
  } as Order;
}

/** Builds a RESERVED reservation row holding two units. */
function buildReservedReservation(): Reservation {
  return {
    id: 'reservation-cancel-unit-1',
    status: ReservationStatus.RESERVED,
    orderId: 'order-cancel-unit-1',
    items: [{ inventoryId: 'inventory-cancel-unit-1', quantity: 2 }],
  } as unknown as Reservation;
}

/** Builds the held inventory row (stock 10, reserved 2). */
function buildHeldInventoryRow(): HeldInventoryRow {
  return { id: 'inventory-cancel-unit-1', stock: 10, reservedAmount: 2 };
}

describe('OrderCancellationService', () => {
  it('should be defined', async () => {
    const { cancellationService } = await createCancelUnitStubs();
    expect(cancellationService).toBeDefined();
  });

  it('should release the hold on PENDING user cancel with stock unchanged', async () => {
    const stubs = await createCancelUnitStubs();
    const pendingOrder = buildPendingOrder('user-cancel-1');
    const heldInventoryRow = buildHeldInventoryRow();
    stubs.orderRepositoryStub.findOne.mockResolvedValue(pendingOrder);
    stubs.reservationRepositoryStub.findOne.mockResolvedValue(
      buildReservedReservation(),
    );
    const { manager } = createUnitManagerStub(
      {
        [Order.name]: stubs.orderRepositoryStub,
        [Reservation.name]: stubs.reservationRepositoryStub,
        [Inventory.name]: stubs.inventoryRepositoryStub,
      },
      [heldInventoryRow],
    );

    const cancelOrderResult =
      await stubs.cancellationService.cancelOrderWithManager(
        manager,
        'order-cancel-unit-1',
        'user',
        'correlation-unit-1',
        'user-cancel-1',
        UserRoles.User,
      );

    // Hold released, shelf stock untouched.
    expect(heldInventoryRow.reservedAmount).toBe(0);
    expect(heldInventoryRow.stock).toBe(10);
    // Enriched D10 contract.
    expect(cancelOrderResult.order.status).toBe(OrderStatus.CANCELLED);
    expect(cancelOrderResult.reservationId).toBe('reservation-cancel-unit-1');
    expect(cancelOrderResult.reason).toBe('user');
    // Outbox record carries the cancel envelope.
    expect(stubs.outboxServiceStub.createEvent).toHaveBeenCalledWith(
      manager,
      expect.objectContaining({
        eventType: 'order.cancelled',
        aggregateId: 'order-cancel-unit-1',
        correlationId: 'correlation-unit-1',
      }),
    );
  });

  it('should close FAILED with released hold on payment-failure reason', async () => {
    const stubs = await createCancelUnitStubs();
    const pendingOrder = buildPendingOrder('user-cancel-2');
    const heldInventoryRow = buildHeldInventoryRow();
    stubs.orderRepositoryStub.findOne.mockResolvedValue(pendingOrder);
    stubs.reservationRepositoryStub.findOne.mockResolvedValue(
      buildReservedReservation(),
    );
    const { manager } = createUnitManagerStub(
      {
        [Order.name]: stubs.orderRepositoryStub,
        [Reservation.name]: stubs.reservationRepositoryStub,
        [Inventory.name]: stubs.inventoryRepositoryStub,
      },
      [heldInventoryRow],
    );

    const failedOrderResult =
      await stubs.cancellationService.cancelOrderWithManager(
        manager,
        'order-cancel-unit-1',
        'failed',
        'correlation-unit-2',
        'user-cancel-2',
        UserRoles.User,
      );

    expect(failedOrderResult.order.status).toBe(OrderStatus.FAILED);
    expect(failedOrderResult.reason).toBe('failed');
    // Same inventory release as a shopper cancel (D3).
    expect(heldInventoryRow.reservedAmount).toBe(0);
    expect(heldInventoryRow.stock).toBe(10);
  });

  it('should return idempotent 200 with zero inventory delta on re-cancel', async () => {
    const stubs = await createCancelUnitStubs();
    const alreadyCancelledOrder = buildPendingOrder('user-cancel-3');
    alreadyCancelledOrder.status = OrderStatus.CANCELLED;
    stubs.orderRepositoryStub.findOne.mockResolvedValue(alreadyCancelledOrder);
    const { find, manager } = createUnitManagerStub({
      [Order.name]: stubs.orderRepositoryStub,
      [Reservation.name]: stubs.reservationRepositoryStub,
      [Inventory.name]: stubs.inventoryRepositoryStub,
    });

    const idempotentResult =
      await stubs.cancellationService.cancelOrderWithManager(
        manager,
        'order-cancel-unit-1',
        'user',
        'correlation-unit-3',
        'user-cancel-3',
        UserRoles.User,
      );

    expect(idempotentResult.order.status).toBe(OrderStatus.CANCELLED);
    // One indexed reservation lookup for FR-012 traceability, but no
    // inventory lock, no saves, and no new outbox row.
    expect(find).not.toHaveBeenCalled();
    expect(stubs.inventoryRepositoryStub.save).not.toHaveBeenCalled();
    expect(stubs.orderRepositoryStub.save).not.toHaveBeenCalled();
    expect(stubs.outboxServiceStub.createEvent).not.toHaveBeenCalled();
  });

  it('should reject COMPLETED with 409 and touch nothing', async () => {
    const stubs = await createCancelUnitStubs();
    const completedOrder = buildPendingOrder('user-cancel-4');
    completedOrder.status = OrderStatus.COMPLETED;
    stubs.orderRepositoryStub.findOne.mockResolvedValue(completedOrder);
    const { manager } = createUnitManagerStub({
      [Order.name]: stubs.orderRepositoryStub,
      [Reservation.name]: stubs.reservationRepositoryStub,
      [Inventory.name]: stubs.inventoryRepositoryStub,
    });

    await expect(
      stubs.cancellationService.cancelOrderWithManager(
        manager,
        'order-cancel-unit-1',
        'user',
        'correlation-unit-4',
        'user-cancel-4',
        UserRoles.User,
      ),
    ).rejects.toThrow(ConflictException);
    expect(stubs.orderRepositoryStub.save).not.toHaveBeenCalled();
  });

  it('should reject non-owner with 403 and allow admin bypass', async () => {
    const stubs = await createCancelUnitStubs();
    stubs.orderRepositoryStub.findOne.mockResolvedValue(
      buildPendingOrder('user-cancel-5'),
    );
    const { manager } = createUnitManagerStub({
      [Order.name]: stubs.orderRepositoryStub,
      [Reservation.name]: stubs.reservationRepositoryStub,
      [Inventory.name]: stubs.inventoryRepositoryStub,
    });

    await expect(
      stubs.cancellationService.cancelOrderWithManager(
        manager,
        'order-cancel-unit-1',
        'user',
        'correlation-unit-5',
        'other-user',
        UserRoles.User,
      ),
    ).rejects.toThrow(ForbiddenException);
  });

  it('should close the order when no reservation is linked (reservationId null)', async () => {
    const stubs = await createCancelUnitStubs();
    stubs.orderRepositoryStub.findOne.mockResolvedValue(
      buildPendingOrder('user-cancel-6'),
    );
    stubs.reservationRepositoryStub.findOne.mockResolvedValue(null);
    const { manager } = createUnitManagerStub({
      [Order.name]: stubs.orderRepositoryStub,
      [Reservation.name]: stubs.reservationRepositoryStub,
      [Inventory.name]: stubs.inventoryRepositoryStub,
    });

    const orphanResult = await stubs.cancellationService.cancelOrderWithManager(
      manager,
      'order-cancel-unit-1',
      'user',
      'correlation-unit-6',
      'user-cancel-6',
      UserRoles.User,
    );

    expect(orphanResult.order.status).toBe(OrderStatus.CANCELLED);
    expect(orphanResult.reservationId).toBeNull();
  });

  it('should throw NotFound when the order or inventory row is missing', async () => {
    const stubs = await createCancelUnitStubs();
    stubs.orderRepositoryStub.findOne.mockResolvedValue(null);
    const { manager } = createUnitManagerStub({
      [Order.name]: stubs.orderRepositoryStub,
      [Reservation.name]: stubs.reservationRepositoryStub,
      [Inventory.name]: stubs.inventoryRepositoryStub,
    });

    await expect(
      stubs.cancellationService.cancelOrderWithManager(
        manager,
        'missing-order',
        'user',
        'correlation-unit-7',
        'user-cancel-7',
        UserRoles.User,
      ),
    ).rejects.toThrow('Order missing-order not found');
  });

  it('should propagate the outbox record failure so the caller rolls back (Q2/A)', async () => {
    const stubs = await createCancelUnitStubs();
    stubs.orderRepositoryStub.findOne.mockResolvedValue(
      buildPendingOrder('user-cancel-8'),
    );
    stubs.reservationRepositoryStub.findOne.mockResolvedValue(
      buildReservedReservation(),
    );
    stubs.outboxServiceStub.createEvent.mockRejectedValue(
      new Error('outbox insert failed'),
    );
    const { manager } = createUnitManagerStub(
      {
        [Order.name]: stubs.orderRepositoryStub,
        [Reservation.name]: stubs.reservationRepositoryStub,
        [Inventory.name]: stubs.inventoryRepositoryStub,
      },
      [buildHeldInventoryRow()],
    );

    // Pre-T009 this resolves (swallow); post-T009 it must reject.
    await expect(
      stubs.cancellationService.cancelOrderWithManager(
        manager,
        'order-cancel-unit-1',
        'user',
        'correlation-unit-8',
        'user-cancel-8',
        UserRoles.User,
      ),
    ).rejects.toThrow('outbox insert failed');
  });
});
