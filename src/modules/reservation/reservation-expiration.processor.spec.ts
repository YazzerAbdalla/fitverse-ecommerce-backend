import { Test } from '@nestjs/testing';
import { getQueueToken } from '@nestjs/bullmq';
import { ConfigService } from '@nestjs/config';
import { ReservationExpirationProcessor } from './reservation-expiration.processor';
import { ReservationExpirationService } from './reservation-expiration.service';

describe('ReservationExpirationProcessor (unit)', () => {
  let processor: ReservationExpirationProcessor;
  let mockQueue: any;
  let mockService: any;
  let mockConfig: any;

  beforeEach(async () => {
    mockQueue = {
      add: jest.fn().mockResolvedValue({}),
      getRepeatableJobs: jest.fn().mockResolvedValue([]),
      removeRepeatableByKey: jest.fn(),
    };
    mockService = {
      processExpiredBatch: jest.fn().mockResolvedValue({
        scanned: 0,
        expired: 0,
        skipped: 0,
        failed: 0,
        retried: 0,
      }),
    };
    mockConfig = { get: jest.fn((k: string, d: any) => d) };

    const module = await Test.createTestingModule({
      providers: [
        ReservationExpirationProcessor,
        {
          provide: getQueueToken('reservation-expiration'),
          useValue: mockQueue,
        },
        { provide: ReservationExpirationService, useValue: mockService },
        { provide: ConfigService, useValue: mockConfig },
        // Redis tick lock is optional — provide mock for processor redis client
        {
          provide: 'REDIS_CLIENT',
          useValue: {
            set: jest.fn().mockResolvedValue('OK'),
            del: jest.fn(),
            get: jest.fn(),
          },
        },
      ],
    }).compile();
    processor = module.get(ReservationExpirationProcessor);
  });

  it('should be defined', () => {
    expect(processor).toBeDefined();
  });

  it('process skips when disabled', async () => {
    mockConfig.get = jest.fn((k: string) =>
      k === 'EXPIRATION_ENABLED' ? 'false' : 'true',
    );
    const res = await processor.process({
      name: 'reservation-expiration-tick',
    } as any);
    expect(res.scanned).toBe(0);
  });

  it('process skips overlapping', async () => {
    (processor as any).processing = true;
    const res = await processor.process({
      name: 'reservation-expiration-tick',
    } as any);
    expect(res.skippedOverlapping).toBe(true);
    (processor as any).processing = false;
  });
});
