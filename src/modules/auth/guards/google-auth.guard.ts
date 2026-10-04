import { Injectable } from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';

/**
 * Passport Google OAuth guard (redirect + callback handshake).
 * Used on GET /auth/google, /google/callback, and stacked with JwtAuthGuard
 * on /google/link.
 */
@Injectable()
export class GoogleAuthGuard extends AuthGuard('google') {}
