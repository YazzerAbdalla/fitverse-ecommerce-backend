import { ConflictException } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { OrderService } from './order.service';
import { OrderStatus } from './order-status.enum';
import { DataSource } from 'typeorm';

describe('OrderService', () => {
  let service: OrderService;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        OrderService,
        { provide: DataSource, useValue: { getRepository: jest.fn() } },
      ],
    }).compile();

    service = module.get<OrderService>(OrderService);
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });

  describe('validateOrderTransition', () => {
    it('should allow PENDING -> COMPLETED', () => {
      expect(() =>
        service.validateOrderTransition(
          OrderStatus.PENDING,
          OrderStatus.COMPLETED,
        ),
      ).not.toThrow();
    });

    it('should allow PENDING -> CANCELLED and PENDING -> FAILED', () => {
      expect(() =>
        service.validateOrderTransition(
          OrderStatus.PENDING,
          OrderStatus.CANCELLED,
        ),
      ).not.toThrow();
      expect(() =>
        service.validateOrderTransition(
          OrderStatus.PENDING,
          OrderStatus.FAILED,
        ),
      ).not.toThrow();
    });

    it('should allow COMPLETED -> COMPLETED idempotent', () => {
      expect(() =>
        service.validateOrderTransition(
          OrderStatus.COMPLETED,
          OrderStatus.COMPLETED,
        ),
      ).not.toThrow();
    });

    it('should reject CANCELLED -> COMPLETED', () => {
      expect(() =>
        service.validateOrderTransition(
          OrderStatus.CANCELLED,
          OrderStatus.COMPLETED,
        ),
      ).toThrow(ConflictException);
    });

    it('should reject FAILED -> COMPLETED', () => {
      expect(() =>
        service.validateOrderTransition(
          OrderStatus.FAILED,
          OrderStatus.COMPLETED,
        ),
      ).toThrow(ConflictException);
    });

    it('should reject COMPLETED -> CANCELLED', () => {
      expect(() =>
        service.validateOrderTransition(
          OrderStatus.COMPLETED,
          OrderStatus.CANCELLED,
        ),
      ).toThrow(ConflictException);
    });
  });

  describe('assertOwner', () => {
    it('should not throw for owner', () => {
      const order: any = { userId: 'u1' };
      expect(() =>
        service.assertOwner(order, 'u1', 'User' as any),
      ).not.toThrow();
    });

    it('should not throw for Admin', () => {
      const order: any = { userId: 'u1' };
      expect(() =>
        service.assertOwner(order, 'u2', 'Admin' as any),
      ).not.toThrow();
    });

    it('should throw for non-owner non-admin', () => {
      const order: any = { userId: 'u1' };
      expect(() => service.assertOwner(order, 'u2', 'User' as any)).toThrow();
    });
  });
});
