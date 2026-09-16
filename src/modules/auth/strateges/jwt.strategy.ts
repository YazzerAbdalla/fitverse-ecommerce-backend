import { Injectable, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PassportStrategy } from '@nestjs/passport';
import { ExtractJwt, Strategy } from 'passport-jwt';
import { UsersService } from '../../users/users.service';
import { JwtPayloadProps } from '../types';

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

  async validate(payload: JwtPayloadProps) {
    const user = payload.sub
      ? await this.usersService.findUserById(payload.sub)
      : payload.email
        ? await this.usersService.findUserByEmail(payload.email)
        : null;
    if (!user) throw new UnauthorizedException('User not found');

    // tokenVersion revocation per F2 choice C (stateless)
    if (
      typeof payload.tokenVersion === 'number' &&
      typeof (user as any).tokenVersion === 'number' &&
      payload.tokenVersion !== (user as any).tokenVersion
    ) {
      throw new UnauthorizedException('Token revoked, please login again');
    }
    // fallback passwordChangedAt check for old tokens
    if ((user as any).passwordChangedAt && payload.iat) {
      const changed = new Date((user as any).passwordChangedAt).getTime();
      if (payload.iat * 1000 < changed) {
        throw new UnauthorizedException('Token revoked after password change');
      }
    }
    return user;
  }
}
