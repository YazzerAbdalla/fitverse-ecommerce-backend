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

  async validate(
    accessToken: string,
    refreshToken: string,
    profile: any,
    done: VerifyCallback,
  ) {
    const email = profile.emails?.[0]?.value;
    const verified = profile.emails?.[0]?.verified === true;
    const googleProfile: GoogleProfile = {
      googleId: profile.id,
      email,
      firstName: profile.name?.givenName || '',
      lastName: profile.name?.familyName || '',
      verified,
      avatar: profile.photos?.[0]?.value,
    };
    done(null, googleProfile);
  }
}
