/**
 * This spec proves single-winner cancel races on real PostgreSQL (SC-004).
 * It races cancel-vs-cancel and cancel-vs-complete on the same pending order:
 * exactly one transition wins with exactly one inventory movement.
 * Used by: Phase 8 US1 (T008).
 */
import * as dotenv from 'dotenv';
import { DataSource } from 'typeorm';
import { Order } from '../entities/order.entity';
import { OrderStatus } from '../order-status.enum';
import { Inventory } from '../../inventory/entities/inventory.entity';
import { OutboxEvent } from '../../outbox/entities/outbox-event.entity';
import { OutboxService } from '../../outbox/outbox.service';
import { OrderCancellationService } from '../order-cancellation.service';
import { OrderCompletionService } from '../order-completion.service';
import { ReservationService } from '../../reservation/reservation.service';
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

describe('OrderCancelConcurrency (real PostgreSQL)', () => {
  let cancelTestDataSource: DataSource;
  let cancellationService: OrderCancellationService;
  let completionService: OrderCompletionService;
  let testsEnabled = true;

  beforeAll(async () => {
    try {
      cancelTestDataSource = await createCancelTestDataSource();
      const sharedOutboxService = new OutboxService();
      cancellationService = new OrderCancellationService(
        cancelTestDataSource,
        sharedOutboxService,
      );
      completionService = new OrderCompletionService(
        cancelTestDataSource,
        new ReservationService(cancelTestDataSource),
        sharedOutboxService,
      );
    } catch (integrationError) {
      testsEnabled = false;
      console.warn(
        'OrderCancel concurrency tests skipped — PG not available',
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

  it('should release the hold exactly once when two cancels race', async () => {
    if (!testsEnabled) return;
    const fixture = await checkoutSingleLineFixture();
    const cancelAttempt = (): Promise<unknown> =>
      cancelTestDataSource
        .transaction((manager) =>
          cancellationService.cancelOrderWithManager(
            manager,
            fixture.fixtureOrder.id,
            'user',
            `correlation-race-${Math.random()}`,
            fixture.fixtureUser.id,
            UserRoles.User,
          ),
        )
        .catch((raceError: Error) => raceError);

    const [firstOutcome, secondOutcome] = await Promise.all([
      cancelAttempt(),
      cancelAttempt(),
    ]);

    // Both settle as CANCELLED (second is idempotent 200), never a throw.
    for (const raceOutcome of [firstOutcome, secondOutcome]) {
      expect(raceOutcome).not.toBeInstanceOf(Error);
    }
    const reloadedInventory = await cancelTestDataSource
      .getRepository(Inventory)
      .findOne({ where: { id: fixture.fixtureLines[0].inventory.id } });
    // Single release: reserved 2 → 0 exactly once, stock untouched.
    expect(reloadedInventory?.reservedAmount).toBe(0);
    expect(reloadedInventory?.stock).toBe(10);
    const cancelRows = await cancelTestDataSource
      .getRepository(OutboxEvent)
      .find({ where: { aggregateId: fixture.fixtureOrder.id } });
    expect(cancelRows).toHaveLength(1);
  });

  it('should leave a consistent final state when cancel races complete', async () => {
    if (!testsEnabled) return;
    const fixture = await checkoutSingleLineFixture();
    const cancelAttempt = (): Promise<string> =>
      cancelTestDataSource
        .transaction((manager) =>
          cancellationService.cancelOrderWithManager(
            manager,
            fixture.fixtureOrder.id,
            'user',
            `correlation-race-cancel-${Math.random()}`,
            fixture.fixtureUser.id,
            UserRoles.User,
          ),
        )
        .then(() => 'cancelled')
        .catch(() => 'cancel-failed');
    const completeAttempt = (): Promise<string> =>
      cancelTestDataSource
        .transaction((manager) =>
          completionService.completeOrderWithManager(
            manager,
            fixture.fixtureUser.id,
            fixture.fixtureOrder.id,
            UserRoles.User,
            `correlation-race-complete-${Math.random()}`,
          ),
        )
        .then(() => 'completed')
        .catch(() => 'complete-failed');

    await Promise.all([cancelAttempt(), completeAttempt()]);

    const reloadedOrder = await cancelTestDataSource
      .getRepository(Order)
      .findOne({ where: { id: fixture.fixtureOrder.id } });
    const reloadedInventory = await cancelTestDataSource
      .getRepository(Inventory)
      .findOne({ where: { id: fixture.fixtureLines[0].inventory.id } });
    if (reloadedOrder?.status === OrderStatus.CANCELLED) {
      // Cancel won: hold released, stock untouched.
      expect(reloadedInventory?.reservedAmount).toBe(0);
      expect(reloadedInventory?.stock).toBe(10);
    } else {
      // Complete won: sale converted the hold into sold stock.
      expect(reloadedOrder?.status).toBe(OrderStatus.COMPLETED);
      expect(reloadedInventory?.reservedAmount).toBe(0);
      expect(reloadedInventory?.stock).toBe(8);
    }
  });
});
