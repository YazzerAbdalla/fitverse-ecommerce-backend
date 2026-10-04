import { Test, TestingModule } from '@nestjs/testing';
import { AuthService } from './auth.service';
import { VerificationCooldownError } from './verification-cooldown.error';
import { UsersService } from '../users/users.service';
import { RefreshTokenStore } from './stores/refresh-token.store';
import { PasswordResetTokenStore } from './stores/password-reset-token.store';
import { OtpStore } from './stores/otp.store';
import { AuthEventPublisher } from './auth-event.publisher';
import { SystemClock } from '../../common/clock';
import { AUTH_TOKEN_CONFIG } from './auth-token.config';
import { JwtService } from '@nestjs/jwt';
import { BadRequestException, ConflictException, Logger } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { CACHE_MANAGER } from '@nestjs/cache-manager';
import { ConfigService } from '@nestjs/config';
import * as crypto from 'crypto';
import * as bcrypt from 'bcrypt';
import { validate } from 'class-validator';
import { plainToInstance } from 'class-transformer';
import { ResetPasswordDto } from './dto/reset-password.dto';
import { ValidateResetTokenDto } from './dto/validate-reset-token.dto';
import { UserRegisterDto } from './dto/user-register.dto';

// Keep original smoke test and extend with T014/T015
describe('AuthService', () => {
  let service: AuthService;
  let usersService: Record<string, jest.Mock>;
  let jwtService: Record<string, jest.Mock>;
  let dataSource: Record<string, jest.Mock>;
  let cacheManager: Record<string, jest.Mock>;
  let configService: Record<string, jest.Mock>;
  let logger: Record<string, jest.Mock>;
  let eventPublisher: Record<string, jest.Mock>;

  // transaction helpers
  let mockManager: any;
  let mockTokenRepo: any;
  let mockUserRepo: any;
  let mockQueryBuilder: any;
  let mockCreateQueryBuilder: jest.Mock;
  // Locked user row returned by the findUserByEmailForUpdate fake (per-test).
  let lockedVerificationUser: any;

  beforeEach(async () => {
    // chained QB for invalidate priors / FOR UPDATE
    const chain: any = {};
    chain.update = jest.fn().mockReturnThis();
    chain.set = jest.fn().mockReturnThis();
    chain.where = jest.fn().mockReturnThis();
    chain.execute = jest.fn(async () => ({ affected: 1 }));
    chain.setLock = jest.fn().mockReturnThis();
    chain.getOne = jest.fn(async () => null);
    mockQueryBuilder = chain;

    mockCreateQueryBuilder = jest.fn(() => mockQueryBuilder);

    mockTokenRepo = {
      create: jest.fn((dto: any) => dto),
      save: jest.fn(async (dto: any) => ({ id: 'tok-id', ...dto })),
      findOne: jest.fn(),
      update: jest.fn(async () => ({ affected: 1 })),
      createQueryBuilder: jest.fn(() => mockQueryBuilder),
    };
    mockUserRepo = {
      update: jest.fn(async () => ({ affected: 1 })),
    };

    mockManager = {
      getRepository: jest.fn((entity: any) => {
        // crude: if entity name contains User -> user repo else token
        if (entity && entity.name === 'User') return mockUserRepo;
        // PasswordResetToken or others
        return mockTokenRepo;
      }),
      createQueryBuilder: mockCreateQueryBuilder,
    };

    usersService = {
      findUserByEmail: jest.fn(),
      createNewUser: jest.fn(),
      findUserById: jest.fn(),
      findByGoogleId: jest.fn(),
      findUserByIdForUpdate: jest.fn(),
      updatePassword: jest.fn(),
      incrementTokenVersion: jest.fn(),
      setEmailVerified: jest.fn(),
      setPhoneVerified: jest.fn(),
      findUserByPhone: jest.fn(),
      linkGoogleAccount: jest.fn(),
      // Folded verification intents (B3): thin fakes through the mocked
      // manager so call-shape assertions hold; real SQL proven on PG.
      findUserByEmailForUpdate: jest.fn(async (manager: any, email: string) =>
        lockedVerificationUser?.email === email ? lockedVerificationUser : null,
      ),
      issueEmailVerificationToken: jest.fn(
        async (manager: any, userId: string, hash: string, exp: Date) => {
          await manager.getRepository({ name: 'User' }).update(userId, {
            emailVerificationTokenHash: hash,
            emailVerificationExpiresAt: exp,
            emailVerificationUsedAt: null,
          });
        },
      ),
      consumeEmailVerificationToken: jest.fn(
        async (manager: any, userId: string, now: Date) => {
          await manager.getRepository({ name: 'User' }).update(userId, {
            emailVerificationUsedAt: now,
            emailVerified: true,
          });
        },
      ),
    };
    jwtService = { signAsync: jest.fn().mockResolvedValue('token') };
    logger = {
      log: jest.fn(),
      error: jest.fn(),
      debug: jest.fn(),
      warn: jest.fn(),
    };
    cacheManager = { get: jest.fn(), set: jest.fn(), del: jest.fn() };
    configService = { get: jest.fn().mockReturnValue('15m') };
    eventPublisher = { emit: jest.fn() };
    dataSource = {
      transaction: jest.fn(async (cb: any) => cb(mockManager)),
      getRepository: jest.fn((entity: any) => {
        if (entity && entity.name === 'User') return mockUserRepo;
        return mockTokenRepo;
      }),
      createQueryBuilder: jest.fn(),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        AuthService,
        { provide: UsersService, useValue: usersService },
        { provide: Logger, useValue: logger },
        { provide: JwtService, useValue: jwtService },
        { provide: DataSource, useValue: dataSource },
        { provide: CACHE_MANAGER, useValue: cacheManager },
        { provide: ConfigService, useValue: configService },
        {
          provide: 'WHATSAPP_PROVIDER',
          useValue: {
            sendOtp: jest.fn().mockResolvedValue({ messageId: 'test' }),
          },
        },
        {
          provide: RefreshTokenStore,
          useValue: {
            findByHashForUpdate: jest.fn(),
            revokeById: jest.fn(),
            countActive: jest.fn(),
            findOldestActive: jest.fn(),
            create: jest.fn(),
            revokeByHashWhereActive: jest.fn(),
            revokeAllActive: jest.fn(),
            revokeAllInTx: jest.fn(),
            purgeExpired: jest.fn(),
          },
        },
        // Functional fakes (US3): mirror the real stores through the mocked
        // repos/manager so existing repo-level assertions keep proving the
        // same SQL shapes; real behavior is proven by token-races on PG.
        {
          provide: PasswordResetTokenStore,
          useValue: {
            issue: jest.fn(
              async (
                manager: any,
                userId: string,
                tokenHash: string,
                expiresAt: Date,
              ) => {
                await manager
                  .createQueryBuilder()
                  .update('PasswordResetToken')
                  .set({ usedAt: new Date() })
                  .where(
                    'userId = :userId AND "usedAt" IS NULL AND "expiresAt" > NOW()',
                    { userId },
                  )
                  .execute();
                const repo = manager.getRepository('PasswordResetToken');
                await repo.save(
                  repo.create({ userId, tokenHash, expiresAt, usedAt: null }),
                );
              },
            ),
            findAdvisory: jest.fn(async (tokenHash: string, userId: string) =>
              dataSource
                .getRepository('PasswordResetToken')
                .findOne({ where: { tokenHash, userId } }),
            ),
            findForUpdate: jest.fn(
              async (manager: any, tokenHash: string, userId: string) =>
                manager
                  .getRepository('PasswordResetToken')
                  .createQueryBuilder('t')
                  .setLock('pessimistic_write')
                  .where('t.tokenHash = :tokenHash AND t.userId = :userId', {
                    tokenHash,
                    userId,
                  })
                  .getOne(),
            ),
            consume: jest.fn(
              async (manager: any, token: any, userId: string) => {
                const repo = manager.getRepository('PasswordResetToken');
                await repo.update(token.id, { usedAt: new Date() });
                await manager
                  .createQueryBuilder()
                  .update('PasswordResetToken')
                  .set({ usedAt: new Date() })
                  .where(
                    'userId = :userId AND id != :id AND "usedAt" IS NULL',
                    { userId, id: token.id },
                  )
                  .execute();
              },
            ),
          },
        },
        {
          provide: OtpStore,
          useValue: { issueOtp: jest.fn(), verifyAttempt: jest.fn() },
        },
        { provide: AuthEventPublisher, useValue: eventPublisher },
        { provide: SystemClock, useValue: { now: () => new Date() } },
        {
          provide: AUTH_TOKEN_CONFIG,
          useValue: {
            refreshTokenTtlMs: 7 * 24 * 3600_000,
            refreshCookieName: 'refresh_token',
            refreshCookieSecure: false,
            resetTokenTtlMs: 15 * 60_000,
            emailVerificationTtlMs: 24 * 3600_000,
            otpTtlMs: 5 * 60_000,
            otpMaxAttempts: 3,
            otpResendCooldownMs: 60_000,
          },
        },
      ],
    }).compile();

    service = module.get<AuthService>(AuthService);
    // reset test hooks + locked-row fake
    service.lastRawToken = undefined;
    service.lastVerificationToken = undefined;
    lockedVerificationUser = null;
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });

  // ===================== T014: requestPasswordReset anti-enum =====================
  describe('requestPasswordReset (T014 anti-enum)', () => {
    const user = { id: 'user-1', email: 'alice@example.com' } as any;

    it('existing email creates sha256 tokenHash 64 hex, expiresAt ~15m, invalidates priors', async () => {
      usersService.findUserByEmail.mockResolvedValue(user);
      const before = Date.now();
      await service.requestPasswordReset('alice@example.com');
      const after = Date.now();

      expect(usersService.findUserByEmail).toHaveBeenCalledWith(
        'alice@example.com',
      );
      expect(dataSource.transaction).toHaveBeenCalledTimes(1);
      // invalidates priors called via createQueryBuilder
      expect(mockCreateQueryBuilder).toHaveBeenCalled();
      expect(mockQueryBuilder.update).toHaveBeenCalled();
      expect(mockQueryBuilder.set).toHaveBeenCalledWith(
        expect.objectContaining({ usedAt: expect.any(Date) }),
      );
      expect(mockQueryBuilder.where).toHaveBeenCalledWith(
        expect.stringContaining('userId'),
        expect.objectContaining({ userId: user.id }),
      );
      expect(mockQueryBuilder.execute).toHaveBeenCalled();

      // token saved
      expect(mockTokenRepo.create).toHaveBeenCalledTimes(1);
      expect(mockTokenRepo.save).toHaveBeenCalledTimes(1);
      const created = mockTokenRepo.create.mock.calls[0][0];
      expect(created.userId).toBe(user.id);
      expect(created.tokenHash).toBeDefined();
      expect(created.tokenHash).toMatch(/^[a-f0-9]{64}$/);
      expect(created.usedAt).toBeNull();
      expect(created.expiresAt).toBeInstanceOf(Date);
      // expiresAt ~15m = 900000ms
      const ttl = 15 * 60 * 1000;
      expect(created.expiresAt.getTime()).toBeGreaterThanOrEqual(
        before + ttl - 2000,
      );
      expect(created.expiresAt.getTime()).toBeLessThanOrEqual(
        after + ttl + 2000,
      );

      // lastRawToken captured, hash matches
      expect(service.lastRawToken).toBeDefined();
      const raw = service.lastRawToken!;
      expect(raw).toMatch(/^[a-f0-9]{64}$/); // randomBytes 32 -> 64 hex
      const expectedHash = crypto
        .createHash('sha256')
        .update(raw)
        .digest('hex');
      expect(created.tokenHash).toBe(expectedHash);
      expect(created.tokenHash).not.toBe(raw);

      // timingSafeEqual sanity: hash comparison via crypto.timingSafeEqual should succeed
      const bufA = Buffer.from(created.tokenHash, 'utf8');
      const bufB = Buffer.from(expectedHash, 'utf8');
      expect(crypto.timingSafeEqual(bufA, bufB)).toBe(true);
      // hash never equals raw
      if (raw.length === expectedHash.length) {
        const bufRaw = Buffer.from(raw, 'utf8');
        // they should differ; if length same, timingSafeEqual would be false unless collision
        expect(crypto.timingSafeEqual(bufA, bufRaw)).toBe(false);
      }
    });

    it('non-existing email still returns 200 (no token, no leak)', async () => {
      usersService.findUserByEmail.mockResolvedValue(null);
      await expect(
        service.requestPasswordReset('nobody@example.com'),
      ).resolves.toBeUndefined();
      expect(logger.debug).toHaveBeenCalledWith(
        expect.stringContaining('nobody@example.com'),
      );
      expect(dataSource.transaction).not.toHaveBeenCalled();
      expect(mockTokenRepo.save).not.toHaveBeenCalled();
      expect(service.lastRawToken).toBeUndefined();
    });

    it('tokenHash never stores raw token and is sha256', async () => {
      usersService.findUserByEmail.mockResolvedValue(user);
      await service.requestPasswordReset(user.email);
      const raw = service.lastRawToken!;
      const savedHash = mockTokenRepo.create.mock.calls[0][0]
        .tokenHash as string;
      expect(savedHash).not.toContain(raw);
      expect(savedHash.length).toBe(64);
      // direct hash verification
      expect(savedHash).toBe(
        crypto.createHash('sha256').update(raw).digest('hex'),
      );
      // also verify raw not persisted anywhere in repo.save payload
      const saveArg = mockTokenRepo.save.mock.calls[0][0];
      expect(JSON.stringify(saveArg)).not.toContain(raw);
    });

    it('invalidates prior active tokens before inserting new one (order)', async () => {
      usersService.findUserByEmail.mockResolvedValue(user);
      const order: string[] = [];
      mockQueryBuilder.execute.mockImplementation(async () => {
        order.push('invalidate');
        return { affected: 1 };
      });
      mockTokenRepo.save.mockImplementation(async (x: any) => {
        order.push('save');
        return x;
      });
      await service.requestPasswordReset(user.email);
      expect(order).toEqual(['invalidate', 'save']);
    });
  });

  // ===================== T015: validateResetToken & resetPassword =====================
  describe('validateResetToken (T015)', () => {
    const user = { id: 'user-1', email: 'alice@example.com' } as any;
    const rawToken = 'a'.repeat(64);
    const tokenHash = crypto
      .createHash('sha256')
      .update(rawToken)
      .digest('hex');
    const future = new Date(Date.now() + 10 * 60 * 1000);
    const past = new Date(Date.now() - 10 * 60 * 1000);

    beforeEach(() => {
      usersService.findUserByEmail.mockResolvedValue(user);
    });

    it('returns user on valid unexpired unused token', async () => {
      mockTokenRepo.findOne.mockResolvedValue({
        id: 'tok-1',
        tokenHash,
        userId: user.id,
        expiresAt: future,
        usedAt: null,
      });
      const result = await service.validateResetToken(user.email, rawToken);
      expect(result).toEqual(user);
      expect(mockTokenRepo.findOne).toHaveBeenCalledWith({
        where: { tokenHash, userId: user.id },
      });
    });

    it('throws 400 on expired token', async () => {
      mockTokenRepo.findOne.mockResolvedValue({
        id: 'tok-1',
        tokenHash,
        userId: user.id,
        expiresAt: past,
        usedAt: null,
      });
      await expect(
        service.validateResetToken(user.email, rawToken),
      ).rejects.toThrow(BadRequestException);
      await expect(
        service.validateResetToken(user.email, rawToken),
      ).rejects.toThrow('Invalid or expired token');
    });

    it('throws 400 on already used token', async () => {
      mockTokenRepo.findOne.mockResolvedValue({
        id: 'tok-1',
        tokenHash,
        userId: user.id,
        expiresAt: future,
        usedAt: new Date(),
      });
      await expect(
        service.validateResetToken(user.email, rawToken),
      ).rejects.toThrow(BadRequestException);
    });

    it('throws 400 on wrong token', async () => {
      mockTokenRepo.findOne.mockResolvedValue(null);
      await expect(
        service.validateResetToken(user.email, 'wrong-token'),
      ).rejects.toThrow(BadRequestException);
    });

    it('throws 400 when user not found (anti-enum still 400 for validate)', async () => {
      usersService.findUserByEmail.mockResolvedValue(null);
      await expect(
        service.validateResetToken('nobody@example.com', rawToken),
      ).rejects.toThrow(BadRequestException);
    });
  });

  describe('resetPassword (T015)', () => {
    const user = { id: 'user-1', email: 'alice@example.com' } as any;
    const rawToken = crypto.randomBytes(32).toString('hex');
    const tokenHash = crypto
      .createHash('sha256')
      .update(rawToken)
      .digest('hex');
    const future = new Date(Date.now() + 10 * 60 * 1000);
    const past = new Date(Date.now() - 60 * 1000);

    beforeEach(() => {
      usersService.findUserByEmail.mockResolvedValue(user);
      // clear previous calls on shared mocks between tests in this describe
      mockUserRepo.update.mockClear();
      mockTokenRepo.update.mockClear();
      mockQueryBuilder.setLock.mockClear();
      mockQueryBuilder.where.mockClear();
      mockQueryBuilder.execute.mockClear();
      mockQueryBuilder.getOne.mockClear();
    });

    function mockTransactionToken(tokenRow: any) {
      mockQueryBuilder.getOne.mockResolvedValue(tokenRow);
      // transaction will call manager.getRepository then createQueryBuilder('t').setLock().where().getOne()
      // already mocked chain.getOne
    }

    it('success: bcrypt 10 + tokenVersion increment + usedAt', async () => {
      const tokenRow = {
        id: 'tok-1',
        tokenHash,
        userId: user.id,
        expiresAt: future,
        usedAt: null,
      };
      mockTransactionToken(tokenRow);

      await service.resetPassword({
        email: user.email,
        token: rawToken,
        newPassword: 'NewStrong123!',
      });

      // FOR UPDATE used
      expect(mockQueryBuilder.setLock).toHaveBeenCalledWith(
        'pessimistic_write',
      );
      expect(mockQueryBuilder.where).toHaveBeenCalledWith(
        expect.stringContaining('tokenHash'),
        expect.objectContaining({ tokenHash, userId: user.id }),
      );
      // bcrypt 10 rounds: real hash starts with $2b$10$ (cost 10).
      // US2: the password write goes through UsersService.updatePassword —
      // assert on that boundary (same hash + increment + stamp, same tx).
      expect(usersService.updatePassword).toHaveBeenCalledWith(
        user.id,
        expect.any(String),
        undefined,
        expect.objectContaining({
          passwordChangedAt: expect.any(Date),
        }),
      );
      const [uid, hash] = usersService.updatePassword.mock.calls[0];
      expect(uid).toBe(user.id);
      expect(hash).toMatch(/^\$2[ab]\$10\$/);
      const matches = await bcrypt.compare('NewStrong123!', hash);
      expect(matches).toBe(true);
      // token usedAt set
      expect(mockTokenRepo.update).toHaveBeenCalledWith(tokenRow.id, {
        usedAt: expect.any(Date),
      });
      // invalidate other active tokens
      expect(mockQueryBuilder.execute).toHaveBeenCalled();
      // last calls to where for invalidate contain userId and id !=
      const whereCalls = mockQueryBuilder.where.mock.calls.map(
        (c: any) => c[0] as string,
      );
      expect(whereCalls.some((s: string) => s.includes('id != :id'))).toBe(
        true,
      );
    });

    it('second use of same raw token returns 400', async () => {
      const usedToken = {
        id: 'tok-1',
        tokenHash,
        userId: user.id,
        expiresAt: future,
        usedAt: new Date(),
      };
      mockTransactionToken(usedToken);
      await expect(
        service.resetPassword({
          email: user.email,
          token: rawToken,
          newPassword: 'NewStrong123!',
        }),
      ).rejects.toThrow(BadRequestException);
      await expect(
        service.resetPassword({
          email: user.email,
          token: rawToken,
          newPassword: 'NewStrong123!',
        }),
      ).rejects.toThrow('Invalid or expired token');
      expect(mockUserRepo.update).not.toHaveBeenCalled();
    });

    it('weak password / newPassword===email returns 400', async () => {
      await expect(
        service.resetPassword({
          email: user.email,
          token: rawToken,
          newPassword: user.email,
        }),
      ).rejects.toThrow(BadRequestException);
      await expect(
        service.resetPassword({
          email: user.email,
          token: rawToken,
          newPassword: user.email,
        }),
      ).rejects.toThrow('Password must not equal email');
    });

    it('expired token returns 400', async () => {
      const expired = {
        id: 'tok-1',
        tokenHash,
        userId: user.id,
        expiresAt: past,
        usedAt: null,
      };
      mockTransactionToken(expired);
      await expect(
        service.resetPassword({
          email: user.email,
          token: rawToken,
          newPassword: 'NewStrong123!',
        }),
      ).rejects.toThrow(BadRequestException);
    });

    it('wrong token returns 400', async () => {
      mockTransactionToken(null);
      await expect(
        service.resetPassword({
          email: user.email,
          token: 'wrong',
          newPassword: 'NewStrong123!',
        }),
      ).rejects.toThrow(BadRequestException);
    });

    it('ResetPasswordDto validation rejects weak password <8 and >72 (DTO level)', async () => {
      const dtoWeak = plainToInstance(ResetPasswordDto, {
        email: user.email,
        token: rawToken,
        newPassword: 'short',
      });
      const errorsWeak = await validate(dtoWeak);
      expect(errorsWeak.length).toBeGreaterThan(0);
      const dtoOk = plainToInstance(ResetPasswordDto, {
        email: user.email,
        token: rawToken,
        newPassword: 'LongEnough123!',
      });
      const errorsOk = await validate(dtoOk);
      expect(errorsOk.length).toBe(0);
      const dtoLong = plainToInstance(ResetPasswordDto, {
        email: user.email,
        token: rawToken,
        newPassword: 'a'.repeat(73),
      });
      const errorsLong = await validate(dtoLong);
      expect(errorsLong.length).toBeGreaterThan(0);
    });

    it('A5 token floors: reset/validate DTOs accept 64hex, reject garbage (DTO level)', async () => {
      // Same floor as VerifyEmailDto: Length(64) + hex match.
      const valid = 'b'.repeat(64);
      for (const Dto of [ResetPasswordDto, ValidateResetTokenDto]) {
        const ok = plainToInstance(Dto, {
          email: user.email,
          token: valid,
          ...(Dto === ResetPasswordDto
            ? { newPassword: 'LongEnough123!' }
            : {}),
        });
        expect(await validate(ok)).toEqual([]);
        for (const garbage of [
          'wrong',
          'g'.repeat(64),
          'a'.repeat(63),
          'a'.repeat(65),
        ]) {
          const bad = plainToInstance(Dto, {
            email: user.email,
            token: garbage,
            ...(Dto === ResetPasswordDto
              ? { newPassword: 'LongEnough123!' }
              : {}),
          });
          expect(await validate(bad).then((e) => e.length)).toBeGreaterThan(0);
        }
      }
    });

    it('A5 register floor: password <8 rejected, 8 accepted (DTO level)', async () => {
      // Registration floor matches the reset newPassword floor (8).
      const base = {
        firstName: 'A',
        lastName: 'B',
        email: user.email,
      };
      const weak = plainToInstance(UserRegisterDto, {
        ...base,
        password: 'short7!',
      });
      expect(await validate(weak).then((e) => e.length)).toBeGreaterThan(0);
      const ok = plainToInstance(UserRegisterDto, {
        ...base,
        password: 'LongEnough123!',
      });
      expect(await validate(ok)).toEqual([]);
    });

    it('expired token via validateResetToken path also 400 (integration of both)', async () => {
      // simulate second use after success: token usedAt set
      const tokenRowValid = {
        id: 'tok-1',
        tokenHash,
        userId: user.id,
        expiresAt: future,
        usedAt: null,
      };
      mockTransactionToken(tokenRowValid);
      await service.resetPassword({
        email: user.email,
        token: rawToken,
        newPassword: 'NewStrong123!',
      });
      // now if validate is called with same token, should fail because usedAt
      mockTokenRepo.findOne.mockResolvedValue({
        ...tokenRowValid,
        usedAt: new Date(),
      });
      await expect(
        service.validateResetToken(user.email, rawToken),
      ).rejects.toThrow(BadRequestException);
    });
  });

  // ===================== T019: requestEmailVerification fire-and-forget (US1) =====================
  describe('requestEmailVerification (T019 US1)', () => {
    const user = {
      id: 'user-1',
      email: 'alice@example.com',
      emailVerified: false,
    } as any;

    beforeEach(() => {
      dataSource.transaction.mockClear();
      mockUserRepo.update.mockClear();
      usersService.issueEmailVerificationToken.mockClear();
      cacheManager.get.mockResolvedValue(undefined);
      cacheManager.set.mockResolvedValue(undefined);
    });

    // Folded contract (B4): the method takes the already-loaded User and
    // overwrites its verification columns via UsersService — no token table,
    // no lookup, no anti-enum here (resend owns anti-enum, T027 below).
    it('issues for the given user → 1 tx + UsersService.issue with 64hex hash + 24h + hook + emit once', async () => {
      const emitSpy = eventPublisher.emit;
      const before = Date.now();
      await service.requestEmailVerification({ ...user });
      const after = Date.now();

      expect(dataSource.transaction).toHaveBeenCalledTimes(1);
      // Single live-token overwrite on the user row
      expect(usersService.issueEmailVerificationToken).toHaveBeenCalledTimes(1);
      const [managerArg, issuedUserId, issuedHash, issuedExp] =
        usersService.issueEmailVerificationToken.mock.calls[0];
      expect(managerArg).toBe(mockManager);
      expect(issuedUserId).toBe(user.id);
      expect(issuedHash).toMatch(/^[a-f0-9]{64}$/);
      // expiresAt ~24h from tokenConfig
      const ttl = 24 * 3600 * 1000;
      expect(issuedExp.getTime()).toBeGreaterThanOrEqual(before + ttl - 5000);
      expect(issuedExp.getTime()).toBeLessThanOrEqual(after + ttl + 5000);
      expect(mockUserRepo.update).toHaveBeenCalledWith(
        user.id,
        expect.objectContaining({
          emailVerificationTokenHash: issuedHash,
          emailVerificationExpiresAt: issuedExp,
          emailVerificationUsedAt: null,
        }),
      );
      // test hook captures raw, hash matches sha256(raw)
      const raw = service.lastVerificationToken!;
      expect(raw).toMatch(/^[a-f0-9]{64}$/);
      expect(issuedHash).toBe(
        crypto.createHash('sha256').update(raw).digest('hex'),
      );
      // emit after commit exactly once; service never calls EmailProvider.send directly
      expect(emitSpy).toHaveBeenCalledTimes(1);
      expect(emitSpy).toHaveBeenCalledWith(
        'email.verification_requested',
        expect.objectContaining({
          userId: user.id,
          email: user.email,
          rawToken: raw,
        }),
      );
      expect((service as any).emailProvider).toBeUndefined();
      emitSpy.mockClear();
    });

    it('no verified-gate here: already-verified user still issues (resend owns anti-enum)', async () => {
      await service.requestEmailVerification({
        ...user,
        emailVerified: true,
      });
      expect(dataSource.transaction).toHaveBeenCalledTimes(1);
      expect(usersService.issueEmailVerificationToken).toHaveBeenCalledTimes(1);
    });
  });

  // ===================== T020: verifyEmail FOR UPDATE on user row (US1) =====================
  describe('verifyEmail (T020 US1)', () => {
    const user = {
      id: 'user-1',
      email: 'alice@example.com',
      emailVerified: false,
    } as any;
    const raw = crypto.randomBytes(32).toString('hex');
    const tokenHash = crypto.createHash('sha256').update(raw).digest('hex');
    const future = new Date(Date.now() + 10 * 60 * 1000);
    const past = new Date(Date.now() - 60 * 1000);

    beforeEach(() => {
      dataSource.transaction.mockClear();
      mockUserRepo.update.mockClear();
      usersService.findUserByEmailForUpdate.mockClear();
      usersService.consumeEmailVerificationToken.mockClear();
    });

    // Locked user row backing the findUserByEmailForUpdate fake.
    function mockLockedUser(row: any) {
      lockedVerificationUser = { email: user.email, ...row };
    }

    function liveRow(overrides: any = {}) {
      return {
        id: user.id,
        email: user.email,
        emailVerified: false,
        emailVerificationTokenHash: tokenHash,
        emailVerificationExpiresAt: future,
        emailVerificationUsedAt: null,
        ...overrides,
      };
    }

    it('valid → 200 + consume called (usedAt NOW + verified flag)', async () => {
      usersService.findUserByEmail.mockResolvedValue({ ...user });
      mockLockedUser(liveRow());
      const res = await service.verifyEmail({ email: user.email, token: raw });
      expect(res).toEqual({ verified: true, emailVerified: true });
      // Locked read scoped to the email before any write
      expect(usersService.findUserByEmailForUpdate).toHaveBeenCalledWith(
        mockManager,
        user.email,
      );
      // Single-use consume in the same tx
      expect(usersService.consumeEmailVerificationToken).toHaveBeenCalledTimes(
        1,
      );
      const [managerArg, consumedUserId, consumedAt] =
        usersService.consumeEmailVerificationToken.mock.calls[0];
      expect(managerArg).toBe(mockManager);
      expect(consumedUserId).toBe(user.id);
      expect(consumedAt).toBeInstanceOf(Date);
      expect(mockUserRepo.update).toHaveBeenCalledWith(
        user.id,
        expect.objectContaining({
          emailVerificationUsedAt: consumedAt,
          emailVerified: true,
        }),
      );
    });

    it('usedAt NOT NULL → 400, 0 consume', async () => {
      usersService.findUserByEmail.mockResolvedValue({ ...user });
      mockLockedUser(liveRow({ emailVerificationUsedAt: new Date() }));
      await expect(
        service.verifyEmail({ email: user.email, token: raw }),
      ).rejects.toThrow(BadRequestException);
      expect(usersService.consumeEmailVerificationToken).not.toHaveBeenCalled();
    });

    it('expiresAt <= NOW → 400, 0 consume', async () => {
      usersService.findUserByEmail.mockResolvedValue({ ...user });
      mockLockedUser(liveRow({ emailVerificationExpiresAt: past }));
      await expect(
        service.verifyEmail({ email: user.email, token: raw }),
      ).rejects.toThrow('Invalid or expired verification token');
      expect(usersService.consumeEmailVerificationToken).not.toHaveBeenCalled();
    });

    it('wrong hash → 400, 0 consume', async () => {
      usersService.findUserByEmail.mockResolvedValue({ ...user });
      mockLockedUser(liveRow({ emailVerificationTokenHash: 'f'.repeat(64) }));
      await expect(
        service.verifyEmail({ email: user.email, token: raw }),
      ).rejects.toThrow(BadRequestException);
      expect(usersService.consumeEmailVerificationToken).not.toHaveBeenCalled();
    });

    it('unknown email → 400 (no 404 leak), 0 transaction', async () => {
      usersService.findUserByEmail.mockResolvedValue(null);
      await expect(
        service.verifyEmail({ email: 'nobody@example.com', token: raw }),
      ).rejects.toThrow(BadRequestException);
      expect(dataSource.transaction).not.toHaveBeenCalled();
    });

    it('logs hashPrefix only, never raw', async () => {
      usersService.findUserByEmail.mockResolvedValue({ ...user });
      mockLockedUser(liveRow());
      await service.verifyEmail({ email: user.email, token: raw });
      const allLogs = [
        ...logger.log.mock.calls,
        ...logger.debug.mock.calls,
        ...logger.warn.mock.calls,
        ...logger.error.mock.calls,
      ]
        .map((c) => String(c[0] ?? ''))
        .join('\n');
      expect(allLogs).not.toContain(raw);
    });
  });

  // ===================== T027: resendVerification anti-enum/cooldown (US2) =====================
  describe('resendVerification (T027 US2)', () => {
    const user = {
      id: 'user-1',
      email: 'alice@example.com',
      emailVerified: false,
    } as any;

    beforeEach(() => {
      dataSource.transaction.mockClear();
      mockUserRepo.update.mockClear();
      usersService.issueEmailVerificationToken.mockClear();
      cacheManager.get.mockReset();
      cacheManager.set.mockReset();
      cacheManager.get.mockResolvedValue(undefined);
      cacheManager.set.mockResolvedValue(undefined);
    });

    it('cooldown key exists → VerificationCooldownError, 0 transaction', async () => {
      cacheManager.get.mockResolvedValue('1');
      // T030: the service throws the domain signal; the controller renders
      // the identical 429 wire shape (proven at HTTP level by parity resend).
      await expect(service.resendVerification(user.email)).rejects.toThrow(
        VerificationCooldownError,
      );
      expect(dataSource.transaction).not.toHaveBeenCalled();
      expect(usersService.issueEmailVerificationToken).not.toHaveBeenCalled();
    });

    it('not found → 200 anti-enum, 0 issue', async () => {
      usersService.findUserByEmail.mockResolvedValue(null);
      const res = await service.resendVerification('nobody@example.com');
      // Pinned contract (RP-AUTH): the long anti-enum message — same string
      // whether the email exists or not and whether it is verified.
      expect(res).toEqual({
        message:
          'This email is not registered or already verified. If an account exists, a verification email has been sent.',
      });
      expect(usersService.issueEmailVerificationToken).not.toHaveBeenCalled();
    });

    it('verified true → 200 distinct, 0 issue', async () => {
      usersService.findUserByEmail.mockResolvedValue({
        ...user,
        emailVerified: true,
      });
      const res = await service.resendVerification(user.email);
      expect(res).toEqual({ message: 'Email already verified' });
      expect(usersService.issueEmailVerificationToken).not.toHaveBeenCalled();
    });

    it('unverified → overwrite live hash + 24h + emit + cooldown set', async () => {
      usersService.findUserByEmail.mockResolvedValue({ ...user });
      const emitSpy = eventPublisher.emit;
      const res = await service.resendVerification(user.email);
      expect(res).toEqual({
        message: 'If an account exists, a verification email has been sent.',
      });
      expect(dataSource.transaction).toHaveBeenCalledTimes(1);
      expect(usersService.issueEmailVerificationToken).toHaveBeenCalledTimes(1);
      const issuedHash =
        usersService.issueEmailVerificationToken.mock.calls[0][2];
      expect(issuedHash).toMatch(/^[a-f0-9]{64}$/);
      expect(issuedHash).toBe(
        crypto
          .createHash('sha256')
          .update(service.lastVerificationToken!)
          .digest('hex'),
      );
      expect(emitSpy).toHaveBeenCalledTimes(1);
      expect(emitSpy).toHaveBeenCalledWith(
        'email.verification_requested',
        expect.objectContaining({ userId: user.id }),
      );
      // cooldown SET 60s recorded via cache.set
      expect(cacheManager.set).toHaveBeenCalledWith(
        expect.stringContaining('resend:cooldown:'),
        expect.anything(),
        expect.any(Number),
      );
      emitSpy.mockClear();
    });
  });

  // ===================== T032: forgotPassword wired emit (US3) =====================
  describe('forgotPassword wired emit (T032 US3)', () => {
    const user = { id: 'user-1', email: 'alice@example.com' } as any;

    beforeEach(() => {
      dataSource.transaction.mockClear();
      mockTokenRepo.create.mockClear();
      mockTokenRepo.save.mockClear();
    });

    it('existing user → INSERT 15m + emit auth.password_reset_requested once', async () => {
      usersService.findUserByEmail.mockResolvedValue(user);
      const emitSpy = eventPublisher.emit;
      await service.requestPasswordReset(user.email);
      expect(mockTokenRepo.save).toHaveBeenCalledTimes(1);
      expect(emitSpy).toHaveBeenCalledTimes(1);
      expect(emitSpy).toHaveBeenCalledWith(
        'auth.password_reset_requested',
        expect.objectContaining({ userId: user.id, email: user.email }),
      );
      emitSpy.mockClear();
    });

    it('unknown email → 0 insert + 0 emit', async () => {
      usersService.findUserByEmail.mockResolvedValue(null);
      const emitSpy = eventPublisher.emit;
      await service.requestPasswordReset('nobody@example.com');
      expect(mockTokenRepo.save).not.toHaveBeenCalled();
      expect(emitSpy).not.toHaveBeenCalled();
      emitSpy.mockClear();
    });
  });

  // ===================== A6: linkGoogleAccount maps 23505 → 409 =====================
  describe('linkGoogleAccount double-link (A6)', () => {
    const profile = {
      googleId: 'google-dup-1',
      email: 'dup@example.com',
      firstName: 'Dup',
      lastName: 'User',
      verified: true,
    };

    it('unique violation on link → ConflictException (DB serializes, app maps)', async () => {
      usersService.findByGoogleId.mockResolvedValue(null);
      usersService.linkGoogleAccount.mockRejectedValue(
        Object.assign(
          new Error('duplicate key value violates unique constraint'),
          {
            code: '23505',
          },
        ),
      );
      await expect(
        service.linkGoogleAccount('user-1', profile as any),
      ).rejects.toThrow('Google account already linked');
      await expect(
        service.linkGoogleAccount('user-1', profile as any),
      ).rejects.toThrow(ConflictException);
    });

    it('non-unique error propagates unmapped', async () => {
      usersService.findByGoogleId.mockResolvedValue(null);
      usersService.linkGoogleAccount.mockRejectedValue(new Error('boom'));
      await expect(
        service.linkGoogleAccount('user-1', profile as any),
      ).rejects.toThrow('boom');
    });
  });
});
