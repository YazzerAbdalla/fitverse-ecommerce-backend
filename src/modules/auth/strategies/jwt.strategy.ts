import { Injectable, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PassportStrategy } from '@nestjs/passport';
import { ExtractJwt, Strategy } from 'passport-jwt';
import { UsersService } from '../../users/users.service';
import { JwtPayload } from '../types';

/**
 * Passport JWT strategy (off-path since S-1: JwtGuard is the sole JWT path).
 * Kept in sync with JwtGuard.assertNotRevoked until removal (A7) — tokenVersion
 * revocation plus passwordChangedAt fallback with 1s iat tolerance.
 *
 * Responsibility (SRP): passport-jwt validation wiring, nothing else.
 * Used by: AuthModule provider list (JwtAuthGuard 'jwt' only).
 * Depends on: UsersService, ConfigService.
 */
@Injectable()
export class JwtStrategy extends PassportStrategy(Strategy, 'jwt') {
  constructor(
    private readonly usersService: UsersService,
    configService: ConfigService,
  ) {
    super({
      jwtFromRequest: ExtractJwt.fromAuthHeaderAsBearerToken(),
      ignoreExpiration: false,
      secretOrKey: configService.get<string>('JWT_SECRET') || 'secret',
    });
  }

  /**
   * Validates the JWT payload against current user state (revocation-aware).
   *
   * @param payload - Decoded JWT payload (sub/email/tokenVersion/iat).
   * @returns The user row when the token is still valid.
   * @throws UnauthorizedException on unknown user or revoked token.
   */
  async validate(payload: JwtPayload) {
    const user = payload.sub
      ? await this.usersService.findUserById(payload.sub)
      : payload.email
        ? await this.usersService.findUserByEmail(payload.email)
        : null;
    if (!user) throw new UnauthorizedException('User not found');

    // tokenVersion revocation per F2 choice C (stateless)
    if (
      typeof payload.tokenVersion === 'number' &&
      typeof user.tokenVersion === 'number' &&
      payload.tokenVersion !== user.tokenVersion
    ) {
      throw new UnauthorizedException('Token revoked, please login again');
    }
    // fallback passwordChangedAt check for old tokens.
    // iat is second-precision (truncated down) while passwordChangedAt is
    // ms-precision: only revoke when issued a full second+ before the change,
    // otherwise logins within ~1s after a change falsely read as revoked.
    // (Kept in sync with JwtGuard.assertNotRevoked until S-1 removes this path.)
    if (user.passwordChangedAt && payload.iat) {
      const changed = new Date(user.passwordChangedAt).getTime();
      if (payload.iat * 1000 < changed - 1000) {
        throw new UnauthorizedException('Token revoked after password change');
      }
    }
    return user;
  }
}
