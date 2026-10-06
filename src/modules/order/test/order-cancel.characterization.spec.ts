/**
 * This spec pins the Phase 8 cancel contract (post-hardening).
 * It succeeded the pre-Phase-8 characterization: the response is enriched
 * (FR-012) and an outbox record failure rejects so the caller rolls back
 * (Q2/A). Updated by task T011.
 * Used by: Phase 8 US1 contract guard.
 */
import { Test, TestingModule } from '@nestjs/testing';
import { DataSource } from 'typeorm';
import { OrderController } from '../order.controller';
import { OrderService } from '../order.service';
import { OrderCheckoutService } from '../order-checkout.service';
import { OrderCompletionService } from '../order-completion.service';
import { OrderCancellationService } from '../order-cancellation.service';
import { OrderStatus } from '../order-status.enum';
import { ReservationStatus } from '../../reservation/entities/reservation-status.enum';
import { Order } from '../entities/order.entity';
import { Reservation } from '../../reservation/entities/reservation.entity';
import { Inventory } from '../../inventory/entities/inventory.entity';
import { OutboxService } from '../../outbox/outbox.service';
import { UserRoles } from '../../users/enum/roles';
import { JwtGuard } from '../../auth/guards/jwt.guard';
import { RolesGuard } from '../../auth/guards/roles.guard';
import { RateLimitGuard } from '../../auth/guards/rate-limit.guard';
import {
  createUnitManagerStub,
  createUnitRepositoryStub,
} from './cancel-fixtures';

describe('OrderCancelCharacterization', () => {
  describe('controller response shape (FR-012)', () => {
    it('should return id/status/total/userId plus reason and reservationId', async () => {
      const enrichedCancelResult = {
        order: {
          id: 'order-cancel-char-1',
          userId: 'user-char-1',
          status: OrderStatus.CANCELLED,
          total: 250,
        },
        reservationId: 'reservation-cancel-char-1',
        reason: 'user',
      };
      const cancellationServiceStub = {
        cancelOrder: jest.fn().mockResolvedValue(enrichedCancelResult),
      };
      const module: TestingModule = await Test.createTestingModule({
        controllers: [OrderController],
        providers: [
          { provide: OrderService, useValue: {} },
          { provide: OrderCheckoutService, useValue: {} },
          { provide: OrderCompletionService, useValue: {} },
          {
            provide: OrderCancellationService,
            useValue: cancellationServiceStub,
          },
        ],
      })
        .overrideGuard(JwtGuard)
        .useValue({ canActivate: jest.fn().mockReturnValue(true) })
        .overrideGuard(RolesGuard)
        .useValue({ canActivate: jest.fn().mockReturnValue(true) })
        .overrideGuard(RateLimitGuard)
        .useValue({ canActivate: jest.fn().mockReturnValue(true) })
        .compile();
      const orderController = module.get<OrderController>(OrderController);

      // Controller is transport-only: no DataSource, service owns the tx.
      const cancelOrderResponse = await orderController.cancelOrder(
        'user-char-1',
        UserRoles.User,
        'order-cancel-char-1',
        { headers: {} } as never,
      );

      expect(cancelOrderResponse).toEqual({
        id: 'order-cancel-char-1',
        userId: 'user-char-1',
        status: OrderStatus.CANCELLED,
        total: 250,
        reason: 'user',
        reservationId: 'reservation-cancel-char-1',
      });
      expect(cancellationServiceStub.cancelOrder).toHaveBeenCalledWith(
        'order-cancel-char-1',
        'user',
        'user-char-1',
        UserRoles.User,
        expect.any(String),
      );
    });
  });

  describe('outbox rollback (Q2/A)', () => {
    it('should reject so the caller rolls back when the record write fails', async () => {
      const pendingOrder = {
        id: 'order-cancel-char-2',
        userId: 'user-char-2',
        status: OrderStatus.PENDING,
        total: 100,
      };
      const reservedReservation = {
        id: 'reservation-cancel-char-2',
        status: ReservationStatus.RESERVED,
        orderId: 'order-cancel-char-2',
        items: [{ inventoryId: 'inventory-cancel-char-2', quantity: 2 }],
      };
      const heldInventoryRow = {
        id: 'inventory-cancel-char-2',
        stock: 10,
        reservedAmount: 2,
      };
      const orderRepositoryStub = createUnitRepositoryStub();
      orderRepositoryStub.findOne.mockResolvedValue(pendingOrder);
      orderRepositoryStub.save.mockImplementation(
        (orderToSave: unknown) => orderToSave,
      );
      const reservationRepositoryStub = createUnitRepositoryStub();
      reservationRepositoryStub.findOne.mockResolvedValue(reservedReservation);
      reservationRepositoryStub.save.mockImplementation(
        (reservationToSave: unknown) => reservationToSave,
      );
      const inventoryRepositoryStub = createUnitRepositoryStub();
      inventoryRepositoryStub.save.mockImplementation(
        (inventoryToSave: unknown) => inventoryToSave,
      );
      const { manager: unitManagerStub } = createUnitManagerStub(
        {
          [Order.name]: orderRepositoryStub,
          [Reservation.name]: reservationRepositoryStub,
          [Inventory.name]: inventoryRepositoryStub,
        },
        [heldInventoryRow],
      );
      const failingOutboxServiceStub = {
        createEvent: jest
          .fn()
          .mockRejectedValue(new Error('outbox table missing')),
      };

      const module: TestingModule = await Test.createTestingModule({
        providers: [
          OrderCancellationService,
          { provide: OutboxService, useValue: failingOutboxServiceStub },
          { provide: DataSource, useValue: {} },
        ],
      }).compile();
      const cancellationService = module.get<OrderCancellationService>(
        OrderCancellationService,
      );

      // Q2/A: the record failure propagates — no swallow, caller rolls back.
      await expect(
        cancellationService.cancelOrderWithManager(
          unitManagerStub,
          'order-cancel-char-2',
          'user',
          'correlation-char-2',
          'user-char-2',
          UserRoles.User,
        ),
      ).rejects.toThrow('outbox table missing');
    });
  });
});
