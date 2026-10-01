import { Test, TestingModule } from '@nestjs/testing';
import {
  BadRequestException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import { getQueueToken } from '@nestjs/bullmq';
import { DataSource } from 'typeorm';
import { NotificationService } from '../notification.service';
import { UserRoles } from '../../users/enum/roles';

describe('NotificationService (T036 US4)', () => {
  let service: NotificationService;
  let queue: { add: jest.Mock };
  let dataSource: { getRepository: jest.Mock };
  let productRepo: { find: jest.Mock };

  const admin = { sub: 'admin-1', role: UserRoles.Admin, fullName: 'Admin' };
  const customer = { sub: 'user-1', role: UserRoles.User, fullName: 'User' };

  beforeEach(async () => {
    queue = { add: jest.fn().mockResolvedValue({ id: 'job-1' }) };
    productRepo = { find: jest.fn().mockResolvedValue([]) };
    dataSource = { getRepository: jest.fn().mockReturnValue(productRepo) };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        NotificationService,
        { provide: getQueueToken('notification'), useValue: queue },
        { provide: DataSource, useValue: dataSource },
      ],
    }).compile();

    service = module.get<NotificationService>(NotificationService);
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });

  it('enqueues notification.sendBulk with campaignId jobId for Admin', async () => {
    const dto = { title: 'Sale -20%', body: 'All week' } as any;

    const { jobId } = await service.sendSalesCampaign(dto, admin);

    expect(jobId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
    );
    expect(queue.add).toHaveBeenCalledTimes(1);
    expect(queue.add).toHaveBeenCalledWith(
      'notification.sendBulk',
      expect.objectContaining({
        campaignId: jobId,
        template: 'sales',
        subject: 'Sale -20%',
        body: 'All week',
      }),
      expect.objectContaining({
        jobId,
        attempts: 3,
        backoff: { type: 'exponential', delay: 1000 },
      }),
    );
  });

  it('rejects non-Admin with 403 and enqueues nothing', async () => {
    await expect(
      service.sendSalesCampaign(
        { title: 'Sale', body: 'x' } as any,
        customer as any,
      ),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(queue.add).not.toHaveBeenCalled();
  });

  it('rejects missing actor with 403 and enqueues nothing', async () => {
    await expect(
      service.sendSalesCampaign(
        { title: 'Sale', body: 'x' } as any,
        undefined as any,
      ),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(queue.add).not.toHaveBeenCalled();
  });

  it('rejects empty title with 400 and enqueues nothing', async () => {
    await expect(
      service.sendSalesCampaign({ title: '', body: 'x' } as any, admin as any),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(queue.add).not.toHaveBeenCalled();
  });

  it('rejects over-long title with 400 and enqueues nothing', async () => {
    await expect(
      service.sendSalesCampaign(
        { title: 't'.repeat(201), body: 'x' } as any,
        admin as any,
      ),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(queue.add).not.toHaveBeenCalled();
  });

  it('rejects unknown productIds with 404 and enqueues nothing', async () => {
    productRepo.find.mockResolvedValueOnce([]);
    await expect(
      service.sendSalesCampaign(
        { title: 'Sale', body: 'x', productIds: ['missing-id'] } as any,
        admin as any,
      ),
    ).rejects.toBeInstanceOf(NotFoundException);
    expect(queue.add).not.toHaveBeenCalled();
  });

  it('enqueues when all productIds exist', async () => {
    productRepo.find.mockResolvedValueOnce([{ id: 'p-1' }]);
    const { jobId } = await service.sendSalesCampaign(
      { title: 'Sale', body: 'x', productIds: ['p-1'] },
      admin,
    );
    expect(jobId).toBeDefined();
    expect(queue.add).toHaveBeenCalledTimes(1);
  });

  it('onProductCreated enqueues notification.new_product', async () => {
    await service.onProductCreated({ id: 'p-1', name: 'Prod', price: 100 });
    expect(queue.add).toHaveBeenCalledTimes(1);
    expect(queue.add).toHaveBeenCalledWith(
      'notification.new_product',
      expect.objectContaining({ productId: 'p-1' }),
      expect.objectContaining({ attempts: 3 }),
    );
  });

  it('onProductCreated never throws (fire-and-forget)', async () => {
    queue.add.mockRejectedValueOnce(new Error('Redis down'));
    await expect(
      service.onProductCreated({ id: 'p-1' }),
    ).resolves.toBeUndefined();
  });
});
