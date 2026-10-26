import {
  BadRequestException,
  InternalServerErrorException,
} from '@nestjs/common';
import { EntityManager } from 'typeorm';
import { InventoryService } from '../inventory/inventory.service';
import { Inventory } from '../inventory/entities/inventory.entity';
import { CreateReservationRefactored } from './dto/create-reservation.dto';
import { ReservationItem } from './entities/reservation-item.entity';
import { Reservation } from './entities/reservation.entity';
import { ReservationRefactoredService } from './reservation-refactored.service';

describe('ReservationRefactoredService', () => {
  const reserveManyOnCheckout = jest.fn();
  const inventoryService = {
    reserveManyOnCheckout,
  } as unknown as InventoryService;
  let service: ReservationRefactoredService;

  beforeEach(() => {
    jest.clearAllMocks();
    service = new ReservationRefactoredService(inventoryService);
  });

  it('returns the saved reservation and saved reservation items', async () => {
    const inventoryRow = new Inventory();
    inventoryRow.id = 'inventory-1';
    inventoryRow.productId = 'product-1';
    inventoryRow.stock = 10;
    inventoryRow.reservedAmount = 0;
    reserveManyOnCheckout.mockResolvedValue([inventoryRow]);

    const savedReservation = {
      id: 'reservation-1',
      userId: 'user-1',
    } as Reservation;
    const savedReservationItems = [
      { id: 'reservation-item-1', quantity: 2 } as ReservationItem,
    ];
    const createEntity = jest.fn((_entity: unknown, values: object) => values);
    const manager = {
      queryRunner: { isTransactionActive: true },
      create: createEntity,
      save: jest
        .fn()
        .mockResolvedValueOnce(savedReservation)
        .mockResolvedValueOnce(savedReservationItems),
    } as unknown as EntityManager;
    const reservationData = Object.assign(new CreateReservationRefactored(), {
      manager,
      productsMap: new Map([['product-1', 2]]),
      userId: 'user-1',
      inventoryRows: [inventoryRow],
    });

    const result = await service.createReservation(reservationData);

    expect(result.data.reservation.id).toBe('reservation-1');
    expect(result.data.reservation.items).toEqual(savedReservationItems);
    expect(createEntity).toHaveBeenCalledWith(
      ReservationItem,
      expect.objectContaining({
        reservationId: 'reservation-1',
        inventoryId: 'inventory-1',
        quantity: 2,
      }),
    );
  });

  it('rejects an invalid duration before changing inventory', async () => {
    const manager = {
      queryRunner: { isTransactionActive: true },
    } as unknown as EntityManager;
    const reservationData = Object.assign(new CreateReservationRefactored(), {
      manager,
      productsMap: new Map([['product-1', 2]]),
      userId: 'user-1',
      inventoryRows: [new Inventory()],
      reservationDurationInMinutes: 4,
    });

    await expect(service.createReservation(reservationData)).rejects.toThrow(
      BadRequestException,
    );
    expect(reserveManyOnCheckout).not.toHaveBeenCalled();
  });

  it('rejects calls without an active transaction', async () => {
    const manager = {
      queryRunner: { isTransactionActive: false },
    } as unknown as EntityManager;
    const reservationData = Object.assign(new CreateReservationRefactored(), {
      manager,
      productsMap: new Map([['product-1', 2]]),
      userId: 'user-1',
      inventoryRows: [new Inventory()],
    });

    await expect(service.createReservation(reservationData)).rejects.toThrow(
      InternalServerErrorException,
    );
    expect(reserveManyOnCheckout).not.toHaveBeenCalled();
  });
});
