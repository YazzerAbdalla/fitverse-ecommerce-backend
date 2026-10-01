import {
  Body,
  Controller,
  Get,
  HttpException,
  HttpStatus,
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
import { JwtAuthGuard } from './guards/jwt-auth.guard';
import { RateLimitGuard } from './guards/rate-limit.guard';
import { CurrentUser } from './decorators/current-user.decorator';
import { RefreshTokenDto, LogoutDto } from './dto/refresh-token.dto';
import { VerifyEmailDto } from './dto/verify-email.dto';
import { ResendVerificationDto } from './dto/resend-verification.dto';
import { ConfigService } from '@nestjs/config';
import { Auth } from './decorators/auth.decorator';

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
  ) {}

  private getRefreshCookieName(): string {
    return (
      this.configService.get<string>('REFRESH_TOKEN_COOKIE_NAME') ||
      'refresh_token'
    );
  }

  private getRefreshCookieOptions() {
    const ttl = this.configService.get<string>('REFRESH_TOKEN_TTL') || '7d';
    // Parse TTL to ms for maxAge (reuse parse logic — simple fallback 7d)
    let maxAge = 7 * 24 * 3600 * 1000;
    if (ttl.endsWith('d')) maxAge = parseInt(ttl, 10) * 24 * 3600 * 1000;
    else if (ttl.endsWith('h')) maxAge = parseInt(ttl, 10) * 3600 * 1000;
    else if (ttl.endsWith('m')) maxAge = parseInt(ttl, 10) * 60_000;
    else if (ttl.endsWith('s')) maxAge = parseInt(ttl, 10) * 1000;
    const secure =
      this.configService.get<string>('REFRESH_TOKEN_COOKIE_SECURE') === 'true';
    return {
      httpOnly: true,
      secure,
      sameSite: 'strict' as const,
      path: '/auth',
      maxAge,
    };
  }

  private resolveRefreshRaw(
    dto: RefreshTokenDto | LogoutDto | undefined,
    req: ExpressRequest,
  ): string | undefined {
    const bodyRaw = dto?.refreshToken;
    if (bodyRaw) return bodyRaw;
    const cookieName = this.getRefreshCookieName();
    const cookies = (req as any).cookies || {};
    if (cookies[cookieName]) return cookies[cookieName];
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
  @ApiResponse({ status: 201 })
  @ApiResponse({
    status: 429,
    description: 'Too Many Requests — Retry-After: 3600',
  })
  async register(@Body() userResgisterDto: UserRegisterDto) {
    return await this.authService.register(userResgisterDto);
  }

  @Post('/login')
  @UseGuards(RateLimitGuard, LocalAuthGuard)
  @ApiBody({ type: LoginDto })
  @ApiResponse({ status: 200, description: 'Login success with refresh' })
  @ApiResponse({ status: 401, description: 'Unauthorized' })
  @ApiResponse({
    status: 429,
    description: 'Too Many Requests — Retry-After: 3600',
  })
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
  @ApiResponse({
    status: 429,
    description: 'Too Many Requests — Retry-After: 3600',
  })
  async forgotPassword(@Body() dto: ForgotPasswordDto) {
    await this.authService.requestPasswordReset(dto.email);
    return { message: 'If an account exists, a reset link has been sent.' };
  }

  @Post('/validate-reset-token')
  @UseGuards(RateLimitGuard)
  @ApiOperation({ summary: 'Validate reset token' })
  @ApiResponse({
    status: 429,
    description: 'Too Many Requests — Retry-After: 3600',
  })
  async validateResetToken(@Body() dto: ValidateResetTokenDto) {
    await this.authService.validateResetToken(dto.email, dto.token);
    return { valid: true };
  }

  @Post('/reset-password')
  @UseGuards(RateLimitGuard)
  @ApiOperation({ summary: 'Reset password with token (single-use)' })
  @ApiResponse({
    status: 429,
    description: 'Too Many Requests — Retry-After: 3600',
  })
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
  async verifyEmailGet(@Query() dto: VerifyEmailDto) {
    return await this.authService.verifyEmail(dto);
  }

  @Post('/verify-email')
  @UseGuards(RateLimitGuard)
  @ApiOperation({ summary: 'Verify email via body' })
  @ApiResponse({ status: 200, description: 'Email verified' })
  @ApiResponse({ status: 400, description: 'Invalid or expired token' })
  @ApiResponse({
    status: 429,
    description: 'Too Many Requests — Retry-After: 3600',
  })
  async verifyEmailPost(@Body() dto: VerifyEmailDto) {
    return await this.authService.verifyEmail(dto);
  }

  @Post('/resend-verification')
  @UseGuards(RateLimitGuard)
  @ApiOperation({ summary: 'Resend verification email (anti-enumeration)' })
  @ApiResponse({ status: 200, description: 'Anti-enum message' })
  @ApiResponse({
    status: 429,
    description: 'Too Many Requests — Retry-After: 60 or 3600',
  })
  async resendVerification(@Body() dto: ResendVerificationDto) {
    return await this.authService.resendVerification(dto.email);
  }

  // TODO (Future) — WhatsApp OTP deferred per 2026-09-16, password-only login in V1
  // Endpoints return 501 until WhatsApp Business setup ready. Logic in AuthService remains but is paused.
  @Post('/otp/request')
  @UseGuards(RateLimitGuard)
  @ApiOperation({
    summary: 'Request WhatsApp OTP (login / verify_phone) — TODO Future (501)',
  })
  @ApiResponse({
    status: 429,
    description: 'Too Many Requests — Retry-After: 3600',
  })
  async requestOtp(
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
  @ApiResponse({
    status: 429,
    description: 'Too Many Requests — Retry-After: 3600',
  })
  async verifyOtp(@Body() _dto: VerifyOtpDto) {
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
  @ApiResponse({ status: 200, description: 'Rotated pair' })
  @ApiResponse({ status: 401, description: 'Invalid or expired refresh token' })
  @ApiResponse({ status: 400, description: 'Validation error' })
  @ApiResponse({
    status: 429,
    description: 'Too Many Requests — Retry-After: 3600',
  })
  async refresh(
    @Body() dto: RefreshTokenDto,
    @Req() req: ExpressRequest,
    @Res({ passthrough: true }) res: ExpressResponse,
  ) {
    const raw = this.resolveRefreshRaw(dto, req);
    const result = await this.authService.refresh(raw as string);
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
  @ApiResponse({ status: 200, description: 'Logged out' })
  @ApiResponse({
    status: 429,
    description: 'Too Many Requests — Retry-After: 3600',
  })
  async logout(@Body() dto: LogoutDto, @Req() req: ExpressRequest) {
    const raw = this.resolveRefreshRaw(dto, req);
    await this.authService.logout(raw);
    return { message: 'Logged out' };
  }

  @Post('/logout-all')
  @Auth()
  @UseGuards(RateLimitGuard, JwtAuthGuard)
  @ApiOperation({
    summary: 'Logout all sessions (tokenVersion++ + bulk revoke)',
  })
  @ApiResponse({ status: 200, description: 'All sessions revoked' })
  @ApiResponse({ status: 401, description: 'Unauthorized' })
  @ApiResponse({
    status: 429,
    description: 'Too Many Requests — Retry-After: 3600',
  })
  async logoutAll(@CurrentUser() user: Partial<User>) {
    await this.authService.logoutAll((user as any).id);
    return { message: 'All sessions revoked' };
  }

  @Get('/google')
  @UseGuards(GoogleAuthGuard)
  @ApiOperation({ summary: 'Initiate Google OAuth (302)' })
  async googleAuth() {}

  @Get('/google/callback')
  @UseGuards(RateLimitGuard, GoogleAuthGuard)
  @ApiOperation({ summary: 'Google OAuth callback (JSON)' })
  @ApiResponse({
    status: 429,
    description: 'Too Many Requests — Retry-After: 3600',
  })
  async googleCallback(
    @Request() req: ExpressRequest & { user: any },
    @Res({ passthrough: true }) res: ExpressResponse,
  ) {
    const profile = req.user;
    const result = await this.authService.handleGoogleLogin(profile);
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
  @UseGuards(JwtAuthGuard, GoogleAuthGuard)
  @ApiOperation({ summary: 'Link Google to current user' })
  async googleLink(
    @CurrentUser() user: Partial<User>,
    @Request() req: ExpressRequest & { user: any },
  ) {
    const profile = req.user;
    await this.authService.linkGoogleAccount((user as any).id, profile);
    return { message: 'Google linked.' };
  }
}
