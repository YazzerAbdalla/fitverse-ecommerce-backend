import { ForbiddenException, NotFoundException } from '@nestjs/common';
import { NotificationsController } from '../notifications.controller';
import { UserRoles } from '../../users/enum/roles';

/**
 * T061 US7 history/unread unit tests (mocked repository via DataSource, no docker).
 * Covers GET /notifications pagination meta, unread-count, PATCH :id/read owner vs 403, and read-all counts.
 */
describe('NotificationsController history (T061 US7)', () => {
  let controller: NotificationsController;
  let repo: any;
  let dataSource: any;
  let notificationService: any;
  let emailChannel: any;
  let configService: any;

  const owner = { sub: 'user-1', role: UserRoles.User, fullName: 'User One' };
  const other = { sub: 'user-2', role: UserRoles.User, fullName: 'User Two' };
  const admin = { sub: 'admin-1', role: UserRoles.Admin, fullName: 'Admin' };

  beforeEach(() => {
    repo = {
      findAndCount: jest.fn(),
      count: jest.fn(),
      findOne: jest.fn(),
      save: jest.fn(),
    };
    dataSource = {
      getRepository: jest.fn(() => repo),
      createQueryBuilder: jest.fn(),
      transaction: jest.fn(async (cb: any) =>
        cb({ getRepository: () => repo }),
      ),
    };
    notificationService = { sendSalesCampaign: jest.fn() };
    emailChannel = { send: jest.fn() };
    configService = { get: jest.fn(() => 'noop') };
    controller = new NotificationsController(
      notificationService,
      emailChannel,
      configService,
      dataSource,
    );
  });

  it('GET /notifications returns paginated data + meta', async () => {
    const rows = [{ id: 'n1' }, { id: 'n2' }];
    repo.findAndCount.mockResolvedValue([rows, 2]);

    const result = await controller.listHistory({ page: 1, limit: 20 }, owner);

    expect(result.data).toEqual(rows);
    expect(result.meta).toEqual({
      totalItems: 2,
      itemCount: 2,
      itemsPerPage: 20,
      totalPages: 1,
      currentPage: 1,
    });
    expect(repo.findAndCount).toHaveBeenCalledWith(
      expect.objectContaining({ take: 20, skip: 0 }),
    );
  });

  it('GET /notifications/unread-count returns {unreadCount}', async () => {
    repo.count.mockResolvedValue(3);

    const result = await controller.unreadCount(owner);

    expect(result).toEqual({ unreadCount: 3 });
    expect(repo.count).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ isRead: false }),
      }),
    );
  });

  it('PATCH :id/read marks owner row read (FOR UPDATE) and is idempotent', async () => {
    const row = { id: 'n1', userId: 'user-1', isRead: false, readAt: null };
    repo.findOne.mockResolvedValue(row);
    repo.save.mockImplementation(async (r: any) => r);

    const first = await controller.markRead('n1', owner);
    expect(first.isRead).toBe(true);
    expect(first.readAt).not.toBeNull();

    // Second read keeps the original readAt (idempotent 200)
    const readAt = first.readAt;
    const second = await controller.markRead('n1', owner);
    expect(second.isRead).toBe(true);
    expect(second.readAt).toEqual(readAt);
  });

  it('PATCH :id/read throws 403 for another non-Admin user', async () => {
    repo.findOne.mockResolvedValue({
      id: 'n1',
      userId: 'user-1',
      isRead: false,
    });

    await expect(
      controller.markRead('n1', other as any),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('PATCH :id/read allows Admin on another inbox and 404 when missing', async () => {
    repo.findOne.mockResolvedValue({
      id: 'n1',
      userId: 'user-1',
      isRead: true,
      readAt: new Date(),
    });
    repo.save.mockImplementation(async (r: any) => r);
    const result = await controller.markRead('n1', admin);
    expect(result.isRead).toBe(true);

    repo.findOne.mockResolvedValue(null);
    await expect(
      controller.markRead('missing', owner as any),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it('PATCH read-all returns {updated:n} via single UPDATE', async () => {
    const execute = jest.fn().mockResolvedValue({ affected: 3 });
    const where = jest.fn().mockReturnThis();
    const set = jest.fn().mockReturnThis();
    dataSource.createQueryBuilder.mockReturnValue({
      update: jest.fn().mockReturnThis(),
      set,
      where,
      execute,
    });

    const result = await controller.readAll(owner);

    expect(result).toEqual({ updated: 3 });
    expect(set).toHaveBeenCalledWith(expect.objectContaining({ isRead: true }));
  });

  it('GET /notifications throws 403 when non-Admin scopes another userId', async () => {
    await expect(
      controller.listHistory({ userId: 'user-9' } as any, other as any),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(repo.findAndCount).not.toHaveBeenCalled();
  });

  it('POST test-email delegates to EmailChannel and echoes provider', async () => {
    emailChannel.send.mockResolvedValue({
      messageId: 'noop-123',
      delivered: true,
    });
    configService.get.mockReturnValue('resend');

    const result = await controller.sendTestEmail({ to: 'you@example.com' });

    expect(result).toEqual({
      to: 'you@example.com',
      provider: 'resend',
      messageId: 'noop-123',
      delivered: true,
    });
    expect(emailChannel.send).toHaveBeenCalledWith(
      expect.objectContaining({
        to: 'you@example.com',
        template: 'test',
      }),
    );
  });
});
