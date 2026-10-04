import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PassportStrategy } from '@nestjs/passport';
import { Strategy, VerifyCallback } from 'passport-google-oauth20';

export interface GoogleProfile {
  googleId: string;
  email: string;
  firstName: string;
  lastName: string;
  verified: boolean;
  avatar?: string;
}

/**
 * Raw Google OAuth profile shape (subset used by validate).
 * passport-google-oauth20 types the verify profile loosely, so the fields
 * this strategy reads are declared explicitly instead of `any`.
 */
interface GoogleOAuthProfile {
  id?: string;
  emails?: Array<{ value: string; verified?: boolean | string }>;
  name?: { givenName?: string; familyName?: string };
  photos?: Array<{ value: string }>;
}

/**
 * Passport Google OAuth strategy (redirect + callback).
 * Maps the provider profile onto the internal GoogleProfile shape.
 *
 * Responsibility (SRP): Google OAuth validation wiring, nothing else.
 * Used by: GoogleAuthGuard on GET /auth/google(+callback/link).
 * Depends on: ConfigService (client ID/secret/callback).
 */
@Injectable()
export class GoogleStrategy extends PassportStrategy(Strategy, 'google') {
  // Construction happens once per boot, so one warn here is warn-once by nature.
  private readonly logger = new Logger(GoogleStrategy.name);

  constructor(configService: ConfigService) {
    // Read before super (params are in scope; `this` is not yet).
    // Empty counts as missing, same as auth-token.config readString.
    const clientID = configService.get<string>('GOOGLE_CLIENT_ID');
    const clientSecret = configService.get<string>('GOOGLE_CLIENT_SECRET');
    const callbackURL = configService.get<string>('GOOGLE_CALLBACK_URL');
    super({
      clientID: clientID || 'test',
      clientSecret: clientSecret || 'test',
      callbackURL: callbackURL || 'http://localhost:3000/auth/google/callback',
      scope: ['profile', 'email'],
      state: true,
    });
    // Fail-fast in production: silent 'test' fallbacks must never serve
    // live traffic. In dev/test they stay (warned) so OAuth setup is optional.
    const missing = [
      !clientID && 'GOOGLE_CLIENT_ID',
      !clientSecret && 'GOOGLE_CLIENT_SECRET',
      !callbackURL && 'GOOGLE_CALLBACK_URL',
    ].filter((key): key is string => !!key);
    if (missing.length > 0) {
      if (configService.get<string>('NODE_ENV') === 'production') {
        throw new Error(
          `Google OAuth misconfigured: missing ${missing.join(', ')} (required in production)`,
        );
      }
      this.logger.warn(
        `Google OAuth keys missing (${missing.join(', ')}): using dev fallbacks — set GOOGLE_* for real OAuth`,
      );
    }
  }

  /**
   * Maps the provider profile onto the internal GoogleProfile shape.
   *
   * @param accessToken - Provider access token (unused, kept for signature).
   * @param refreshToken - Provider refresh token (unused, kept for signature).
   * @param profile - Raw provider profile (only declared fields are read).
   * @param done - Passport verify callback receiving the mapped profile.
   * @returns Void (result delivered via done).
   */
  async validate(
    accessToken: string,
    refreshToken: string,
    profile: GoogleOAuthProfile,
    done: VerifyCallback,
  ) {
    // Provider may omit emails/id (pinned by spec: missing emails maps to
    // email undefined + verified false); loginWithGoogle rejects unverified
    // downstream, so the mapping stays a pure passthrough here.
    const email = profile.emails?.[0]?.value as string;
    const googleId = profile.id as string;
    const verified = profile.emails?.[0]?.verified === true;
    const googleProfile: GoogleProfile = {
      googleId,
      email,
      firstName: profile.name?.givenName || '',
      lastName: profile.name?.familyName || '',
      verified,
      avatar: profile.photos?.[0]?.value,
    };
    done(null, googleProfile);
  }
}
