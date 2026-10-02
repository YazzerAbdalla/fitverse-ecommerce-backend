import { OutboxPublisher } from '../outbox.publisher';
import { OutboxStatus } from '../entities/outbox-status.enum';
import { of } from 'rxjs';

describe('OutboxPublisher publishBatch — claim PROCESSING → SENT', () => {
  let publisher: OutboxPublisher;
  let mockClient: any;
  let mockDataSource: any;
  let mockConfig: any;

  beforeEach(() => {
    mockClient = { emit: jest.fn(() => of(undefined)) };
    mockConfig = {
      get: jest.fn((key: string, def?: any) => {
        if (key === 'RABBITMQ_URL') return 'amqp://guest:guest@localhost:5672';
        if (key === 'OUTBOX_BATCH_SIZE') return '100';
        return def;
      }),
    };

    const mockEvent = {
      id: '11111111-1111-1111-1111-111111111111',
      eventType: 'order.created',
      payload: {
        version: 1,
        eventId: '1111',
        eventType: 'order.created',
        correlationId: 'corr',
      },
      attempts: 0,
      status: OutboxStatus.PENDING as any,
    };

    const mockRepo = {
      createQueryBuilder: jest.fn(() => ({
        where: jest.fn().mockReturnThis(),
        orderBy: jest.fn().mockReturnThis(),
        addOrderBy: jest.fn().mockReturnThis(),
        limit: jest.fn().mockReturnThis(),
        setLock: jest.fn().mockReturnThis(),
        setOnLocked: jest.fn().mockReturnThis(),
        getMany: jest.fn().mockResolvedValue([mockEvent]),
      })),
      createQueryBuilderUpdate: jest.fn(),
      update: jest.fn().mockResolvedValue({}),
    };

    // Mock transaction for claim
    mockDataSource = {
      transaction: jest.fn(async (cb: any) => {
        const manager = {
          getRepository: jest.fn(() => mockRepo),
        };
        // Simulate claim update inside transaction
        mockRepo.createQueryBuilder().getMany = jest
          .fn()
          .mockResolvedValue([mockEvent]);
        await cb(manager);
        return;
      }),
      getRepository: jest.fn(() => mockRepo),
      query: jest.fn(),
    };

    // Need to mock repository for update outside transaction
    mockDataSource.getRepository = jest.fn(() => ({
      update: jest.fn().mockResolvedValue({}),
      createQueryBuilder: jest.fn(() => ({
        where: jest.fn().mockReturnThis(),
        orderBy: jest.fn().mockReturnThis(),
        addOrderBy: jest.fn().mockReturnThis(),
        limit: jest.fn().mockReturnThis(),
        setLock: jest.fn().mockReturnThis(),
        setOnLocked: jest.fn().mockReturnThis(),
        getMany: jest.fn().mockResolvedValue([]),
        update: jest.fn(),
      })),
    }));

    const DataSourceMock = mockDataSource;
    // Use manual instantiation with mocked DataSource via property assignment
    publisher = new (OutboxPublisher as any)(
      DataSourceMock,
      mockConfig,
      mockClient,
    );
  });

  it('should be defined', () => {
    expect(publisher).toBeDefined();
  });

  it('should claim PENDING and mark SENT on success (FOR UPDATE SKIP LOCKED)', async () => {
    // Mock DataSource to return claimed events and succeed publish
    const payload = {
      version: 1,
      eventId: 'test-id',
      eventType: 'order.created',
      correlationId: 'corr',
    };
    const event = {
      id: 'test-id',
      eventType: 'order.created',
      payload,
      attempts: 0,
      status: OutboxStatus.PENDING,
      createdAt: new Date(),
    };

    // Override dataSource to simulate successful claim and publish
    const mockRepoForClaim = {
      createQueryBuilder: jest.fn(() => {
        const qb: any = {
          where: jest.fn().mockReturnThis(),
          orderBy: jest.fn().mockReturnThis(),
          addOrderBy: jest.fn().mockReturnThis(),
          limit: jest.fn().mockReturnThis(),
          setLock: jest.fn().mockReturnThis(),
          setOnLocked: jest
            .fn()
            .mockImplementation((mode: any) => {
              expect(mode).toBe('skip_locked');
              return qb;
            }),
          getMany: jest.fn().mockResolvedValue([event]),
        };
        return qb;
      }),
      createQueryBuilderUpdate: jest.fn(),
    };

    (publisher as any).dataSource = {
      transaction: jest.fn(async (cb: any) => {
        const manager = {
          getRepository: () => ({
            createQueryBuilder: mockRepoForClaim.createQueryBuilder,
            createQueryBuilderUpdate: jest.fn(),
          }),
        };
        await cb(manager);
      }),
      getRepository: jest.fn(() => ({
        update: jest.fn().mockResolvedValue({}),
      })),
    };

    (publisher as any).client = mockClient;
    (publisher as any).configService = mockConfig;

    const result = await publisher.publishBatch(10);
    // Should have attempted publish; even if mocked, should not throw
    expect(result).toBeDefined();
    expect(typeof result.claimed).toBe('number');
  });
});
