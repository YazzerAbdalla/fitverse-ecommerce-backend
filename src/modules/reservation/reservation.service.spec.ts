import { Test, TestingModule } from '@nestjs/testing';
import { getDataSourceToken } from '@nestjs/typeorm';
import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import { DataSource, EntityManager } from 'typeorm';
import { ReservationService } from './reservation.service';
import { ReservationStatus } from './entities/reservation-status.enum';
import { UserRoles } from '../users/enum/roles';
import { Reservation } from './entities/reservation.entity';

describe('ReservationService', () => {
  let service: ReservationService;
  let dataSource: jest.Mocked<DataSource>;

  const mockDataSource = {
    getRepository: jest.fn(),
    transaction: jest.fn(),
  };

  beforeEach(async () => {
    jest.clearAllMocks();

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        ReservationService,
        { provide: getDataSourceToken(), useValue: mockDataSource },
        { provide: DataSource, useValue: mockDataSource },
      ],
    }).compile();

    service = module.get<ReservationService>(ReservationService);
    dataSource = module.get(DataSource);
    // ensure service.dataSource is our mock
    (service as any).dataSource = mockDataSource;
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });

  describe('validateTransition', () => {
    it('should allow RESERVED -> COMPLETED', () => {
      expect(() =>
        service.validateTransition(
          ReservationStatus.RESERVED,
          ReservationStatus.COMPLETED,
        ),
      ).not.toThrow();
    });
    it('should allow RESERVED -> CANCELLED', () => {
      expect(() =>
        service.validateTransition(
          ReservationStatus.RESERVED,
          ReservationStatus.CANCELLED,
        ),
      ).not.toThrow();
    });
    it('should allow RESERVED -> EXPIRED', () => {
      expect(() =>
        service.validateTransition(
          ReservationStatus.RESERVED,
          ReservationStatus.EXPIRED,
        ),
      ).not.toThrow();
    });
    it('should reject COMPLETED -> CANCELLED with 409', () => {
      expect(() =>
        service.validateTransition(
          ReservationStatus.COMPLETED,
          ReservationStatus.CANCELLED,
        ),
      ).toThrow(ConflictException);
    });
    it('should reject EXPIRED -> COMPLETED', () => {
      expect(() =>
        service.validateTransition(
          ReservationStatus.EXPIRED,
          ReservationStatus.COMPLETED,
        ),
      ).toThrow(ConflictException);
    });
    it('should reject CANCELLED -> RESERVED', () => {
      expect(() =>
        service.validateTransition(
          ReservationStatus.CANCELLED,
          ReservationStatus.RESERVED,
        ),
      ).toThrow(ConflictException);
    });
  });

  function createMockManager(overrides: Record<string, any> = {}) {
    const repos: Record<string, any> = {
      Reservation: {
        create: jest.fn((dto) => ({ ...dto, id: 'res-1' })),
        save: jest.fn(async (e: any) => ({ ...e, id: e.id || 'res-1' })),
        findOne: jest.fn(),
        ...overrides['Reservation'],
      },
      ReservationItem: {
        create: jest.fn((dto) => ({ ...dto, id: 'item-1' })),
        save: jest.fn(async (items: any) => items),
        ...overrides['ReservationItem'],
      },
      Inventory: {
        findOne: jest.fn(),
        ...overrides['Inventory'],
      },
      Order: {
        findOne: jest.fn(),
        ...overrides['Order'],
      },
    };
    const manager = {
      getRepository: jest.fn((entity: any) => {
        const name =
          typeof entity === 'string' ? entity : entity.name || entity;
        if (name === 'Reservation' || name === Reservation.name)
          return repos['Reservation'];
        if (name.includes('ReservationItem') || name === 'ReservationItem')
          return repos['ReservationItem'];
        if (name.includes('Inventory') || name === 'Inventory')
          return repos['Inventory'];
        if (name.includes('Order') || name === 'Order') return repos['Order'];
        // fallback by string key
        return repos[name] || repos['Reservation'];
      }),
    } as unknown as EntityManager;
    return { manager, repos };
  }

  describe('create', () => {
    const userId = 'user-123';
    const inventoryId1 = 'inv-1';
    const inventoryId2 = 'inv-2';

    it('should create with default expiresAt = now+15m', async () => {
      const before = Date.now();
      const { manager, repos } = createMockManager();
      repos['Inventory'].findOne.mockResolvedValue({ id: inventoryId1 });
      // make inventory check pass for second item if any
      repos['Reservation'].findOne.mockResolvedValue({
        id: 'res-1',
        userId,
        status: ReservationStatus.RESERVED,
        items: [],
      });
      // need to mock findByIdInternal: manager.getRepository(Reservation).findOne after save returns reservation with items
      const dto: any = {
        items: [{ inventoryId: inventoryId1, quantity: 2 }],
      };
      const result = await service.create(manager, userId, dto);
      expect(repos['Reservation'].create).toHaveBeenCalled();
      const createdArg = repos['Reservation'].create.mock.calls[0][0];
      expect(createdArg.status).toBe(ReservationStatus.RESERVED);
      expect(createdArg.userId).toBe(userId);
      expect(createdArg.expiresAt).toBeInstanceOf(Date);
      expect(createdArg.expiresAt.getTime()).toBeGreaterThan(
        before + 14 * 60 * 1000,
      );
      expect(createdArg.expiresAt.getTime()).toBeLessThanOrEqual(
        before + 16 * 60 * 1000,
      );
      expect(result).toBeDefined();
    });

    it('should reject past expiresAt with 400', async () => {
      const { manager } = createMockManager();
      const dto: any = {
        expiresAt: new Date(Date.now() - 1000).toISOString(),
        items: [{ inventoryId: inventoryId1, quantity: 1 }],
      };
      await expect(service.create(manager, userId, dto)).rejects.toThrow(
        BadRequestException,
      );
    });

    it('should reject duplicate inventoryId with 400', async () => {
      const { manager } = createMockManager();
      const dto: any = {
        items: [
          { inventoryId: inventoryId1, quantity: 1 },
          { inventoryId: inventoryId1, quantity: 2 },
        ],
      };
      await expect(service.create(manager, userId, dto)).rejects.toThrow(
        BadRequestException,
      );
    });

    it('should reject unknown inventoryId with 404', async () => {
      const { manager, repos } = createMockManager();
      repos['Inventory'].findOne.mockResolvedValue(null);
      const dto: any = {
        items: [{ inventoryId: 'unknown', quantity: 1 }],
      };
      await expect(service.create(manager, userId, dto)).rejects.toThrow(
        NotFoundException,
      );
    });

    it('should reject unknown orderId with 404', async () => {
      const { manager, repos } = createMockManager();
      repos['Order'].findOne.mockResolvedValue(null);
      const dto: any = {
        orderId: 'order-unknown',
        items: [{ inventoryId: inventoryId1, quantity: 1 }],
      };
      await expect(service.create(manager, userId, dto)).rejects.toThrow(
        NotFoundException,
      );
    });

    it('should return RESERVED with items on success', async () => {
      const { manager, repos } = createMockManager();
      repos['Inventory'].findOne.mockResolvedValue({ id: inventoryId1 });
      repos['Reservation'].findOne.mockResolvedValue({
        id: 'res-1',
        userId,
        status: ReservationStatus.RESERVED,
        items: [
          {
            id: 'item-1',
            reservationId: 'res-1',
            inventoryId: inventoryId1,
            quantity: 2,
          },
        ],
      });
      const dto: any = {
        items: [{ inventoryId: inventoryId1, quantity: 2 }],
      };
      const result = await service.create(manager, userId, dto);
      expect(result.status).toBe(ReservationStatus.RESERVED);
      expect(result.items).toHaveLength(1);
    });

    it('should handle future expiresAt supplied', async () => {
      const { manager, repos } = createMockManager();
      repos['Inventory'].findOne.mockResolvedValue({ id: inventoryId1 });
      repos['Reservation'].findOne.mockResolvedValue({
        id: 'res-1',
        userId,
        status: ReservationStatus.RESERVED,
        items: [],
      });
      const future = new Date(Date.now() + 60 * 60 * 1000).toISOString();
      const dto: any = {
        expiresAt: future,
        items: [{ inventoryId: inventoryId1, quantity: 1 }],
      };
      const result = await service.create(manager, userId, dto);
      expect(result).toBeDefined();
      const createdArg = repos['Reservation'].create.mock.calls[0][0];
      expect(createdArg.expiresAt.toISOString()).toBe(future);
    });
  });

  describe('findById', () => {
    it('owner returns reservation', async () => {
      const reservation = {
        id: 'res-1',
        userId: 'user-1',
        status: ReservationStatus.RESERVED,
      } as Reservation;
      mockDataSource.getRepository.mockReturnValue({
        findOne: jest.fn().mockResolvedValue(reservation),
      } as any);
      const result = await service.findById('user-1', 'res-1');
      expect(result).toBe(reservation);
    });

    it('non-owner non-admin throws 403', async () => {
      const reservation = {
        id: 'res-1',
        userId: 'owner-1',
        status: ReservationStatus.RESERVED,
      } as Reservation;
      mockDataSource.getRepository.mockReturnValue({
        findOne: jest.fn().mockResolvedValue(reservation),
      } as any);
      await expect(
        service.findById('other-user', 'res-1', UserRoles.User),
      ).rejects.toThrow(ForbiddenException);
    });

    it('admin can access any reservation', async () => {
      const reservation = {
        id: 'res-1',
        userId: 'owner-1',
        status: ReservationStatus.RESERVED,
      } as Reservation;
      mockDataSource.getRepository.mockReturnValue({
        findOne: jest.fn().mockResolvedValue(reservation),
      } as any);
      const result = await service.findById(
        'admin-id',
        'res-1',
        UserRoles.Admin,
      );
      expect(result).toBe(reservation);
    });

    it('unknown id throws 404', async () => {
      mockDataSource.getRepository.mockReturnValue({
        findOne: jest.fn().mockResolvedValue(null),
      } as any);
      await expect(service.findById('user-1', 'unknown')).rejects.toThrow(
        NotFoundException,
      );
    });
  });

  describe('listByUser', () => {
    it('non-admin returns only own reservations', async () => {
      const repo = {
        findAndCount: jest.fn().mockResolvedValue([[{ id: '1' }], 1]),
      };
      mockDataSource.getRepository.mockReturnValue(repo as any);
      const result = await service.listByUser(
        'user-1',
        { page: 1, limit: 20 },
        undefined,
        UserRoles.User,
      );
      expect(repo.findAndCount).toHaveBeenCalledWith(
        expect.objectContaining({ where: { userId: 'user-1' } }),
      );
      expect(result.meta.totalItems).toBe(1);
    });

    it('admin with userId filter returns filtered', async () => {
      const repo = {
        findAndCount: jest.fn().mockResolvedValue([[], 0]),
      };
      mockDataSource.getRepository.mockReturnValue(repo as any);
      await service.listByUser(
        'admin-id',
        { page: 1, limit: 10 },
        { userId: 'filter-user' },
        UserRoles.Admin,
      );
      expect(repo.findAndCount).toHaveBeenCalledWith(
        expect.objectContaining({ where: { userId: 'filter-user' } }),
      );
    });

    it('pagination meta correct', async () => {
      const repo = {
        findAndCount: jest
          .fn()
          .mockResolvedValue([[{ id: '1' }, { id: '2' }], 5]),
      };
      mockDataSource.getRepository.mockReturnValue(repo as any);
      const result = await service.listByUser(
        'user-1',
        { page: 2, limit: 2 },
        undefined,
        UserRoles.User,
      );
      expect(result.meta).toEqual({
        totalItems: 5,
        itemCount: 2,
        itemsPerPage: 2,
        totalPages: 3,
        currentPage: 2,
      });
    });

    it('limit capped at 100', async () => {
      const repo = {
        findAndCount: jest.fn().mockResolvedValue([[], 0]),
      };
      mockDataSource.getRepository.mockReturnValue(repo as any);
      await service.listByUser('user-1', { page: 1, limit: 200 });
      expect(repo.findAndCount).toHaveBeenCalledWith(
        expect.objectContaining({ take: 100 }),
      );
    });
  });

  describe('transition matrix (complete/cancel)', () => {
    it('RESERVED -> COMPLETED succeeds', async () => {
      const reservation = {
        id: 'res-1',
        userId: 'user-1',
        status: ReservationStatus.RESERVED,
        items: [],
      } as unknown as Reservation;
      const saved = { ...reservation, status: ReservationStatus.COMPLETED };
      const { manager, repos } = createMockManager({
        Reservation: {
          findOne: jest.fn().mockResolvedValue(reservation),
          save: jest.fn().mockResolvedValue(saved),
        },
      });
      const result = await service.complete(manager, 'user-1', 'res-1');
      expect(result.status).toBe(ReservationStatus.COMPLETED);
    });

    it('COMPLETED -> CANCELLED throws 409', async () => {
      const reservation = {
        id: 'res-1',
        userId: 'user-1',
        status: ReservationStatus.COMPLETED,
        items: [],
      } as unknown as Reservation;
      const { manager } = createMockManager({
        Reservation: {
          findOne: jest.fn().mockResolvedValue(reservation),
        },
      });
      await expect(service.cancel(manager, 'user-1', 'res-1')).rejects.toThrow(
        ConflictException,
      );
    });

    it('EXPIRED -> any transition throws 409', async () => {
      const reservation = {
        id: 'res-1',
        userId: 'user-1',
        status: ReservationStatus.EXPIRED,
        items: [],
      } as unknown as Reservation;
      const { manager } = createMockManager({
        Reservation: {
          findOne: jest.fn().mockResolvedValue(reservation),
        },
      });
      await expect(
        service.complete(manager, 'user-1', 'res-1'),
      ).rejects.toThrow(ConflictException);
    });

    it('CANCELLED -> COMPLETED throws 409', async () => {
      const reservation = {
        id: 'res-1',
        userId: 'user-1',
        status: ReservationStatus.CANCELLED,
        items: [],
      } as unknown as Reservation;
      const { manager } = createMockManager({
        Reservation: {
          findOne: jest.fn().mockResolvedValue(reservation),
        },
      });
      await expect(
        service.complete(manager, 'user-1', 'res-1'),
      ).rejects.toThrow(ConflictException);
    });

    it('complete with valid orderId sets it', async () => {
      const reservation = {
        id: 'res-1',
        userId: 'user-1',
        status: ReservationStatus.RESERVED,
        items: [],
        orderId: null,
      } as unknown as Reservation;
      const { manager, repos } = createMockManager({
        Reservation: {
          findOne: jest.fn().mockResolvedValue(reservation),
          save: jest.fn().mockImplementation(async (e: any) => e),
        },
        Order: {
          findOne: jest.fn().mockResolvedValue({ id: 'order-1' }),
        },
      });
      const result = await service.complete(manager, 'user-1', 'res-1', {
        orderId: 'order-1',
      });
      expect(result.orderId).toBe('order-1');
    });

    it('complete with invalid orderId throws 404', async () => {
      const reservation = {
        id: 'res-1',
        userId: 'user-1',
        status: ReservationStatus.RESERVED,
        items: [],
      } as unknown as Reservation;
      const { manager } = createMockManager({
        Reservation: {
          findOne: jest.fn().mockResolvedValue(reservation),
        },
        Order: {
          findOne: jest.fn().mockResolvedValue(null),
        },
      });
      await expect(
        service.complete(manager, 'user-1', 'res-1', {
          orderId: 'bad-order',
        }),
      ).rejects.toThrow(NotFoundException);
    });

    it('expire succeeds from RESERVED', async () => {
      const reservation = {
        id: 'res-1',
        status: ReservationStatus.RESERVED,
      } as Reservation;
      const { manager } = createMockManager({
        Reservation: {
          findOne: jest.fn().mockResolvedValue(reservation),
          save: jest.fn().mockImplementation(async (e: any) => ({
            ...e,
            status: ReservationStatus.EXPIRED,
          })),
        },
      });
      const result = await service.expire(manager, 'res-1');
      expect(result.status).toBe(ReservationStatus.EXPIRED);
    });

    it('expire fails if already COMPLETED', async () => {
      const reservation = {
        id: 'res-1',
        status: ReservationStatus.COMPLETED,
      } as Reservation;
      const { manager } = createMockManager({
        Reservation: {
          findOne: jest.fn().mockResolvedValue(reservation),
        },
      });
      await expect(service.expire(manager, 'res-1')).rejects.toThrow(
        ConflictException,
      );
    });
  });
});
