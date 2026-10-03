import {
  CanActivate,
  ExecutionContext,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { Request } from 'express';
import { UsersService } from '../../users/users.service';

/**
 * This guard is responsible for JWT authentication on every guarded route.
 * It verifies the Bearer signature, loads the user once, and enforces
 * tokenVersion revocation (plus the passwordChangedAt fallback).
 *
 * Responsibility (SRP): request authentication + revocation enforcement, nothing else.
 * Used by: Auth decorator (all guarded REST routes).
 * Depends on: JwtService (signature), UsersService (user + tokenVersion lookup).
 * Data owner: request.user in payload shape ({sub, email, fullName, role,
 *   tokenVersion}) — reused downstream by RolesGuard and @CurrentUser();
 *   downstream layers MUST NOT re-query the user for identity.
 */
@Injectable()
export class JwtGuard implements CanActivate {
  constructor(
    private readonly jwtService: JwtService,
    private readonly usersService: UsersService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request: Request = context.switchToHttp().getRequest();
    const token = this.extractTokenFromHeader(request);
    if (!token) {
      throw new UnauthorizedException();
    }
    try {
      // 💡 Here the JWT secret key that's used for verifying the payload
      // is the key that was passed in the JwtModule
      const payload: Record<string, string> =
        await this.jwtService.verifyAsync(token);
      // S-1: sole-path revocation check (mirrors JwtStrategy.validate).
      // Payload shape on request.user is frozen — downstream RolesGuard and
      // @CurrentUser() consume {sub, email, fullName, role, tokenVersion}.
      await this.assertNotRevoked(payload);
      // 💡 We're assigning the payload to the request object here
      // so that we can access it in our route handlers
      request['user'] = payload;
    } catch (e) {
      // Preserve specific revocation messages; malformed tokens stay generic.
      if (e instanceof UnauthorizedException) throw e;
      throw new UnauthorizedException();
    }
    return true;
  }

  /**
   * Enforces tokenVersion revocation against the authoritative user row.
   *
   * @param payload - Verified JWT payload ({sub, email, tokenVersion, iat}).
   * @throws UnauthorizedException when the user is gone or the token is revoked.
   */
  private async assertNotRevoked(
    payload: Record<string, unknown>,
  ): Promise<void> {
    const sub = typeof payload.sub === 'string' ? payload.sub : undefined;
    const email = typeof payload.email === 'string' ? payload.email : undefined;
    const user = sub
      ? await this.usersService.findUserById(sub)
      : email
        ? await this.usersService.findUserByEmail(email)
        : null;
    if (!user) throw new UnauthorizedException('User not found');

    const tokenVersion: unknown = payload.tokenVersion;
    const userVersion: unknown = (user as { tokenVersion?: unknown })
      .tokenVersion;
    // Revocation: token issued before the latest tokenVersion++ is dead.
    if (
      typeof tokenVersion === 'number' &&
      typeof userVersion === 'number' &&
      tokenVersion !== userVersion
    ) {
      throw new UnauthorizedException('Token revoked, please login again');
    }
    // Fallback for tokens issued before tokenVersion existed (mirrors
    // JwtStrategy.validate: tokens that cannot prove recency are allowed
    // through here; the tokenVersion check above is the real authority).
    const changedAt: unknown = (user as { passwordChangedAt?: unknown })
      .passwordChangedAt;
    const issuedAt: unknown = payload.iat;
    if (
      (changedAt instanceof Date || typeof changedAt === 'string') &&
      typeof issuedAt === 'number'
    ) {
      const changedMs = new Date(changedAt).getTime();
      // iat is second-precision (truncated down) while passwordChangedAt is
      // ms-precision: a login up to ~1s after a password change would falsely
      // read as "issued before". Only revoke when issued a full second+ earlier.
      if (issuedAt * 1000 < changedMs - 1000) {
        throw new UnauthorizedException('Token revoked after password change');
      }
    }
  }

  private extractTokenFromHeader(request: Request): string | undefined {
    const [type, token] = request.headers.authorization?.split(' ') ?? [];
    return type === 'Bearer' ? token : undefined;
  }
}
