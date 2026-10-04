import { Test, TestingModule } from '@nestjs/testing';
import { UsersService } from './users.service';
import { getRepositoryToken } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import User from './entity/user.entity';

describe('UsersService', () => {
  let service: UsersService;
  let userRepo: Record<string, jest.Mock>;

  beforeEach(async () => {
    userRepo = {
      findOne: jest.fn(),
      save: jest.fn(),
      update: jest.fn(),
      increment: jest.fn(),
      createQueryBuilder: jest.fn(),
    };
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        UsersService,
        {
          provide: getRepositoryToken(User),
          useValue: userRepo,
        },
        {
          provide: DataSource,
          useValue: { transaction: jest.fn() },
        },
      ],
    }).compile();

    service = module.get<UsersService>(UsersService);
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });

  it('finders thread an optional manager repository (US2)', async () => {
    const row = { id: 'u1' };
    userRepo.findOne.mockResolvedValue(row);
    await expect(service.findUserByEmail('a@b.c')).resolves.toBe(row);
    await expect(service.findUserById('u1')).resolves.toBe(row);
    await expect(service.findByGoogleId('g1')).resolves.toBe(row);
    await expect(service.findUserByPhone('+2010')).resolves.toBe(row);

    const managerRepo = { findOne: jest.fn().mockResolvedValue(row) };
    const manager: any = {
      getRepository: jest.fn().mockReturnValue(managerRepo),
    };
    await expect(service.findUserById('u1', manager)).resolves.toBe(row);
    expect(manager.getRepository).toHaveBeenCalled();
    expect(managerRepo.findOne).toHaveBeenCalledWith({ where: { id: 'u1' } });
  });

  it('findUserByIdForUpdate locks the row (US2)', async () => {
    const getOne = jest.fn().mockResolvedValue({ id: 'u1' });
    const qb: any = {
      setLock: jest.fn().mockReturnThis(),
      where: jest.fn().mockReturnThis(),
      getOne,
    };
    const manager: any = {
      getRepository: jest
        .fn()
        .mockReturnValue({ createQueryBuilder: () => qb }),
    };
    await expect(service.findUserByIdForUpdate(manager, 'u1')).resolves.toEqual(
      {
        id: 'u1',
      },
    );
    expect(qb.setLock).toHaveBeenCalledWith('pessimistic_write');
  });

  it('updatePassword honors explicit version or increments (US2)', async () => {
    await service.updatePassword('u1', 'hash', 7);
    expect(userRepo.update).toHaveBeenCalledWith('u1', {
      password: 'hash',
      tokenVersion: 7,
    });
    await service.updatePassword('u1', 'hash2', undefined, {
      passwordChangedAt: new Date('2026-01-01'),
    });
    const [, second] = userRepo.update.mock.calls[1];
    expect(second.password).toBe('hash2');
    expect(typeof second.tokenVersion).toBe('function');
    expect(second.passwordChangedAt).toEqual(new Date('2026-01-01'));
  });

  it('flag/link writers delegate to update (US2)', async () => {
    await service.setEmailVerified('u1');
    expect(userRepo.update).toHaveBeenCalledWith('u1', {
      emailVerified: true,
    });
    await service.setPhoneVerified('u1');
    expect(userRepo.update).toHaveBeenCalledWith('u1', {
      phoneVerified: true,
    });
    await service.linkGoogleAccount('u1', 'g1');
    expect(userRepo.update).toHaveBeenCalledWith(
      'u1',
      expect.objectContaining({ googleId: 'g1' }),
    );
  });

  it('incrementTokenVersion increments with optional stamp (US2)', async () => {
    await service.incrementTokenVersion('u1');
    const [, first] = userRepo.update.mock.calls[0];
    expect(typeof first.tokenVersion).toBe('function');
    expect(first.passwordChangedAt).toBeUndefined();
    await service.incrementTokenVersion('u1', {
      passwordChangedAt: new Date('2026-02-02'),
    });
    const [, second] = userRepo.update.mock.calls[1];
    expect(second.passwordChangedAt).toEqual(new Date('2026-02-02'));
  });

  it('findUserByEmailForUpdate locks by email (B3)', async () => {
    const getOne = jest.fn().mockResolvedValue({ id: 'u1' });
    const qb: any = {
      setLock: jest.fn().mockReturnThis(),
      where: jest.fn().mockReturnThis(),
      getOne,
    };
    const manager: any = {
      getRepository: jest
        .fn()
        .mockReturnValue({ createQueryBuilder: () => qb }),
    };
    await expect(
      service.findUserByEmailForUpdate(manager, 'a@b.c'),
    ).resolves.toEqual({ id: 'u1' });
    expect(qb.setLock).toHaveBeenCalledWith('pessimistic_write');
    expect(qb.where).toHaveBeenCalledWith('u.email = :email', {
      email: 'a@b.c',
    });
  });

  it('issueEmailVerificationToken overwrites the three columns (B3)', async () => {
    const repoUpdate = jest.fn();
    const manager: any = {
      getRepository: jest.fn().mockReturnValue({ update: repoUpdate }),
    };
    const exp = new Date('2026-03-03');
    await service.issueEmailVerificationToken(
      manager,
      'u1',
      'h'.repeat(64),
      exp,
    );
    expect(manager.getRepository).toHaveBeenCalled();
    expect(repoUpdate).toHaveBeenCalledWith('u1', {
      emailVerificationTokenHash: 'h'.repeat(64),
      emailVerificationExpiresAt: exp,
      emailVerificationUsedAt: null,
    });
  });

  it('consumeEmailVerificationToken sets usedAt + verified flag (B3)', async () => {
    const repoUpdate = jest.fn();
    const manager: any = {
      getRepository: jest.fn().mockReturnValue({ update: repoUpdate }),
    };
    const now = new Date('2026-04-04');
    await service.consumeEmailVerificationToken(manager, 'u1', now);
    expect(repoUpdate).toHaveBeenCalledWith('u1', {
      emailVerificationUsedAt: now,
      emailVerified: true,
    });
  });
});
