/**
 * Auth HTTP endpoints: transport, validation, cookies/headers, 429 shaping.
 * No business logic, no persistence — delegates to AuthService.
 *
 * Responsibility (SRP): auth HTTP transport, nothing else.
 * Used by: AuthModule (route registration).
 * Depends on: AuthService, RateLimitGuard/GoogleAuthGuard,
 *   AUTH_TOKEN_CONFIG (cookie shaping).
 */
import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpException,
  HttpStatus,
  Inject,
  Post,
  Query,
  Req,
  Request,
  Res,
  UseGuards,
} from '@nestjs/common';
import type {
  Request as ExpressRequest,
  Response as ExpressResponse,
} from 'express';
import { ApiBody, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { AuthService } from './auth.service';
import { UserRegisterDto } from './dto/user-register.dto';
import User from '../users/entity/user.entity';
import { LoginDto } from './dto/login.dto';
import { LocalAuthGuard } from './guards/local-auth.guard';
import { ForgotPasswordDto } from './dto/forgot-password.dto';
import { ResetPasswordDto } from './dto/reset-password.dto';
import { ValidateResetTokenDto } from './dto/validate-reset-token.dto';
import { RequestOtpDto } from './dto/request-otp.dto';
import { VerifyOtpDto } from './dto/verify-otp.dto';
import { GoogleAuthGuard } from './guards/google-auth.guard';
import { RateLimitGuard } from './guards/rate-limit.guard';
import { CurrentUser } from './decorators/current-user.decorator';
import { RefreshTokenDto, LogoutDto } from './dto/refresh-token.dto';
import { VerifyEmailDto } from './dto/verify-email.dto';
import { ResendVerificationDto } from './dto/resend-verification.dto';
import { ConfigService } from '@nestjs/config';
import { Auth } from './decorators/auth.decorator';
import { AUTH_TOKEN_CONFIG } from './auth-token.config';
import type { AuthTokenConfig } from './auth-token.config';
import { VerificationCooldownError } from './verification-cooldown.error';
import { GoogleProfile } from './strategies/google.strategy';

/**
 * This controller exposes auth endpoints for register/login/refresh/logout and Google OAuth.
 * It handles refresh token dual transport (body vs HttpOnly cookie) and rate limiting.
 */
@Controller('auth')
@ApiTags('Auth')
export class AuthController {
  constructor(
    private readonly authService: AuthService,
    private readonly configService: ConfigService,
    @Inject(AUTH_TOKEN_CONFIG) private readonly tokenConfig: AuthTokenConfig,
  ) {}

  private getRefreshCookieName(): string {
    return this.tokenConfig.refreshCookieName;
  }

  private getRefreshCookieOptions() {
    // Cookie lifetime tracks the refresh-token TTL from startup-resolved
    // config (was triple-duplicated inline math; value-identical in all
    // cases including the non-numeric-suffix quirk, proven by ports.spec).
    return {
      httpOnly: true,
      secure: this.tokenConfig.refreshCookieSecure,
      sameSite: 'strict' as const,
      path: '/auth',
      maxAge: this.tokenConfig.refreshTokenTtlMs,
    };
  }

  private resolveRefreshRaw(
    dto: RefreshTokenDto | LogoutDto | undefined,
    req: ExpressRequest,
  ): string | undefined {
    const bodyRaw = dto?.refreshToken;
    if (bodyRaw) return bodyRaw;
    const cookieName = this.getRefreshCookieName();
    const cookies = req.cookies || {};
    if (cookies[cookieName]) return cookies[cookieName] as string;
    // Fallback parse header manually if cookieParser not present
    const header = req.headers.cookie;
    if (header) {
      const match = header
        .split(';')
        .map((c) => c.trim())
        .find((c) => c.startsWith(cookieName + '='));
      if (match) return match.split('=')[1];
    }
    return undefined;
  }

  @Post('/register')
  @UseGuards(RateLimitGuard)
  @ApiOperation({ summary: 'Register new user' })
  @ApiBody({ type: UserRegisterDto })
  @ApiResponse({ status: 201, description: 'User created' })
  @ApiResponse({
    status: 400,
    description: 'Validation error / duplicate email',
  })
  @ApiResponse({ status: 409, description: 'Email conflict (race)' })
  @ApiResponse({
    status: 429,
    description: 'Too Many Requests — Retry-After: 3600',
  })
  /** Registers a new user and triggers the verification email (fire-and-forget). */
  async register(@Body() userRegisterDto: UserRegisterDto) {
    return await this.authService.register(userRegisterDto);
  }

  @Post('/login')
  @UseGuards(RateLimitGuard, LocalAuthGuard)
  @ApiBody({ type: LoginDto })
  @ApiResponse({ status: 200, description: 'Login success with refresh' })
  @ApiResponse({ status: 400, description: 'Validation error' })
  @ApiResponse({ status: 401, description: 'Unauthorized' })
  @ApiResponse({
    status: 429,
    description: 'Too Many Requests — Retry-After: 3600',
  })
  @HttpCode(200)
  /** Logs in with password credentials; sets the HttpOnly refresh cookie. */
  async login(
    @Request() req: ExpressRequest & { user: Partial<User> },
    @Res({ passthrough: true }) res: ExpressResponse,
  ) {
    const user: Partial<User> = req.user;
    const result = await this.authService.login(user);

    // Set HttpOnly refresh cookie for browser clients
    res.cookie(
      this.getRefreshCookieName(),
      result.refreshToken,
      this.getRefreshCookieOptions(),
    );
    return result;
  }

  @Post('/forgot-password')
  @UseGuards(RateLimitGuard)
  @ApiOperation({ summary: 'Request password reset (anti-enumeration)' })
  @ApiBody({ type: ForgotPasswordDto })
  @ApiResponse({ status: 200, description: 'Neutral success (always)' })
  @ApiResponse({ status: 400, description: 'Validation error' })
  @ApiResponse({
    status: 429,
    description: 'Too Many Requests — Retry-After: 3600',
  })
  /** Requests a password reset (anti-enumeration: always the neutral success). */
  async forgotPassword(@Body() dto: ForgotPasswordDto) {
    await this.authService.requestPasswordReset(dto.email);
    return { message: 'If an account exists, a reset link has been sent.' };
  }

  @Post('/validate-reset-token')
  @UseGuards(RateLimitGuard)
  @ApiOperation({ summary: 'Validate reset token' })
  @ApiBody({ type: ValidateResetTokenDto })
  @ApiResponse({ status: 200, description: '{ valid: true }' })
  @ApiResponse({ status: 400, description: 'Invalid token / validation error' })
  @ApiResponse({
    status: 429,
    description: 'Too Many Requests — Retry-After: 3600',
  })
  /** Advisory reset-token pre-check (non-authoritative UX helper). */
  async validateResetToken(@Body() dto: ValidateResetTokenDto) {
    await this.authService.validateResetToken(dto.email, dto.token);
    return { valid: true };
  }

  @Post('/reset-password')
  @UseGuards(RateLimitGuard)
  @ApiOperation({ summary: 'Reset password with token (single-use)' })
  @ApiBody({ type: ResetPasswordDto })
  @ApiResponse({ status: 200, description: 'Password reset' })
  @ApiResponse({ status: 400, description: 'Invalid token / validation error' })
  @ApiResponse({
    status: 429,
    description: 'Too Many Requests — Retry-After: 3600',
  })
  /** Consumes a reset token and changes the password (single-use authority). */
  async resetPassword(@Body() dto: ResetPasswordDto) {
    await this.authService.resetPassword(dto);
    return { message: 'Password reset successful.' };
  }

  @Get('/verify-email')
  @UseGuards(RateLimitGuard)
  @ApiOperation({ summary: 'Verify email via link' })
  @ApiResponse({ status: 200, description: 'Email verified' })
  @ApiResponse({ status: 400, description: 'Invalid or expired token' })
  @ApiResponse({
    status: 429,
    description: 'Too Many Requests — Retry-After: 3600',
  })
  /** Verifies an email link token (query transport). */
  async verifyEmailGet(@Query() dto: VerifyEmailDto) {
    return await this.authService.verifyEmail(dto);
  }

  @Post('/verify-email')
  @UseGuards(RateLimitGuard)
  @ApiOperation({ summary: 'Verify email via body' })
  @ApiBody({ type: VerifyEmailDto })
  @ApiResponse({ status: 200, description: 'Email verified' })
  @ApiResponse({ status: 400, description: 'Invalid or expired token' })
  @ApiResponse({
    status: 429,
    description: 'Too Many Requests — Retry-After: 3600',
  })
  /** Verifies an email token (body transport). */
  async verifyEmailPost(@Body() dto: VerifyEmailDto) {
    return await this.authService.verifyEmail(dto);
  }

  @Post('/resend-verification')
  @UseGuards(RateLimitGuard)
  @ApiOperation({ summary: 'Resend verification email (anti-enumeration)' })
  @ApiBody({ type: ResendVerificationDto })
  @ApiResponse({ status: 200, description: 'Anti-enum message' })
  @ApiResponse({
    status: 429,
    description: 'Too Many Requests — Retry-After: 60 or 3600',
  })
  /** Resends verification honoring cooldown + anti-enumeration; renders 429 on cooldown. */
  async resendVerification(@Body() dto: ResendVerificationDto) {
    try {
      return await this.authService.resendVerification(dto.email);
    } catch (e) {
      // T030: domain cooldown signal → identical 429 wire shape as before
      // (status, body, Retry-After + rate-limit headers); nothing else changes.
      if (e instanceof VerificationCooldownError) {
        const ex = new HttpException(
          'Too Many Requests',
          HttpStatus.TOO_MANY_REQUESTS,
          {
            cause: {
              headers: {
                'Retry-After': String(e.retryAfterSec),
                'X-RateLimit-Limit': '3',
                'X-RateLimit-Remaining': '0',
              },
            },
          },
        );
        throw ex;
      }
      throw e;
    }
  }

  // TODO (Future) — WhatsApp OTP deferred per 2026-09-16, password-only login in V1
  // Endpoints return 501 until WhatsApp Business setup ready. Logic in AuthService remains but is paused.
  @Post('/otp/request')
  @UseGuards(RateLimitGuard)
  @ApiOperation({
    summary: 'Request WhatsApp OTP (login / verify_phone) — TODO Future (501)',
  })
  @ApiBody({ type: RequestOtpDto })
  @ApiResponse({ status: 501, description: 'WhatsApp OTP not enabled' })
  @ApiResponse({
    status: 429,
    description: 'Too Many Requests — Retry-After: 3600',
  })
  /** Deferred WhatsApp OTP request (501 until provider setup). */
  requestOtp(
    @Body() _dto: RequestOtpDto,
    @CurrentUser() _user?: Partial<User>,
  ) {
    throw new HttpException(
      'WhatsApp OTP not enabled — password login only. TODO future.',
      HttpStatus.NOT_IMPLEMENTED,
    );
    // TODO future: return this.authService.requestWhatsAppOtp(dto, user);
  }

  @Post('/otp/verify')
  @UseGuards(RateLimitGuard)
  @ApiOperation({ summary: 'Verify WhatsApp OTP — TODO Future (501)' })
  @ApiBody({ type: VerifyOtpDto })
  @ApiResponse({ status: 501, description: 'WhatsApp OTP not enabled' })
  @ApiResponse({
    status: 429,
    description: 'Too Many Requests — Retry-After: 3600',
  })
  /** Deferred WhatsApp OTP verify (501 until provider setup). */
  verifyOtp(@Body() _dto: VerifyOtpDto) {
    throw new HttpException(
      'WhatsApp OTP not enabled — password login only. TODO future.',
      HttpStatus.NOT_IMPLEMENTED,
    );
    // TODO future: return this.authService.verifyWhatsAppOtp(dto);
  }

  @Post('/refresh')
  @UseGuards(RateLimitGuard)
  @ApiOperation({
    summary:
      'Refresh accessToken via refreshToken (body or HttpOnly cookie) — rotation',
  })
  @ApiBody({ type: RefreshTokenDto })
  @ApiResponse({ status: 200, description: 'Rotated pair' })
  @ApiResponse({ status: 401, description: 'Invalid or expired refresh token' })
  @ApiResponse({ status: 400, description: 'Validation error' })
  @ApiResponse({
    status: 429,
    description: 'Too Many Requests — Retry-After: 3600',
  })
  /** Rotates a refresh token (body or cookie transport); sets the new cookie. */
  async refresh(
    @Body() dto: RefreshTokenDto,
    @Req() req: ExpressRequest,
    @Res({ passthrough: true }) res: ExpressResponse,
  ) {
    const raw = this.resolveRefreshRaw(dto, req);
    const result = await this.authService.refresh(raw);
    res.cookie(
      this.getRefreshCookieName(),
      result.refreshToken,
      this.getRefreshCookieOptions(),
    );
    if (!result.emailVerified) {
      res.setHeader('X-Email-Unverified', 'true');
    }
    return {
      accessToken: result.accessToken,
      refreshToken: result.refreshToken,
    };
  }

  @Post('/logout')
  @UseGuards(RateLimitGuard)
  @ApiOperation({ summary: 'Logout single refresh token (idempotent 200)' })
  @ApiBody({ type: LogoutDto })
  @ApiResponse({ status: 200, description: 'Logged out' })
  @ApiResponse({
    status: 429,
    description: 'Too Many Requests — Retry-After: 3600',
  })
  /** Revokes one refresh token (idempotent success). */
  async logout(@Body() dto: LogoutDto, @Req() req: ExpressRequest) {
    const raw = this.resolveRefreshRaw(dto, req);
    await this.authService.logout(raw);
    return { message: 'Logged out' };
  }

  @Post('/logout-all')
  @Auth()
  @UseGuards(RateLimitGuard)
  @ApiOperation({
    summary: 'Logout all sessions (tokenVersion++ + bulk revoke)',
  })
  @ApiResponse({ status: 200, description: 'All sessions revoked' })
  @ApiResponse({ status: 401, description: 'Unauthorized' })
  @ApiResponse({
    status: 429,
    description: 'Too Many Requests — Retry-After: 3600',
  })
  /** Revokes all sessions via tokenVersion++ plus bulk revoke. */
  async logoutAll(@CurrentUser() user: Partial<User> & { sub: string }) {
    // S-1: JwtGuard is the sole path, so the payload shape ({sub}) always holds.
    const userId = user.sub;
    await this.authService.logoutAll(userId);
    return { message: 'All sessions revoked' };
  }

  @Get('/google')
  @UseGuards(GoogleAuthGuard)
  @ApiOperation({ summary: 'Initiate Google OAuth (302)' })
  /** Initiates Google OAuth (passport redirect). */
  async googleAuth() {}

  @Get('/google/callback')
  @UseGuards(RateLimitGuard, GoogleAuthGuard)
  @ApiOperation({ summary: 'Google OAuth callback (JSON)' })
  @ApiResponse({
    status: 429,
    description: 'Too Many Requests — Retry-After: 3600',
  })
  /** Completes Google OAuth; returns the pair plus refresh cookie. */
  async googleCallback(
    @Request() req: ExpressRequest & { user: GoogleProfile },
    @Res({ passthrough: true }) res: ExpressResponse,
  ) {
    const profile = req.user;
    const result = await this.authService.loginWithGoogle(profile);
    // Set refresh cookie same as login
    res.cookie(
      this.getRefreshCookieName(),
      result.refreshToken,
      this.getRefreshCookieOptions(),
    );
    return {
      accessToken: result.accessToken,
      refreshToken: result.refreshToken,
    };
  }

  @Get('/google/link')
  @Auth()
  @UseGuards(GoogleAuthGuard)
  @ApiOperation({ summary: 'Link Google to current user' })
  /** Links the Google identity to the current user. */
  async googleLink(
    @CurrentUser() user: Partial<User> & { sub: string },
    @Request()
    req: ExpressRequest & {
      user: Partial<User> & { sub: string } & Partial<GoogleProfile>;
    },
  ) {
    const profile = req.user as GoogleProfile;
    // S-1: JwtGuard payload always carries sub (no entity-shape fallback).
    await this.authService.linkGoogleAccount(user.sub, profile);
    return { message: 'Google linked.' };
  }
}
