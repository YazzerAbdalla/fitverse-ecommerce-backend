import { Injectable, UnauthorizedException } from '@nestjs/common';
import { Strategy } from 'passport-local';
import { PassportStrategy } from '@nestjs/passport';
import { AuthService } from '../auth.service';
import type User from '../../users/entity/user.entity';

/**
 * Passport local strategy (email + password) for POST /auth/login.
 * Delegates credential checking to AuthService.userValidation.
 *
 * Responsibility (SRP): passport-local validation wiring, nothing else.
 * Used by: LocalAuthGuard on POST /auth/login.
 * Depends on: AuthService.
 */
@Injectable()
export class LocalStrategy extends PassportStrategy(Strategy) {
  constructor(private readonly authService: AuthService) {
    super({ usernameField: 'email' });
  }

  /**
   * Validates local credentials via the auth boundary.
   *
   * @param email - Login email (mapped from the username field).
   * @param password - Plaintext password to compare.
   * @returns The validated user (password hash stripped).
   * @throws UnauthorizedException on unknown user or mismatch.
   */
  async validate(email: string, password: string): Promise<Partial<User>> {
    const validatedUser = await this.authService.userValidation(
      email,
      password,
    );

    if (!validatedUser) {
      throw new UnauthorizedException('Email or password is incorrect.');
    }

    return validatedUser;
  }
}
