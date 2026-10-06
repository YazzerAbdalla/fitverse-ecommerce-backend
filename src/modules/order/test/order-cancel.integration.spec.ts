/**
 * This spec proves cancel atomicity on real PostgreSQL (Phase 8 US1).
 * It covers the full move (order + reservation + inventory + outbox),
 * the Q2/A rollback on record failure, terminal-reservation zero-delta,
 * and availability restoration.
 * Used by: tasks T007 (US1), T013 (US2), T016 (US3 envelope).
 */
import * as dotenv from 'dotenv';
import { DataSource } from 'typeorm';
import { Order } from '../entities/order.entity';
import { OrderStatus } from '../order-status.enum';
import { Reservation } from '../../reservation/entities/reservation.entity';
import { ReservationStatus } from '../../reservation/entities/reservation-status.enum';
import { Inventory } from '../../inventory/entities/inventory.entity';
import { OutboxEvent } from '../../outbox/entities/outbox-event.entity';
import { OutboxService } from '../../outbox/outbox.service';
import { OrderCancellationService } from '../order-cancellation.service';
import { UserRoles } from '../../users/enum/roles';
import {
  CancelFixture,
  checkoutFixtureOrder,
  createCancelTestDataSource,
  createFixtureProductWithInventory,
  createFixtureUser,
  truncateCancelTables,
} from './cancel-fixtures';

dotenv.config();

describe('OrderCancelIntegration (real PostgreSQL)', () => {
  let cancelTestDataSource: DataSource;
  let cancellationService: OrderCancellationService;
  let testsEnabled = true;

  beforeAll(async () => {
    try {
      cancelTestDataSource = await createCancelTestDataSource();
      cancellationService = new OrderCancellationService(
        cancelTestDataSource,
        new OutboxService(),
      );
    } catch (integrationError) {
      testsEnabled = false;
      console.warn(
        'OrderCancel integration tests skipped — PG not available',
        (integrationError as Error)?.message,
      );
    }
  });

  afterAll(async () => {
    if (cancelTestDataSource?.isInitialized) {
      await truncateCancelTables(cancelTestDataSource);
      await cancelTestDataSource.destroy();
    }
  });

  beforeEach(async () => {
    if (testsEnabled) {
      await truncateCancelTables(cancelTestDataSource);
    }
  });

  /** Checks out a single-line fixture (price 100, stock 10, qty 2). */
  async function checkoutSingleLineFixture(): Promise<CancelFixture> {
    const fixtureUser = await createFixtureUser(cancelTestDataSource);
    const { fixtureProduct, fixtureInventory } =
      await createFixtureProductWithInventory(cancelTestDataSource, 100, 10);
    return checkoutFixtureOrder(cancelTestDataSource, fixtureUser, [
      { product: fixtureProduct, inventory: fixtureInventory, quantity: 2 },
    ]);
  }

  it('should atomically cancel with released hold, unchanged stock, and one outbox row', async () => {
    if (!testsEnabled) return;
    const fixture = await checkoutSingleLineFixture();

    const cancelOrderResult = await cancelTestDataSource.transaction(
      (manager) =>
        cancellationService.cancelOrderWithManager(
          manager,
          fixture.fixtureOrder.id,
          'user',
          'correlation-integration-1',
          fixture.fixtureUser.id,
          UserRoles.User,
        ),
    );

    expect(cancelOrderResult.order.status).toBe(OrderStatus.CANCELLED);
    const reloadedOrder = await cancelTestDataSource
      .getRepository(Order)
      .findOne({ where: { id: fixture.fixtureOrder.id } });
    expect(reloadedOrder?.status).toBe(OrderStatus.CANCELLED);
    const reloadedReservation = await cancelTestDataSource
      .getRepository(Reservation)
      .findOne({ where: { id: fixture.fixtureReservation.id } });
    expect(reloadedReservation?.status).toBe(ReservationStatus.CANCELLED);
    const reloadedInventory = await cancelTestDataSource
      .getRepository(Inventory)
      .findOne({ where: { id: fixture.fixtureLines[0].inventory.id } });
    // Hold released (2 → 0), shelf stock untouched (10).
    expect(reloadedInventory?.reservedAmount).toBe(0);
    expect(reloadedInventory?.stock).toBe(10);
    const outboxRows = await cancelTestDataSource
      .getRepository(OutboxEvent)
      .find({ where: { aggregateId: fixture.fixtureOrder.id } });
    expect(outboxRows).toHaveLength(1);
    expect(outboxRows[0].eventType).toBe('order.cancelled');
    // US3/T016: durable envelope carries the full cancel trace.
    const cancelPayload = outboxRows[0].payload;
    expect(cancelPayload['version']).toBe(1);
    expect(cancelPayload['eventId']).toBe(outboxRows[0].id);
    expect(cancelPayload['eventType']).toBe('order.cancelled');
    expect(typeof cancelPayload['correlationId']).toBe('string');
    const cancelData = cancelPayload['data'] as Record<string, unknown>;
    expect(cancelData).toMatchObject({
      orderId: fixture.fixtureOrder.id,
      userId: fixture.fixtureUser.id,
      previousStatus: 'PENDING',
      newStatus: 'CANCELLED',
      reason: 'user',
      reservationId: fixture.fixtureReservation.id,
    });

    // Re-cancel emits no second row (duplicate-safe observability).
    await cancelTestDataSource.transaction((manager) =>
      cancellationService.cancelOrderWithManager(
        manager,
        fixture.fixtureOrder.id,
        'user',
        'correlation-integration-1b',
        fixture.fixtureUser.id,
        UserRoles.User,
      ),
    );
    const outboxRowsAfterRecancel = await cancelTestDataSource
      .getRepository(OutboxEvent)
      .find({ where: { aggregateId: fixture.fixtureOrder.id } });
    expect(outboxRowsAfterRecancel).toHaveLength(1);
  });

  it('should roll back the whole cancel when the outbox record write fails (Q2/A)', async () => {
    if (!testsEnabled) return;
    const fixture = await checkoutSingleLineFixture();
    const realOutboxService = new OutboxService();
    const createEventSpy = jest
      .spyOn(realOutboxService, 'createEvent')
      .mockRejectedValue(new Error('outbox down'));
    const rollbackCancellationService = new OrderCancellationService(
      cancelTestDataSource,
      realOutboxService,
    );

    await expect(
      cancelTestDataSource.transaction((manager) =>
        rollbackCancellationService.cancelOrderWithManager(
          manager,
          fixture.fixtureOrder.id,
          'user',
          'correlation-integration-2',
          fixture.fixtureUser.id,
          UserRoles.User,
        ),
      ),
    ).rejects.toThrow('outbox down');
    expect(createEventSpy).toHaveBeenCalled();

    // Pre-T009 this assertion fails: the cancel commits despite the failure.
    const reloadedOrder = await cancelTestDataSource
      .getRepository(Order)
      .findOne({ where: { id: fixture.fixtureOrder.id } });
    expect(reloadedOrder?.status).toBe(OrderStatus.PENDING);
    const reloadedInventory = await cancelTestDataSource
      .getRepository(Inventory)
      .findOne({ where: { id: fixture.fixtureLines[0].inventory.id } });
    expect(reloadedInventory?.reservedAmount).toBe(2);
  });

  it('should close the order with zero inventory delta when the reservation is already terminal', async () => {
    if (!testsEnabled) return;
    const fixture = await checkoutSingleLineFixture();
    await cancelTestDataSource.getRepository(Reservation).save({
      ...fixture.fixtureReservation,
      status: ReservationStatus.EXPIRED,
    });

    const terminalResult = await cancelTestDataSource.transaction((manager) =>
      cancellationService.cancelOrderWithManager(
        manager,
        fixture.fixtureOrder.id,
        'user',
        'correlation-integration-3',
        fixture.fixtureUser.id,
        UserRoles.User,
      ),
    );

    expect(terminalResult.order.status).toBe(OrderStatus.CANCELLED);
    const reloadedInventory = await cancelTestDataSource
      .getRepository(Inventory)
      .findOne({ where: { id: fixture.fixtureLines[0].inventory.id } });
    // Already released elsewhere — this cancel must not move it again.
    expect(reloadedInventory?.reservedAmount).toBe(2);
  });

  it('should let an admin cancel another user order', async () => {
    if (!testsEnabled) return;
    const fixture = await checkoutSingleLineFixture();

    const adminResult = await cancelTestDataSource.transaction((manager) =>
      cancellationService.cancelOrderWithManager(
        manager,
        fixture.fixtureOrder.id,
        'user',
        'correlation-integration-5',
        'some-admin-id',
        UserRoles.Admin,
      ),
    );

    expect(adminResult.order.status).toBe(OrderStatus.CANCELLED);
  });

  it('should reject a non-owner non-admin cancel with forbidden', async () => {
    if (!testsEnabled) return;
    const fixture = await checkoutSingleLineFixture();

    await expect(
      cancelTestDataSource.transaction((manager) =>
        cancellationService.cancelOrderWithManager(
          manager,
          fixture.fixtureOrder.id,
          'user',
          'correlation-integration-6',
          'stranger-id',
          UserRoles.User,
        ),
      ),
    ).rejects.toThrow('You are not allowed to access this order');
  });

  it('should restore availability to full stock after cancel', async () => {
    if (!testsEnabled) return;
    const fixture = await checkoutSingleLineFixture();

    await cancelTestDataSource.transaction((manager) =>
      cancellationService.cancelOrderWithManager(
        manager,
        fixture.fixtureOrder.id,
        'user',
        'correlation-integration-4',
        fixture.fixtureUser.id,
        UserRoles.User,
      ),
    );

    const reloadedInventory = await cancelTestDataSource
      .getRepository(Inventory)
      .findOne({ where: { id: fixture.fixtureLines[0].inventory.id } });
    expect(
      (reloadedInventory?.stock ?? 0) -
        (reloadedInventory?.reservedAmount ?? 1),
    ).toBe(10);
  });
});
