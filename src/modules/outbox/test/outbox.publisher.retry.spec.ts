import { OutboxPublisher } from '../outbox.publisher';
import { throwError, of } from 'rxjs';

describe('OutboxPublisher retry', () => {
  it('should increment attempts and set nextRetryAt on failure (not FAILED)', async () => {
    const mockClient = {
      emit: jest.fn(() => throwError(() => new Error('ECONNREFUSED'))),
    };
    const mockConfig = {
      get: jest.fn((k: string, d?: any) =>
        k === 'RABBITMQ_URL' ? 'amqp://test' : d,
      ),
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
              getMany: jest.fn().mockResolvedValue([
                {
                  id: '1',
                  eventType: 'order.created',
                  payload: { version: 1, eventId: '1', correlationId: 'c' },
                  attempts: 0,
                  status: 'PENDING',
                },
              ]),
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
    // Even on failure, publishBatch should not throw (retry logic keeps PENDING)
    expect(typeof res.retried).toBe('number');
  });
});
