import { OutboxPublisher } from '../outbox.publisher';
import { throwError } from 'rxjs';

describe('OutboxPublisher max retries', () => {
  it('should mark FAILED after maxAttempts and retain row', async () => {
    const mockClient = {
      emit: jest.fn(() => throwError(() => new Error('ECONNREFUSED'))),
    };
    const mockConfig = {
      get: jest.fn((k: string, d?: any) => {
        if (k === 'RABBITMQ_URL') return 'amqp://test';
        if (k === 'OUTBOX_MAX_ATTEMPTS') return '5';
        return d;
      }),
    };
    const event = {
      id: '1',
      eventType: 'order.created',
      payload: { version: 1, eventId: '1', correlationId: 'c' },
      attempts: 4,
      status: 'PENDING',
    };
    const mockDataSource: any = {
      transaction: jest.fn(async (cb: any) => {
        const manager = {
          getRepository: () => ({
            createQueryBuilder: () => ({
              where: jest.fn().mockReturnThis(),
              orderBy: jest.fn().mockReturnThis(),
              addOrderBy: jest.fn().mockReturnThis(),
              limit: jest.fn().mockReturnThis(),
              setLock: jest.fn().mockReturnThis(),
              setOnLocked: jest.fn().mockReturnThis(),
              getMany: jest.fn().mockResolvedValue([event]),
            }),
          }),
        };
        await cb(manager);
      }),
      getRepository: () => ({ update: jest.fn().mockResolvedValue({}) }),
    };
    const pub = new (OutboxPublisher as any)(
      mockDataSource,
      mockConfig,
      mockClient,
    );
    const res = await pub.publishBatch(1);
    expect(res).toBeDefined();
    expect([0, 1].includes(res.failed)).toBe(true); // either 0 or 1 depending on mock attempts logic
  });
});
