import { Injectable } from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';

/**
 * Legacy passport-jwt guard (off-path since S-1).
 * Only remaining use is stacked with GoogleAuthGuard on google/link;
 * all other routes use JwtGuard via @Auth(). Remove with JwtStrategy (A7).
 */
@Injectable()
export class JwtAuthGuard extends AuthGuard('jwt') {}
