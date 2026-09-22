import { ConflictException, NotFoundException } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { DataSource } from 'typeorm';
import { OrderCompletionService } from './order-completion.service';
import { OrderStatus } from './order-status.enum';
import { ReservationService } from '../reservation/reservation.service';
import { UserRoles } from '../users/enum/roles';

/**
 * This service is responsible for order sale domain tests.
 * It verifies transition guards and completion orchestration via mocked EntityManager.
 */
describe('OrderCompletionService', () => {
  let service: OrderCompletionService;
  let reservationService: { validateTransition: jest.Mock };

  beforeEach(async () => {
    reservationService = {
      validateTransition: jest.fn(),
    };
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        OrderCompletionService,
        { provide: DataSource, useValue: { transaction: jest.fn() } },
        { provide: ReservationService, useValue: reservationService },
      ],
    }).compile();

    service = module.get<OrderCompletionService>(OrderCompletionService);
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });

  describe('validateOrderTransition', () => {
    it('should allow PENDING->COMPLETED', () => {
      expect(() =>
        service.validateOrderTransition(
          OrderStatus.PENDING,
          OrderStatus.COMPLETED,
        ),
      ).not.toThrow();
    });

    it('should reject CANCELLED->COMPLETED', () => {
      expect(() =>
        service.validateOrderTransition(
          OrderStatus.CANCELLED,
          OrderStatus.COMPLETED,
        ),
      ).toThrow(ConflictException);
    });
  });

  describe('assertOwner', () => {
    it('should allow owner', () => {
      expect(() =>
        service.assertOwner({ userId: 'u1' } as any, 'u1', UserRoles.User),
      ).not.toThrow();
    });

    it('should throw for non-owner', () => {
      expect(() =>
        service.assertOwner({ userId: 'u1' } as any, 'u2', UserRoles.User),
      ).toThrow();
    });
  });

  describe('complete with mocked manager', () => {
    it('should throw NotFound if order missing', async () => {
      const manager: any = {
        getRepository: jest.fn().mockReturnValue({
          findOne: jest.fn().mockResolvedValue(null),
        }),
        find: jest.fn(),
        findOne: jest.fn(),
      };
      manager.getRepository.mockReturnValue({
        findOne: jest.fn().mockResolvedValue(null),
      });
      await expect(
        service.complete(manager, 'u1', 'order-id', UserRoles.User),
      ).rejects.toThrow(NotFoundException);
    });

    it('should return idempotent 200 when already COMPLETED (no inventory change)', async () => {
      const order: any = {
        id: 'oid',
        userId: 'u1',
        status: OrderStatus.COMPLETED,
        orderItems: [],
      };
      const reservation: any = {
        id: 'rid',
        status: 'COMPLETED',
        orderId: 'oid',
        expiresAt: new Date(),
        items: [],
      };
      const manager: any = {
        getRepository: jest.fn((entity: any) => {
          const name = entity?.name || entity;
          if (String(name).includes('Order')) {
            return {
              findOne: jest
                .fn()
                .mockResolvedValueOnce(order) // lock
                .mockResolvedValueOnce(order), // with items
            };
          }
          if (String(name).includes('Reservation')) {
            return {
              findOne: jest.fn().mockResolvedValue(reservation),
            };
          }
          return { findOne: jest.fn() };
        }),
      };
      // Need to handle second call for Order with items
      const result = await service.complete(
        manager,
        'u1',
        'oid',
        UserRoles.User,
      );
      expect(result.status).toBe(OrderStatus.COMPLETED);
      expect(reservationService.validateTransition).not.toHaveBeenCalled();
    });

    it('should reject invalid transition CANCELLED->COMPLETED with 409', async () => {
      const order: any = {
        id: 'oid',
        userId: 'u1',
        status: OrderStatus.CANCELLED,
        orderItems: [],
      };
      const manager: any = {
        getRepository: jest.fn().mockReturnValue({
          findOne: jest.fn().mockResolvedValue(order),
        }),
      };
      // First findOne for Order lock returns CANCELLED
      manager.getRepository = jest.fn().mockReturnValue({
        findOne: jest
          .fn()
          .mockResolvedValueOnce(order)
          .mockResolvedValueOnce(order),
      });
      await expect(
        service.complete(manager, 'u1', 'oid', UserRoles.User),
      ).rejects.toThrow(ConflictException);
    });
  });
});
