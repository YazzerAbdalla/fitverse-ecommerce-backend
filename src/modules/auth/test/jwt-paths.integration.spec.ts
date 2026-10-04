/**
 * BASELINE characterization: sole-JWT-path behavior (read-only, no production changes).
 *
 * Phase 2 T004 of specs/015-auth-user-refactor (research D1), as enacted by A7:
 * - JwtGuard (guards/jwt.guard.ts): SOLE path — `verifyAsync` + UsersService
 *   lookup + tokenVersion check, sets `request.user = payload`.
 * - @Auth() hardcodes JwtGuard (decorators/auth.decorator.ts), so every
 *   `@Auth()` route runs the payload shape through RolesGuard.
 * - The off-path passport strategy + wrapper guard were removed (A7); the
 *   entity-vs-payload divergence they caused is gone with them.
 *
 * Unit-style: JwtService + UsersService are mocked (auth.service.spec.ts style),
 * no DB needed.
 */
import { UnauthorizedException, ForbiddenException } from '@nestjs/common';
import { ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { JwtService } from '@nestjs/jwt';
import { JwtGuard } from '../guards/jwt.guard';
import { RolesGuard } from '../guards/roles.guard';
import { UserRoles } from '../../users/enum/roles';
import { JwtPayload } from '../types';

// Revoked-version fixture: token was issued at version 0, user has since been
// bumped to version 1 (logout-all / reset-password `tokenVersion++`).
const REVOKED_PAYLOAD: JwtPayload = {
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
  let reflector: Record<string, jest.Mock>;

  beforeEach(() => {
    jwtService = { verifyAsync: jest.fn() };
    usersService = { findUserById: jest.fn(), findUserByEmail: jest.fn() };
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

  describe('2. RolesGuard relies on the payload shape', () => {
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
