import { Test, type TestingModule } from '@nestjs/testing';
import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import { getRepositoryToken } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { PaymentService } from './payment.service';
import { Payment } from './entities/payment.entity';
import { PaymentStatus } from './entities/payment-status.enum';
import { Order } from '../order/entities/order.entity';
import { OrderStatus } from '../order/order-status.enum';
import { OrderCompletionService } from '../order/order-completion.service';
import { OrderCancellationService } from '../order/order-cancellation.service';
import { UserRoles } from '../users/enum/roles';

/**
 * Unit tests for PaymentService with mocked persistence and order cores.
 * Transactional locking and constraints are proven by real-PostgreSQL suites.
 */
describe('PaymentService', () => {
  let service: PaymentService;

  const mockPaymentRepo = {
    findOne: jest.fn(),
    create: jest.fn(),
    save: jest.fn(),
    findAndCount: jest.fn(),
  };
  const mockOrderRepo = { findOne: jest.fn() };
  const mockTxPaymentRepo = {
    findOne: jest.fn(),
    create: jest.fn(),
    save: jest.fn(),
  };
  const mockManager = {
    getRepository: jest.fn((entity: unknown) => {
      // Route repository access by entity so intent/confirm/cancel share one manager mock.
      if (entity === Payment) return mockTxPaymentRepo;
      return mockOrderRepo;
    }),
    query: jest.fn(),
  };
  const mockDataSource = {
    transaction: jest.fn(async (callback: (manager: unknown) => unknown) =>
      callback(mockManager),
    ),
  };
  const mockCompletionService = { completeOrderWithManager: jest.fn() };
  const mockCancellationService = { cancelOrderWithManager: jest.fn() };
  const mockPaymentReadRepo = {
    findOne: jest.fn(),
    findAndCount: jest.fn(),
  };

  const pendingOrder = {
    id: 'order-1',
    userId: 'user-1',
    status: OrderStatus.PENDING,
    total: 250,
  };

  beforeEach(async () => {
    jest.clearAllMocks();
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        PaymentService,
        { provide: DataSource, useValue: mockDataSource },
        { provide: getRepositoryToken(Payment), useValue: mockPaymentReadRepo },
        {
          provide: OrderCompletionService,
          useValue: mockCompletionService,
        },
        {
          provide: OrderCancellationService,
          useValue: mockCancellationService,
        },
      ],
    }).compile();
    service = module.get<PaymentService>(PaymentService);
    void mockPaymentRepo;
  });

  describe('createPaymentIntent', () => {
    it('should create a pending payment copying the order total', async () => {
      mockOrderRepo.findOne.mockResolvedValue(pendingOrder);
      mockTxPaymentRepo.findOne.mockResolvedValue(null);
      mockTxPaymentRepo.create.mockImplementation((value: unknown) => value);
      mockTxPaymentRepo.save.mockImplementation(async (value: unknown) => ({
        ...(value as Record<string, unknown>),
        id: 'pay-1',
      }));

      const createdPayment = await service.createPaymentIntent(
        'user-1',
        'order-1',
      );

      expect(createdPayment.status).toBe(PaymentStatus.PENDING);
      expect(mockTxPaymentRepo.create).toHaveBeenCalledWith(
        expect.objectContaining({
          orderId: 'order-1',
          userId: 'user-1',
          amount: 250,
          currency: 'usd',
          provider: 'simulation',
        }),
      );
    });

    it('should return the existing payment when a pending intent already exists', async () => {
      const existingPayment = { id: 'pay-9', status: PaymentStatus.PENDING };
      mockOrderRepo.findOne.mockResolvedValue(pendingOrder);
      mockTxPaymentRepo.findOne.mockResolvedValue(existingPayment);

      const createdPayment = await service.createPaymentIntent(
        'user-1',
        'order-1',
      );

      expect(createdPayment).toBe(existingPayment);
      expect(mockTxPaymentRepo.save).not.toHaveBeenCalled();
    });

    it('should reject intent on a non-pending order', async () => {
      mockOrderRepo.findOne.mockResolvedValue({
        ...pendingOrder,
        status: OrderStatus.COMPLETED,
      });

      await expect(
        service.createPaymentIntent('user-1', 'order-1'),
      ).rejects.toBeInstanceOf(ConflictException);
    });

    it('should reject intent when a terminal payment exists', async () => {
      mockOrderRepo.findOne.mockResolvedValue(pendingOrder);
      mockTxPaymentRepo.findOne.mockResolvedValue({
        id: 'pay-7',
        status: PaymentStatus.SUCCEEDED,
      });

      await expect(
        service.createPaymentIntent('user-1', 'order-1'),
      ).rejects.toBeInstanceOf(ConflictException);
    });

    it('should reject intent by a non-owner', async () => {
      mockOrderRepo.findOne.mockResolvedValue(pendingOrder);

      await expect(
        service.createPaymentIntent('user-2', 'order-1'),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('should reject intent for a missing order', async () => {
      mockOrderRepo.findOne.mockResolvedValue(null);

      await expect(
        service.createPaymentIntent('user-1', 'missing'),
      ).rejects.toBeInstanceOf(NotFoundException);
    });
  });

  describe('confirmPayment', () => {
    const pendingPayment = {
      id: 'pay-1',
      orderId: 'order-1',
      userId: 'user-1',
      status: PaymentStatus.PENDING,
    };

    it('should complete the order on success and mark payment succeeded', async () => {
      mockTxPaymentRepo.findOne.mockResolvedValue({ ...pendingPayment });
      mockCompletionService.completeOrderWithManager.mockResolvedValue({
        id: 'order-1',
        status: OrderStatus.COMPLETED,
      });
      mockTxPaymentRepo.save.mockImplementation(
        async (value: unknown) => value,
      );

      const confirmResult = await service.confirmPayment(
        'pay-1',
        'user-1',
        'success',
        undefined,
        'corr-1',
      );

      expect(
        mockCompletionService.completeOrderWithManager,
      ).toHaveBeenCalledWith(
        mockManager,
        'user-1',
        'order-1',
        undefined,
        'corr-1',
      );
      expect(confirmResult.payment.status).toBe(PaymentStatus.SUCCEEDED);
    });

    it('should return already-processed with zero delta on terminal re-confirm', async () => {
      mockTxPaymentRepo.findOne.mockResolvedValue({
        ...pendingPayment,
        status: PaymentStatus.SUCCEEDED,
      });
      mockOrderRepo.findOne.mockResolvedValue({
        ...pendingOrder,
        status: OrderStatus.COMPLETED,
      });

      const confirmResult = await service.confirmPayment(
        'pay-1',
        'user-1',
        'success',
      );

      expect(confirmResult.payment.status).toBe(PaymentStatus.SUCCEEDED);
      expect(
        mockCompletionService.completeOrderWithManager,
      ).not.toHaveBeenCalled();
      expect(
        mockCancellationService.cancelOrderWithManager,
      ).not.toHaveBeenCalled();
    });

    it('should require a failure reason on declined confirm', async () => {
      await expect(
        service.confirmPayment('pay-1', 'user-1', 'declined'),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(mockDataSource.transaction).not.toHaveBeenCalled();
    });

    it('should fail the order on declined confirm with a fixed-enum reason', async () => {
      mockTxPaymentRepo.findOne.mockResolvedValue({ ...pendingPayment });
      mockCancellationService.cancelOrderWithManager.mockResolvedValue({
        order: { ...pendingOrder, status: OrderStatus.FAILED },
      });
      mockOrderRepo.findOne.mockResolvedValue({
        ...pendingOrder,
        status: OrderStatus.FAILED,
      });
      mockTxPaymentRepo.save.mockImplementation(
        async (value: unknown) => value,
      );

      const confirmResult = await service.confirmPayment(
        'pay-1',
        'user-1',
        'declined',
        'card_declined',
      );

      expect(
        mockCancellationService.cancelOrderWithManager,
      ).toHaveBeenCalledWith(
        mockManager,
        'order-1',
        'failed',
        expect.any(String),
        'user-1',
        undefined,
      );
      expect(confirmResult.payment.status).toBe(PaymentStatus.FAILED);
      expect(confirmResult.payment.failureReason).toBe('card_declined');
    });

    it('should reject confirm by a non-owner', async () => {
      mockTxPaymentRepo.findOne.mockResolvedValue({ ...pendingPayment });

      await expect(
        service.confirmPayment('pay-1', 'user-2', 'success'),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });
  });

  describe('cancelPayment', () => {
    it('should cancel a pending payment and its order', async () => {
      mockTxPaymentRepo.findOne.mockResolvedValue({
        id: 'pay-1',
        orderId: 'order-1',
        userId: 'user-1',
        status: PaymentStatus.PENDING,
      });
      mockCancellationService.cancelOrderWithManager.mockResolvedValue({
        order: { ...pendingOrder, status: OrderStatus.CANCELLED },
      });
      mockOrderRepo.findOne.mockResolvedValue({
        ...pendingOrder,
        status: OrderStatus.CANCELLED,
      });
      mockTxPaymentRepo.save.mockImplementation(
        async (value: unknown) => value,
      );

      const cancelResult = await service.cancelPayment('pay-1', 'user-1');

      expect(cancelResult.payment.status).toBe(PaymentStatus.CANCELLED);
      expect(
        mockCancellationService.cancelOrderWithManager,
      ).toHaveBeenCalledWith(
        mockManager,
        'order-1',
        'user',
        expect.any(String),
        'user-1',
        undefined,
      );
    });

    it('should reject cancel of a terminal payment', async () => {
      mockTxPaymentRepo.findOne.mockResolvedValue({
        id: 'pay-1',
        orderId: 'order-1',
        userId: 'user-1',
        status: PaymentStatus.SUCCEEDED,
      });

      await expect(
        service.cancelPayment('pay-1', 'user-1'),
      ).rejects.toBeInstanceOf(ConflictException);
    });

    it('should reject cancel of a missing payment', async () => {
      mockTxPaymentRepo.findOne.mockResolvedValue(null);

      await expect(
        service.cancelPayment('missing', 'user-1'),
      ).rejects.toBeInstanceOf(NotFoundException);
    });
  });

  describe('getPaymentById', () => {
    it('should return the payment to its owner', async () => {
      mockPaymentReadRepo.findOne.mockResolvedValue({
        id: 'pay-1',
        userId: 'user-1',
      });

      const foundPayment = await service.getPaymentById('pay-1', 'user-1');

      expect(foundPayment.id).toBe('pay-1');
    });

    it('should return the payment to an admin', async () => {
      mockPaymentReadRepo.findOne.mockResolvedValue({
        id: 'pay-1',
        userId: 'user-1',
      });

      const foundPayment = await service.getPaymentById(
        'pay-1',
        'admin-1',
        UserRoles.Admin,
      );

      expect(foundPayment.id).toBe('pay-1');
    });

    it('should deny a stranger', async () => {
      mockPaymentReadRepo.findOne.mockResolvedValue({
        id: 'pay-1',
        userId: 'user-1',
      });

      await expect(
        service.getPaymentById('pay-1', 'user-2', UserRoles.User),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });
  });

  describe('listPayments', () => {
    it('should return paginated rows with shared meta envelope', async () => {
      mockPaymentReadRepo.findAndCount.mockResolvedValue([
        [{ id: 'pay-1' }],
        1,
      ]);

      const listResult = await service.listPayments('user-1');

      expect(listResult.data).toHaveLength(1);
      expect(listResult.meta).toEqual({
        totalItems: 1,
        itemCount: 1,
        itemsPerPage: 20,
        totalPages: 1,
        currentPage: 1,
      });
      expect(mockPaymentReadRepo.findAndCount).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { userId: 'user-1' },
          order: { createdAt: 'DESC' },
          skip: 0,
          take: 20,
        }),
      );
    });

    it('should reject an invalid status filter', async () => {
      await expect(
        service.listPayments('user-1', undefined, '1', '20', 'BOGUS'),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('should reject a non-admin user filter for another user', async () => {
      await expect(
        service.listPayments(
          'user-1',
          UserRoles.User,
          '1',
          '20',
          undefined,
          'user-2',
        ),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });
  });
});
