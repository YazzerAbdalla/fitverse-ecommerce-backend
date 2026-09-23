import {
  Body,
  Controller,
  Get,
  HttpException,
  HttpStatus,
  Post,
  Request,
  UseGuards,
} from '@nestjs/common';
import type { Request as ExpressRequest } from 'express';
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

@Controller('auth')
@ApiTags('Auth')
export class AuthController {
  constructor(private readonly authService: AuthService) {}

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
  @ApiResponse({ status: 200 })
  @ApiResponse({
    status: 429,
    description: 'Too Many Requests — Retry-After: 3600',
  })
  async login(@Request() req: ExpressRequest & { user: Partial<User> }) {
    const user: Partial<User> = req.user;
    return await this.authService.login(user);
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
  async googleCallback(@Request() req: ExpressRequest & { user: any }) {
    const profile = req.user;
    const result = await this.authService.handleGoogleLogin(profile);
    return { accessToken: result.accessToken };
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
