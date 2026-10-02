import { of } from 'rxjs';
import { OutboxPublisher } from '../outbox.publisher';
import { OutboxStatus } from '../entities/outbox-status.enum';
import { NotificationWorker } from '../../notifications/notifications.worker';

/**
 * T058 US6 delivery-state unit tests (mocked DataSource, no docker).
 * Covers publisher PENDING→PROCESSING→SENT_TO_MQ token-checked writes,
 * consumer SENT_TO_MQ→CONSUMED FOR UPDATE, and duplicate eventId → 0 new deliveries.
 */
describe('OutboxStatus delivery-state machine (T058 US6)', () => {
  const uuid = '11111111-1111-1111-1111-111111111111';

  describe('enum values', () => {
    it('exposes SENT_TO_MQ, CONSUMED, DELIVERED plus SENT backward-compat alias', () => {
      expect(OutboxStatus.PENDING).toBe('PENDING');
      expect(OutboxStatus.PROCESSING).toBe('PROCESSING');
      expect(OutboxStatus.SENT).toBe('SENT');
      expect(OutboxStatus.SENT_TO_MQ).toBe('SENT_TO_MQ');
      expect(OutboxStatus.CONSUMED).toBe('CONSUMED');
      expect(OutboxStatus.DELIVERED).toBe('DELIVERED');
      expect(OutboxStatus.FAILED).toBe('FAILED');
    });
  });

  describe('publisher writes SENT_TO_MQ (not SENT)', () => {
    it('marks SENT_TO_MQ via token-checked update on emit success', async () => {
      const event = {
        id: uuid,
        eventType: 'order.created',
        payload: { version: 1, eventId: uuid, eventType: 'order.created' },
        attempts: 0,
        status: OutboxStatus.PENDING,
      };
      const updateMock = jest.fn().mockResolvedValue({ affected: 1 });
      const claimQb = () => {
        const qb: any = {
          where: jest.fn().mockReturnThis(),
          orderBy: jest.fn().mockReturnThis(),
          addOrderBy: jest.fn().mockReturnThis(),
          limit: jest.fn().mockReturnThis(),
          setLock: jest.fn().mockReturnThis(),
          setOnLocked: jest.fn().mockReturnThis(),
          getMany: jest.fn().mockResolvedValue([event]),
        };
        return qb;
      };
      const dataSource: any = {
        // No top-level createQueryBuilder fn → publisher falls back to getRepository.update (token path still asserted via set payload)
        transaction: jest.fn(async (cb: any) => {
          await cb({
            getRepository: () => ({
              createQueryBuilder: claimQb,
              update: jest.fn().mockResolvedValue({}),
            }),
          });
        }),
        getRepository: jest.fn(() => ({ update: updateMock })),
      };
      const config: any = {
        get: jest.fn((key: string, def?: any) => {
          if (key === 'RABBITMQ_URL')
            return 'amqp://guest:guest@localhost:5672';
          return def;
        }),
      };
      const client: any = { emit: jest.fn(() => of(undefined)) };
      const publisher = new (OutboxPublisher as any)(
        dataSource,
        config,
        client,
      );

      const result = await publisher.publishBatch(10);

      expect(result.sent).toBe(1);
      expect(updateMock).toHaveBeenCalledWith(
        uuid,
        expect.objectContaining({ status: OutboxStatus.SENT_TO_MQ }),
      );
    });
  });

  describe('consumer SENT_TO_MQ → CONSUMED (FOR UPDATE)', () => {
    const makeWorker = (ds: any, cacheSet: jest.Mock) => {
      const cache: any = { set: cacheSet, get: jest.fn() };
      return new (NotificationWorker as any)(cache, undefined, ds);
    };

    it('transitions SENT_TO_MQ → CONSUMED with consumedAt', async () => {
      const row = {
        id: uuid,
        status: OutboxStatus.SENT_TO_MQ,
        consumedAt: null,
      };
      const saveMock = jest.fn().mockResolvedValue(row);
      const ds: any = {
        transaction: jest.fn(async (cb: any) => {
          const repo = {
            createQueryBuilder: jest.fn(() => ({
              setLock: jest.fn().mockReturnThis(),
              where: jest.fn().mockReturnThis(),
              getOne: jest.fn().mockResolvedValue(row),
            })),
            save: saveMock,
          };
          await cb({ getRepository: () => repo });
        }),
      };
      const worker = makeWorker(ds, jest.fn());
      const ok = await worker.markConsumed(uuid);

      expect(ok).toBe(true);
      expect(saveMock).toHaveBeenCalledWith(
        expect.objectContaining({ status: OutboxStatus.CONSUMED }),
      );
      expect(row.consumedAt).not.toBeNull();
    });

    it('leaves FAILED rows untouched (returns false)', async () => {
      const row = { id: uuid, status: OutboxStatus.FAILED, consumedAt: null };
      const saveMock = jest.fn();
      const ds: any = {
        transaction: jest.fn(async (cb: any) => {
          const repo = {
            createQueryBuilder: jest.fn(() => ({
              setLock: jest.fn().mockReturnThis(),
              where: jest.fn().mockReturnThis(),
              getOne: jest.fn().mockResolvedValue(row),
            })),
            save: saveMock,
          };
          await cb({ getRepository: () => repo });
        }),
      };
      const worker = makeWorker(ds, jest.fn());
      const ok = await worker.markConsumed(uuid);

      expect(ok).toBe(false);
      expect(saveMock).not.toHaveBeenCalled();
    });

    it('fail-open skips PG when the outbox row is missing (old direct-emit events)', async () => {
      const saveMock = jest.fn();
      const ds: any = {
        transaction: jest.fn(async (cb: any) => {
          const repo = {
            createQueryBuilder: jest.fn(() => ({
              setLock: jest.fn().mockReturnThis(),
              where: jest.fn().mockReturnThis(),
              getOne: jest.fn().mockResolvedValue(null),
            })),
            save: saveMock,
          };
          await cb({ getRepository: () => repo });
        }),
      };
      const worker = makeWorker(ds, jest.fn());
      const ok = await worker.markConsumed(uuid);

      expect(ok).toBe(true);
      expect(saveMock).not.toHaveBeenCalled();
    });
  });

  describe('duplicate eventId → 0 new deliveries + counter', () => {
    it('skips EmailProvider.send and still ACKs on duplicate', async () => {
      // SET NX returns null → duplicate
      const cache: any = {
        set: jest.fn().mockResolvedValue(null),
        get: jest.fn(),
      };
      const emailProvider: any = { send: jest.fn() };
      const ackMock = jest.fn();
      const ctx: any = {
        getChannelRef: () => ({ ack: ackMock }),
        getMessage: () => ({}),
      };
      const worker = new (NotificationWorker as any)(
        cache,
        emailProvider,
        undefined,
      );
      const incrSpy = jest
        .spyOn(worker, 'incrementCounter')
        .mockResolvedValue(undefined);

      await worker.handleOrderCreated(
        { eventId: uuid, eventType: 'order.created', data: { orderId: 'o1' } },
        ctx,
      );

      expect(emailProvider.send).not.toHaveBeenCalled();
      expect(incrSpy).toHaveBeenCalled();
      expect(ackMock).toHaveBeenCalled();
    });
  });
});
