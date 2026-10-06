/**
 * This spec proves the expiry path still works beside user cancel (US2/T014).
 * It races the expiration worker's expire against a user cancel on the same
 * pending order: exactly one inventory release, one consistent terminal pair.
 * The expiry path itself is untouched by Phase 8 (research D4).
 * Used by: Phase 8 US2 (T014).
 */
import * as dotenv from 'dotenv';
import { DataSource } from 'typeorm';
import { Order } from '../../order/entities/order.entity';
import { OrderStatus } from '../../order/order-status.enum';
import { OrderCancellationService } from '../../order/order-cancellation.service';
import { Reservation } from '../entities/reservation.entity';
import { ReservationStatus } from '../entities/reservation-status.enum';
import { Inventory } from '../../inventory/entities/inventory.entity';
import { ConfigService } from '@nestjs/config';
import { OutboxService } from '../../outbox/outbox.service';
import { OutboxEvent } from '../../outbox/entities/outbox-event.entity';
import { ReservationService } from '../reservation.service';
import { ReservationExpirationService } from '../reservation-expiration.service';
import { UserRoles } from '../../users/enum/roles';
import {
  CancelFixture,
  checkoutFixtureOrder,
  createCancelTestDataSource,
  createFixtureProductWithInventory,
  createFixtureUser,
  truncateCancelTables,
} from '../../order/test/cancel-fixtures';

dotenv.config();

describe('OrderCancelExpiryRace (real PostgreSQL)', () => {
  let raceDataSource: DataSource;
  let cancellationService: OrderCancellationService;
  let reservationService: ReservationService;
  let testsEnabled = true;

  beforeAll(async () => {
    try {
      raceDataSource = await createCancelTestDataSource();
      cancellationService = new OrderCancellationService(
        raceDataSource,
        new OutboxService(),
      );
      reservationService = new ReservationService(raceDataSource);
    } catch (integrationError) {
      testsEnabled = false;
      console.warn(
        'OrderCancel expiry race tests skipped — PG not available',
        (integrationError as Error)?.message,
      );
    }
  });

  afterAll(async () => {
    if (raceDataSource?.isInitialized) {
      await truncateCancelTables(raceDataSource);
      await raceDataSource.destroy();
    }
  });

  beforeEach(async () => {
    if (testsEnabled) {
      await truncateCancelTables(raceDataSource);
    }
  });

  /** Checks out a single-line fixture, then forces the reservation expired. */
  async function checkoutExpiredFixture(): Promise<CancelFixture> {
    const fixtureUser = await createFixtureUser(raceDataSource);
    const { fixtureProduct, fixtureInventory } =
      await createFixtureProductWithInventory(raceDataSource, 100, 10);
    const fixture = await checkoutFixtureOrder(raceDataSource, fixtureUser, [
      { product: fixtureProduct, inventory: fixtureInventory, quantity: 2 },
    ]);
    // Force expiry: backdate expiresAt below NOW() like the worker would find.
    await raceDataSource.query(
      `UPDATE "reservation" SET "expiresAt" = NOW() - interval '5 minutes' WHERE id = $1`,
      [fixture.fixtureReservation.id],
    );
    return fixture;
  }

  it('should expire the reservation and auto-cancel the order with one release', async () => {
    if (!testsEnabled) return;
    const fixture = await checkoutExpiredFixture();

    // Mimics ReservationExpirationService.expireOne inside its own tx.
    await raceDataSource.transaction((manager) =>
      reservationService.expire(manager, fixture.fixtureReservation.id),
    );

    const reloadedReservation = await raceDataSource
      .getRepository(Reservation)
      .findOne({ where: { id: fixture.fixtureReservation.id } });
    expect(reloadedReservation?.status).toBe(ReservationStatus.EXPIRED);
    const reloadedOrder = await raceDataSource
      .getRepository(Order)
      .findOne({ where: { id: fixture.fixtureOrder.id } });
    expect(reloadedOrder?.status).toBe(OrderStatus.CANCELLED);
    const reloadedInventory = await raceDataSource
      .getRepository(Inventory)
      .findOne({ where: { id: fixture.fixtureLines[0].inventory.id } });
    // Single release from the expiry path.
    expect(reloadedInventory?.reservedAmount).toBe(0);
    expect(reloadedInventory?.stock).toBe(10);
  });

  it('should emit order.cancelled with reason expired through the batch path (D4 parity)', async () => {
    if (!testsEnabled) return;
    const fixture = await checkoutExpiredFixture();
    // Real ConfigService reads process.env (EXPIRATION_* set in .env).
    const expirationService = new ReservationExpirationService(
      raceDataSource,
      reservationService,
      new ConfigService(),
      new OutboxService(),
    );

    const batchResult = await expirationService.processExpiredBatch(10);

    expect(batchResult.expired).toBe(1);
    const cancelledRows = await raceDataSource
      .getRepository(OutboxEvent)
      .find({ where: { aggregateId: fixture.fixtureOrder.id } });
    const expiredCancelRow = cancelledRows.find(
      (outboxRow) => outboxRow.eventType === 'order.cancelled',
    );
    expect(expiredCancelRow).toBeDefined();
    const expiredCancelData = (
      expiredCancelRow?.payload as Record<string, unknown>
    )['data'] as Record<string, unknown>;
    expect(expiredCancelData).toMatchObject({
      orderId: fixture.fixtureOrder.id,
      previousStatus: 'PENDING',
      newStatus: 'CANCELLED',
      reason: 'expired',
      reservationId: fixture.fixtureReservation.id,
    });
  });

  it('should release exactly once when user cancel races expiry', async () => {
    if (!testsEnabled) return;
    const fixture = await checkoutExpiredFixture();
    const expireAttempt = (): Promise<string> =>
      raceDataSource
        .transaction((manager) =>
          reservationService.expire(manager, fixture.fixtureReservation.id),
        )
        .then(() => 'expired')
        .catch(() => 'expire-failed');
    const cancelAttempt = (): Promise<string> =>
      raceDataSource
        .transaction((manager) =>
          cancellationService.cancelOrderWithManager(
            manager,
            fixture.fixtureOrder.id,
            'user',
            `correlation-expiry-race-${Math.random()}`,
            fixture.fixtureUser.id,
            UserRoles.User,
          ),
        )
        .then(() => 'cancelled')
        .catch(() => 'cancel-failed');

    await Promise.all([expireAttempt(), cancelAttempt()]);

    const reloadedOrder = await raceDataSource
      .getRepository(Order)
      .findOne({ where: { id: fixture.fixtureOrder.id } });
    const reloadedReservation = await raceDataSource
      .getRepository(Reservation)
      .findOne({ where: { id: fixture.fixtureReservation.id } });
    const reloadedInventory = await raceDataSource
      .getRepository(Inventory)
      .findOne({ where: { id: fixture.fixtureLines[0].inventory.id } });
    // No double-release under any interleaving (SC-004).
    expect(reloadedInventory?.reservedAmount).toBe(0);
    expect(reloadedInventory?.stock).toBe(10);
    if (reloadedReservation?.status === ReservationStatus.EXPIRED) {
      // Expiry won: order auto-cancelled beside it.
      expect(reloadedOrder?.status).toBe(OrderStatus.CANCELLED);
    } else {
      // Cancel won: reservation released as CANCELLED, order closed.
      expect(reloadedReservation?.status).toBe(ReservationStatus.CANCELLED);
      expect(reloadedOrder?.status).toBe(OrderStatus.CANCELLED);
    }
  });
});
