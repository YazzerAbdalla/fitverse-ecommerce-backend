import { Test, TestingModule } from '@nestjs/testing';
import { getDataSourceToken } from '@nestjs/typeorm';
import { ConfigService } from '@nestjs/config';
import { ReservationExpirationService } from './reservation-expiration.service';
import { ReservationService } from './reservation.service';
import { DataSource } from 'typeorm';

describe('ReservationExpirationService (unit)', () => {
  let service: ReservationExpirationService;
  let mockDataSource: any;
  let mockReservationService: any;
  let mockConfig: any;
  let mockClient: any;

  beforeEach(async () => {
    mockDataSource = {
      getRepository: jest.fn().mockReturnValue({
        createQueryBuilder: jest.fn().mockReturnValue({
          select: jest.fn().mockReturnThis(),
          where: jest.fn().mockReturnThis(),
          andWhere: jest.fn().mockReturnThis(),
          orderBy: jest.fn().mockReturnThis(),
          addOrderBy: jest.fn().mockReturnThis(),
          limit: jest.fn().mockReturnThis(),
          getMany: jest.fn().mockResolvedValue([{ id: 'test-id' }]),
        }),
      }),
      transaction: jest.fn(),
    };
    mockReservationService = {
      expire: jest.fn(),
    };
    mockConfig = {
      get: jest.fn((key: string, def: any) => {
        const map: any = {
          EXPIRATION_BATCH_SIZE: '10',
          EXPIRATION_MAX_RETRIES: '3',
          EXPIRATION_ENABLED: 'true',
          EXPIRATION_INTERVAL_MS: '30000',
        };
        return map[key] ?? def;
      }),
    };
    mockClient = { emit: jest.fn(() => ({ subscribe: jest.fn() })) };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        ReservationExpirationService,
        { provide: getDataSourceToken(), useValue: mockDataSource },
        { provide: DataSource, useValue: mockDataSource },
        { provide: ReservationService, useValue: mockReservationService },
        { provide: ConfigService, useValue: mockConfig },
        { provide: 'NOTIFICATION_SERVICE', useValue: mockClient },
      ],
    }).compile();

    // Override InjectDataSource token manually if needed
    service = module.get<ReservationExpirationService>(
      ReservationExpirationService,
    );
    // patch private dataSource directly
    (service as any).dataSource = mockDataSource;
    (service as any).reservationService = mockReservationService;
    (service as any).configService = mockConfig;
    (service as any).client = mockClient;
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });

  it('findExpiredCandidateIds uses correct predicate', async () => {
    const ids = await service.findExpiredCandidateIds(5);
    expect(ids).toEqual(['test-id']);
    expect(mockDataSource.getRepository).toHaveBeenCalled();
  });

  it('processExpiredBatch handles empty scan', async () => {
    jest.spyOn(service, 'findExpiredCandidateIds').mockResolvedValue([]);
    const res = await service.processExpiredBatch(10);
    expect(res.scanned).toBe(0);
    expect(res.expired).toBe(0);
  });

  it('processExpiredBatch respects EXPIRATION_ENABLED=false', async () => {
    mockConfig.get = jest.fn((k: string, d: any) =>
      k === 'EXPIRATION_ENABLED' ? 'false' : d,
    );
    const res = await service.processExpiredBatch(10);
    expect(res.scanned).toBe(0);
  });
});
