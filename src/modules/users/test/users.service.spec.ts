import { Test, TestingModule } from '@nestjs/testing';
import { BadRequestException, NotFoundException } from '@nestjs/common';
import { getRepositoryToken } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { UsersService } from '../users.service';
import User from '../entity/user.entity';

describe('UsersService.updatePreferences (T046 US5)', () => {
  let service: UsersService;
  let userRepo: { findOne: jest.Mock; save: jest.Mock };
  let manager: { getRepository: jest.Mock };
  let dataSource: { transaction: jest.Mock };

  const mockUser = (overrides: Partial<User> = {}): User =>
    ({
      id: 'user-1',
      email: 'u@test.com',
      marketingOptIn: false,
      emailOptIn: true,
      ...overrides,
    }) as User;

  beforeEach(async () => {
    userRepo = {
      findOne: jest.fn(),
      save: jest.fn((u) => Promise.resolve(u)),
    };
    manager = { getRepository: jest.fn().mockReturnValue(userRepo) };
    dataSource = {
      transaction: jest.fn((cb: (m: unknown) => unknown) => cb(manager)),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        UsersService,
        { provide: getRepositoryToken(User), useValue: userRepo },
        { provide: DataSource, useValue: dataSource },
      ],
    }).compile();

    service = module.get<UsersService>(UsersService);
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });

  it('updates marketingOptIn false->true with FOR UPDATE lock', async () => {
    userRepo.findOne.mockResolvedValueOnce(mockUser());

    const result = await service.updatePreferences('user-1', {
      marketingOptIn: true,
    });

    expect(manager.getRepository).toHaveBeenCalledWith(User);
    // FOR UPDATE serializes concurrent PATCH for the same user
    expect(userRepo.findOne).toHaveBeenCalledWith({
      where: { id: 'user-1' },
      lock: { mode: 'pessimistic_write' },
    });
    expect(userRepo.save).toHaveBeenCalledWith(
      expect.objectContaining({ marketingOptIn: true }),
    );
    expect(result).toEqual({ marketingOptIn: true, emailOptIn: true });
  });

  it('updates emailOptIn only, leaving marketingOptIn untouched', async () => {
    userRepo.findOne.mockResolvedValueOnce(mockUser());

    const result = await service.updatePreferences('user-1', {
      emailOptIn: false,
    });

    expect(result).toEqual({ marketingOptIn: false, emailOptIn: false });
  });

  it('updates both flags at once', async () => {
    userRepo.findOne.mockResolvedValueOnce(mockUser());

    const result = await service.updatePreferences('user-1', {
      marketingOptIn: true,
      emailOptIn: false,
    });

    expect(result).toEqual({ marketingOptIn: true, emailOptIn: false });
  });

  it('rejects empty payload with 400 before any transaction', async () => {
    await expect(
      service.updatePreferences('user-1', {}),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(dataSource.transaction).not.toHaveBeenCalled();
  });

  it('rejects unknown user with 404', async () => {
    userRepo.findOne.mockResolvedValueOnce(null);
    await expect(
      service.updatePreferences('user-1', { marketingOptIn: true }),
    ).rejects.toBeInstanceOf(NotFoundException);
    expect(userRepo.save).not.toHaveBeenCalled();
  });
});
