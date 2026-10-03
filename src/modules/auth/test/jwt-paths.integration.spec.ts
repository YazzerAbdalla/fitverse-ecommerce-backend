/**
 * BASELINE characterization: dual-JWT-path behavior (read-only, no production changes).
 *
 * Phase 2 T004 of specs/015-auth-user-refactor (research D1). Two JWT paths exist:
 * - JwtGuard (guards/jwt.guard.ts): S-1 UNIFIED — `verifyAsync` + UsersService
 *   lookup + tokenVersion check, sets `request.user = payload`.
 *   (Pre-S-1 it skipped the lookup and let revoked tokens through.)
 * - JwtStrategy (strategies/jwt.strategy.ts): retained but off the request path.
 * - @Auth() hardcodes JwtGuard (decorators/auth.decorator.ts:7-11), so every
 *   `@Auth()` route runs the payload shape through RolesGuard.
 *
 * Unit-style: JwtService + UsersService are mocked (auth.service.spec.ts style),
 * no DB needed. Do NOT "fix" these expectations — S-1 unification (T012) will
 * flip test 1 to 401; that flip is the S-delta proof.
 */
import { UnauthorizedException, ForbiddenException } from '@nestjs/common';
import { ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { JwtService } from '@nestjs/jwt';
import { ConfigService } from '@nestjs/config';
import { JwtGuard } from '../guards/jwt.guard';
import { RolesGuard } from '../guards/roles.guard';
import { JwtStrategy } from '../strategies/jwt.strategy';
import { UserRoles } from '../../users/enum/roles';
import { JwtPayloadProps } from '../types';

// Revoked-version fixture: token was issued at version 0, user has since been
// bumped to version 1 (logout-all / reset-password `tokenVersion++`).
const REVOKED_PAYLOAD: JwtPayloadProps = {
  sub: 'user-1',
  email: 'alice@example.com',
  fullName: 'Alice Test',
  role: UserRoles.User,
  tokenVersion: 0,
};
const CURRENT_USER_ROW = {
  id: 'user-1',
  email: 'alice@example.com',
  role: UserRoles.User,
  tokenVersion: 1,
};

/** Minimal ExecutionContext stub carrying the given HTTP request. */
function httpContext(req: any, roles?: UserRoles[]): ExecutionContext {
  return {
    switchToHttp: () => ({ getRequest: () => req }),
    getHandler: () => ({}),
    getClass: () => ({}),
  } as unknown as ExecutionContext;
}

describe('jwt-paths baseline (T004, research D1)', () => {
  let jwtService: Record<string, jest.Mock>;
  let usersService: Record<string, jest.Mock>;
  let configService: Record<string, jest.Mock>;
  let reflector: Record<string, jest.Mock>;

  beforeEach(() => {
    jwtService = { verifyAsync: jest.fn() };
    usersService = { findUserById: jest.fn(), findUserByEmail: jest.fn() };
    configService = { get: jest.fn().mockReturnValue('secret') };
    reflector = { getAllAndOverride: jest.fn() };
  });

  describe('1. Unified JwtGuard denies a revoked-version token (S-1 POST-STATE)', () => {
    it('canActivate rejects payload tokenVersion 0 vs user tokenVersion 1', async () => {
      // S-1 POST-STATE (was PRE-STATE allow): the unified guard loads the user
      // row and enforces revocation. T011/T012 enactment; this flip is the proof.
      jwtService.verifyAsync.mockResolvedValue({ ...REVOKED_PAYLOAD });
      usersService.findUserById.mockResolvedValue({ ...CURRENT_USER_ROW });
      const guard = new JwtGuard(
        jwtService as unknown as JwtService,
        usersService as any,
      );
      const req: any = {
        headers: { authorization: 'Bearer revoked-token' },
      };

      await expect(guard.canActivate(httpContext(req))).rejects.toThrow(
        'Token revoked, please login again',
      );
      expect(usersService.findUserById).toHaveBeenCalledWith('user-1');
    });

    it('canActivate passes when versions match and keeps payload shape', async () => {
      jwtService.verifyAsync.mockResolvedValue({
        ...REVOKED_PAYLOAD,
        tokenVersion: 1,
      });
      usersService.findUserById.mockResolvedValue({ ...CURRENT_USER_ROW });
      const guard = new JwtGuard(
        jwtService as unknown as JwtService,
        usersService as any,
      );
      const req: any = {
        headers: { authorization: 'Bearer current-token' },
      };

      await expect(guard.canActivate(httpContext(req))).resolves.toBe(true);
      // Shape frozen: guard assigns the raw payload (has `sub`, no `id`).
      expect(req.user.sub).toBe('user-1');
      expect(req.user.id).toBeUndefined();
    });

    it('canActivate rejects when the user row is gone', async () => {
      jwtService.verifyAsync.mockResolvedValue({ ...REVOKED_PAYLOAD });
      usersService.findUserById.mockResolvedValue(null);
      const guard = new JwtGuard(
        jwtService as unknown as JwtService,
        usersService as any,
      );
      await expect(
        guard.canActivate(
          httpContext({ headers: { authorization: 'Bearer x' } }),
        ),
      ).rejects.toThrow('User not found');
    });

    it('passwordChangedAt fallback tolerates same-second iat truncation', async () => {
      // iat is second-precision: a token minted in the same second as a
      // password change MUST pass; one minted 2s earlier MUST be rejected.
      const nowMs = Date.now();
      const changedAt = new Date(nowMs).toISOString();
      const sameSecondIat = Math.floor(nowMs / 1000);
      usersService.findUserById.mockResolvedValue({
        ...CURRENT_USER_ROW,
        tokenVersion: undefined,
        passwordChangedAt: changedAt,
      });
      const payload: any = {
        sub: 'user-1',
        email: 'alice@example.com',
        role: UserRoles.User,
        iat: sameSecondIat,
      };
      jwtService.verifyAsync.mockResolvedValue(payload);
      const guard = new JwtGuard(
        jwtService as unknown as JwtService,
        usersService as any,
      );
      await expect(
        guard.canActivate(
          httpContext({ headers: { authorization: 'Bearer x' } }),
        ),
      ).resolves.toBe(true);

      jwtService.verifyAsync.mockResolvedValue({
        ...payload,
        iat: sameSecondIat - 2,
      });
      await expect(
        guard.canActivate(
          httpContext({ headers: { authorization: 'Bearer x' } }),
        ),
      ).rejects.toThrow('Token revoked after password change');
    });

    it('still 401s on missing / invalid Bearer token (unchanged by S-1)', async () => {
      const guard = new JwtGuard(
        jwtService as unknown as JwtService,
        usersService as any,
      );
      await expect(
        guard.canActivate(httpContext({ headers: {} })),
      ).rejects.toThrow(UnauthorizedException);
      jwtService.verifyAsync.mockRejectedValue(new Error('invalid'));
      await expect(
        guard.canActivate(
          httpContext({ headers: { authorization: 'Bearer bad' } }),
        ),
      ).rejects.toThrow(UnauthorizedException);
    });
  });

  describe('2. JwtStrategy denies the same revoked payload (enforcement)', () => {
    it('validate throws UnauthorizedException on tokenVersion mismatch', async () => {
      // S-1 PRE-STATE companion: the strategy path DOES enforce revocation.
      usersService.findUserById.mockResolvedValue({ ...CURRENT_USER_ROW });
      const strategy = new JwtStrategy(
        usersService as any,
        configService as unknown as ConfigService,
      );

      await expect(strategy.validate({ ...REVOKED_PAYLOAD })).rejects.toThrow(
        UnauthorizedException,
      );
      await expect(strategy.validate({ ...REVOKED_PAYLOAD })).rejects.toThrow(
        'Token revoked, please login again',
      );
      expect(usersService.findUserById).toHaveBeenCalledWith('user-1');
    });

    it('validate returns the User entity when versions match', async () => {
      usersService.findUserById.mockResolvedValue({ ...CURRENT_USER_ROW });
      const strategy = new JwtStrategy(
        usersService as any,
        configService as unknown as ConfigService,
      );

      const result = await strategy.validate({
        ...REVOKED_PAYLOAD,
        tokenVersion: 1,
      });
      // Shape: strategy returns the entity (has `id`, no `sub`).
      expect(result).toEqual({ ...CURRENT_USER_ROW });
      expect((result as any).id).toBe('user-1');
      expect((result as any).sub).toBeUndefined();
    });
  });

  describe('3. Shape documentation: payload vs entity', () => {
    it('JwtGuard request.user is the payload; JwtStrategy result is the entity', async () => {
      jwtService.verifyAsync.mockResolvedValue({
        ...REVOKED_PAYLOAD,
        tokenVersion: 1,
      });
      usersService.findUserById.mockResolvedValue({ ...CURRENT_USER_ROW });
      const guard = new JwtGuard(
        jwtService as unknown as JwtService,
        usersService as any,
      );
      const strategy = new JwtStrategy(
        usersService as any,
        configService as unknown as ConfigService,
      );

      const req: any = {
        headers: { authorization: 'Bearer revoked-token' },
      };
      await guard.canActivate(httpContext(req));
      const entity = await strategy.validate({
        ...REVOKED_PAYLOAD,
        tokenVersion: 1,
      });

      // Payload keys (what RolesGuard + @CurrentUser() consume on @Auth() routes)
      expect(Object.keys(req.user).sort()).toEqual(
        ['email', 'fullName', 'role', 'sub', 'tokenVersion'].sort(),
      );
      // Entity keys (passport/JwtAuthGuard shape — NOT what @Auth() routes see)
      expect(Object.keys(entity as any)).toEqual(
        expect.arrayContaining(['id', 'email', 'role', 'tokenVersion']),
      );
      expect((entity as any).sub).toBeUndefined();
    });
  });

  describe('4. RolesGuard relies on the payload shape', () => {
    function rolesGuardWith(required: UserRoles[] | undefined) {
      reflector.getAllAndOverride.mockReturnValue(required);
      return new RolesGuard(reflector as unknown as Reflector);
    }

    it('passes when payload role is in the allowed roles', () => {
      const guard = rolesGuardWith([UserRoles.Admin, UserRoles.User]);
      const req = { user: { ...REVOKED_PAYLOAD, role: UserRoles.User } };
      expect(guard.canActivate(httpContext(req))).toBe(true);
    });

    it('throws 403 when payload has no role', () => {
      const guard = rolesGuardWith([UserRoles.User]);
      const { role: _omitted, ...roleless } = REVOKED_PAYLOAD;
      expect(() => guard.canActivate(httpContext({ user: roleless }))).toThrow(
        ForbiddenException,
      );
    });

    it('throws 403 on wrong-case role (case-sensitive includes match)', () => {
      // Odd-case proof: 'admin' !== 'Admin' under `requiredRoles.includes(role)`.
      const guard = rolesGuardWith([UserRoles.Admin]);
      const req = { user: { ...REVOKED_PAYLOAD, role: 'admin' as UserRoles } };
      expect(() => guard.canActivate(httpContext(req))).toThrow(
        ForbiddenException,
      );
    });

    it('passes through when no roles metadata is set', () => {
      const guard = rolesGuardWith(undefined);
      expect(guard.canActivate(httpContext({ user: undefined }))).toBe(true);
    });
  });
});
