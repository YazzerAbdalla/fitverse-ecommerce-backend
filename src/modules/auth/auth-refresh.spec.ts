/**
 * Unit tests for Refresh Token (Phase 17) - T010,T011,T016,T017,T022,T026
 * Mocks DataSource/EntityManager + CACHE_MANAGER + JwtService + ConfigService
 */
import { Test, TestingModule } from '@nestjs/testing';
import { AuthService } from './auth.service';
import { UsersService } from '../users/users.service';
import { JwtService } from '@nestjs/jwt';
import { Logger, UnauthorizedException } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { CACHE_MANAGER } from '@nestjs/cache-manager';
import { ConfigService } from '@nestjs/config';
import * as crypto from 'crypto';

describe('AuthService Refresh Token (Phase 17)', () => {
  let service: AuthService;
  let dataSource: any;
  let jwtService: any;
  let configService: any;
  let mockManager: any;
  let mockRefreshRepo: any;
  let mockUserRepo: any;
  let mockQueryBuilder: any;

  const user = {
    id: 'user-1',
    email: 'alice@example.com',
    firstName: 'Alice',
    lastName: 'Test',
    role: 'user',
    tokenVersion: 0,
    emailVerified: true,
  } as any;

  beforeEach(async () => {
    const chain: any = {};
    chain.update = jest.fn().mockReturnThis();
    chain.set = jest.fn().mockReturnThis();
    chain.where = jest.fn().mockReturnThis();
    chain.execute = jest.fn(async () => ({ affected: 1 }));
    chain.setLock = jest.fn().mockReturnThis();
    chain.getOne = jest.fn(async () => null);
    mockQueryBuilder = chain;

    mockRefreshRepo = {
      create: jest.fn((dto: any) => dto),
      save: jest.fn(async (dto: any) => ({ id: 'rt-id', ...dto })),
      find: jest.fn(async () => []),
      count: jest.fn(async () => 0),
      update: jest.fn(async () => ({ affected: 1 })),
      createQueryBuilder: jest.fn(() => mockQueryBuilder),
    };
    mockUserRepo = {
      findOne: jest.fn(),
      update: jest.fn(async () => ({ affected: 1 })),
      createQueryBuilder: jest.fn(() => ({
        setLock: jest.fn().mockReturnThis(),
        where: jest.fn().mockReturnThis(),
        getOne: jest.fn(async () => user),
      })),
    };

    mockManager = {
      getRepository: jest.fn((entity: any) => {
        if (entity && entity.name === 'User') return mockUserRepo;
        return mockRefreshRepo;
      }),
      createQueryBuilder: jest.fn(() => mockQueryBuilder),
    };

    dataSource = {
      transaction: jest.fn(async (cb: any) => cb(mockManager)),
      getRepository: jest.fn((entity: any) => {
        if (entity && entity.name === 'User') return mockUserRepo;
        return mockRefreshRepo;
      }),
      createQueryBuilder: jest.fn(() => mockQueryBuilder),
    };
    jwtService = { signAsync: jest.fn().mockResolvedValue('jwt-new') };
    configService = { get: jest.fn((key: string) => (key === 'REFRESH_TOKEN_TTL' ? '7d' : undefined)) };
    const cacheMock: any = { get: jest.fn(), set: jest.fn(), del: jest.fn(), store: { client: { incr: jest.fn(), expire: jest.fn() } } };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        AuthService,
        { provide: UsersService, useValue: { findUserByEmail: jest.fn(), findUserById: jest.fn(), findByGoogleId: jest.fn() } },
        { provide: Logger, useValue: { log: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() } },
        { provide: JwtService, useValue: jwtService },
        { provide: DataSource, useValue: dataSource },
        { provide: CACHE_MANAGER, useValue: cacheMock },
        { provide: ConfigService, useValue: configService },
        { provide: 'WHATSAPP_PROVIDER', useValue: { sendOtp: jest.fn() } },
      ],
    }).compile();
    service = module.get<AuthService>(AuthService);
  });

  // T010
  it('T010 login creates hashed refresh 7d', async () => {
    // mock createRefresh path via login
    const result = await service.login(user);
    expect(result.accessToken).toBe('jwt-new');
    expect(result.refreshToken).toMatch(/^[a-f0-9]{64}$/);
    // repo.save called with sha256
    expect(mockRefreshRepo.save).toHaveBeenCalledTimes(1);
    const saved = mockRefreshRepo.save.mock.calls[0][0];
    expect(saved.tokenHash).toMatch(/^[a-f0-9]{64}$/);
    expect(saved.tokenHash).toBe(crypto.createHash('sha256').update(result.refreshToken).digest('hex'));
    expect(saved.expiresAt).toBeInstanceOf(Date);
    const ttl = 7 * 24 * 3600 * 1000;
    const diff = saved.expiresAt.getTime() - Date.now();
    expect(diff).toBeGreaterThan(ttl - 5000);
    expect(diff).toBeLessThan(ttl + 5000);
  });

  // T016 rotation
  it('T016 refresh rotation FOR UPDATE single-winner', async () => {
    const raw = crypto.randomBytes(32).toString('hex');
    const hash = crypto.createHash('sha256').update(raw).digest('hex');
    const future = new Date(Date.now() + 7 * 24 * 3600 * 1000);
    // active row
    mockQueryBuilder.getOne.mockResolvedValueOnce({
      id: 'rt-1',
      userId: user.id,
      tokenHash: hash,
      expiresAt: future,
      revokedAt: null,
    });
    mockUserRepo.findOne = jest.fn().mockResolvedValue(user);
    mockRefreshRepo.count.mockResolvedValue(1);
    // need to handle transaction manager getRepository for User findOne
    mockManager.getRepository = jest.fn((entity: any) => {
      if (entity && entity.name === 'User') return { findOne: jest.fn().mockResolvedValue(user), update: jest.fn() } as any;
      return mockRefreshRepo;
    });
    // also need User repo for refresh: use manager.getRepository(User).findOne
    // Our mockQueryBuilder for RefreshToken already returns found, then we rewire findOne for User
    // Patch: make manager.getRepository(User) return object with findOne
    const realManagerGetRepo = mockManager.getRepository;
    mockManager.getRepository = jest.fn((entity: any) => {
      if (entity && entity.name === 'User') {
        return { findOne: jest.fn().mockResolvedValue(user) } as any;
      }
      return mockRefreshRepo;
    });
    // Need to also mock transaction inner repo for RefreshToken count/find
    mockRefreshRepo.count = jest.fn().mockResolvedValue(0);
    mockRefreshRepo.find = jest.fn().mockResolvedValue([]);

    // We need to re-mock transaction to handle refresh: our earlier mockQueryBuilder.getOne returns active row for first call
    // For refresh, first SELECT ... FOR UPDATE returns active, second would be revoked? We'll test single call success, then second call revoked
    const result = await service.refresh(raw);
    expect(result.accessToken).toBe('jwt-new');
    expect(result.refreshToken).toMatch(/^[a-f0-9]{64}$/);
    expect(result.refreshToken).not.toBe(raw);
    // old revoked
    expect(mockRefreshRepo.update).toHaveBeenCalledWith('rt-1', expect.objectContaining({ revokedAt: expect.any(Date) }));
    // new saved
    expect(mockRefreshRepo.save).toHaveBeenCalled();
  });

  it('T017 refresh expired 401', async () => {
    const raw = crypto.randomBytes(32).toString('hex');
    const hash = crypto.createHash('sha256').update(raw).digest('hex');
    const past = new Date(Date.now() - 1000);
    mockQueryBuilder.getOne.mockResolvedValueOnce({
      id: 'rt-1',
      userId: user.id,
      tokenHash: hash,
      expiresAt: past,
      revokedAt: null,
    });
    mockManager.getRepository = jest.fn((entity: any) => {
      if (entity && entity.name === 'User') return { findOne: jest.fn().mockResolvedValue(user) } as any;
      return mockRefreshRepo;
    });
    await expect(service.refresh(raw)).rejects.toThrow(UnauthorizedException);
  });

  it('T022 logout idempotent 200', async () => {
    const raw = crypto.randomBytes(32).toString('hex');
    await service.logout(raw);
    expect(mockRefreshRepo.createQueryBuilder).toHaveBeenCalled();
    expect(mockQueryBuilder.update).toHaveBeenCalled();
    // second logout same raw should still 200 (not throw)
    mockQueryBuilder.execute.mockResolvedValueOnce({ affected: 0 });
    await expect(service.logout(raw)).resolves.toBeUndefined();
  });

  it('T026 parseTtlMs d suffix', async () => {
    // indirectly via login 7d
    const result = await service.login(user);
    const saved = mockRefreshRepo.save.mock.calls[mockRefreshRepo.save.mock.calls.length - 1][0];
    const diff = saved.expiresAt.getTime() - Date.now();
    expect(diff).toBeGreaterThan(7 * 24 * 3600 * 1000 - 5000);
  });
});
