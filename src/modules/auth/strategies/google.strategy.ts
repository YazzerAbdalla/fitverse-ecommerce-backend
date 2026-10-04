import { Injectable } from '@nestjs/common';
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
  constructor(configService: ConfigService) {
    super({
      clientID: configService.get<string>('GOOGLE_CLIENT_ID') || 'test',
      clientSecret: configService.get<string>('GOOGLE_CLIENT_SECRET') || 'test',
      callbackURL:
        configService.get<string>('GOOGLE_CALLBACK_URL') ||
        'http://localhost:3000/auth/google/callback',
      scope: ['profile', 'email'],
      state: true,
    });
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
