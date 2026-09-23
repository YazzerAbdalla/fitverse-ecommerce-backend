import { OutboxService } from '../outbox.service';
import { OutboxStatus } from '../entities/outbox-status.enum';

describe('OutboxService', () => {
  let service: OutboxService;

  beforeEach(() => {
    service = new OutboxService();
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });

  it('should create event with eventId==id, version:1 and correlationId via manager mock', async () => {
    const mockSave = jest.fn(async (e: any) => e);
    const mockRepo = { create: jest.fn((v: any) => v), save: mockSave } as any;
    const manager = { getRepository: jest.fn(() => mockRepo) } as any;

    const result = await service.createEvent(manager, {
      eventType: 'order.created',
      aggregateType: 'Order',
      aggregateId: '11111111-1111-1111-1111-111111111111',
      payload: {
        version: 1,
        eventType: 'order.created',
        correlationId: 'corr-1',
        orderId: '1111',
        userId: 'u1',
        total: 100,
      },
      correlationId: 'corr-1',
    });

    expect(mockRepo.save).toHaveBeenCalled();
    const saved = mockSave.mock.calls[0][0];
    expect(saved.id).toBeDefined();
    expect(saved.payload.eventId).toBe(saved.id);
    expect(saved.payload.version).toBe(1);
    expect(saved.payload.correlationId).toBe('corr-1');
    expect(saved.status).toBe(OutboxStatus.PENDING);
    expect(saved.attempts).toBe(0);
    expect(result).toBeDefined();
  });

  it('should generate correlationId if not provided', async () => {
    const mockRepo = {
      create: jest.fn((v: any) => v),
      save: jest.fn(async (e: any) => e),
    } as any;
    const manager = { getRepository: jest.fn(() => mockRepo) } as any;

    const result = await service.createEvent(manager, {
      eventType: 'order.completed',
      aggregateType: 'Order',
      aggregateId: '22222222-2222-2222-2222-222222222222',
      payload: { version: 1, eventType: 'order.completed', orderId: '2222' },
    });

    expect(result.payload.correlationId).toBeDefined();
    expect(result.payload.eventId).toBe(result.id);
  });
});
