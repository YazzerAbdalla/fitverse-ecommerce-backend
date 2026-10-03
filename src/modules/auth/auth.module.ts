/**
 * Auth module wiring: services, guards, strategies, token stores, and the
 * startup-resolved token config. Exports shared guards + UsersService access.
 *
 * Responsibility (SRP): auth dependency wiring, nothing else.
 * Used by: AppModule; Order/Cart/Products/Notifications/Inventory/
 *   Reservation/Outbox modules (shared guards + UsersService scope).
 * Depends on: UsersModule, TypeOrmModule (token entities), JwtModule,
 *   PassportModule, ConfigModule.
 */
import { Logger, Module } from '@nestjs/common';
import { UsersModule } from '../users/users.module';
import { AuthController } from './auth.controller';
import { AuthService } from './auth.service';
import { JwtModule } from '@nestjs/jwt';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { PassportModule } from '@nestjs/passport';
import { LocalStrategy } from './strategies/local.strategy';
import { JwtStrategy } from './strategies/jwt.strategy';
import { GoogleStrategy } from './strategies/google.strategy';
import { TypeOrmModule } from '@nestjs/typeorm';
import { PasswordResetToken } from './entities/password-reset-token.entity';
import { OtpVerification } from './entities/otp-verification.entity';
import { EmailVerificationToken } from './entities/email-verification-token.entity';
import { RefreshToken } from './entities/refresh-token.entity';
import { NoopWhatsAppProvider } from './providers/whatsapp.provider';
import { NoopEmailProvider } from '../notifications/email.provider';
import { SmtpEmailProvider } from '../notifications/smtp-email.provider';
import { RateLimitGuard } from './guards/rate-limit.guard';
import { JwtGuard } from './guards/jwt.guard';
import { AUTH_TOKEN_CONFIG, resolveAuthTokenConfig } from './auth-token.config';
import { RefreshTokenStore } from './stores/refresh-token.store';
import { PasswordResetTokenStore } from './stores/password-reset-token.store';
import { VerificationTokenStore } from './stores/verification-token.store';
import { OtpStore } from './stores/otp.store';
import { AuthEventPublisher } from './auth-event.publisher';
import { SystemClock } from '../../common/clock';

@Module({
  imports: [
    UsersModule,
    TypeOrmModule.forFeature([
      PasswordResetToken,
      OtpVerification,
      RefreshToken,
      EmailVerificationToken,
    ]),
    JwtModule.registerAsync({
      global: true,
      imports: [ConfigModule],
      inject: [ConfigService],
      useFactory: (configService: ConfigService) => ({
        secret: configService.get<string>('JWT_SECRET'),
        expiresIn: configService.get<string>('JWT_EXPIRES_IN'),
      }),
    }),
    PassportModule.register({ session: false }),
  ],
  providers: [
    AuthService,
    Logger,
    LocalStrategy,
    JwtStrategy,
    GoogleStrategy,
    RateLimitGuard,
    JwtGuard,
    RefreshTokenStore,
    PasswordResetTokenStore,
    VerificationTokenStore,
    OtpStore,
    AuthEventPublisher,
    SystemClock,
    {
      // Parsed once at startup (T010): TTL/cooldown/cookie/OAuth settings with
      // legacy-identical defaults. No hard-fail on missing keys (warn-once).
      provide: AUTH_TOKEN_CONFIG,
      inject: [ConfigService, Logger],
      useFactory: (config: ConfigService, logger: Logger) =>
        resolveAuthTokenConfig(config, logger),
    },
    { provide: 'WHATSAPP_PROVIDER', useClass: NoopWhatsAppProvider },
    SmtpEmailProvider,
    NoopEmailProvider,
    {
      provide: 'EMAIL_PROVIDER',
      inject: [ConfigService, SmtpEmailProvider, NoopEmailProvider],
      useFactory: (
        config: ConfigService,
        smtp: SmtpEmailProvider,
        noop: NoopEmailProvider,
      ) => {
        // Same EMAIL_PROVIDER switch as NotificationsModule (smtp/resend in prod, noop in dev/test)
        const provider = config.get<string>('EMAIL_PROVIDER') ?? 'noop';
        return ['smtp', 'resend'].includes(provider.toLowerCase())
          ? smtp
          : noop;
      },
    },
  ],
  controllers: [AuthController],
  // UsersModule is re-exported so every AuthModule importer (order, cart,
  // products, notifications, inventory, reservation, outbox) can resolve the
  // unified JwtGuard's UsersService in its own scope (S-1 wiring).
  exports: [
    AuthService,
    RateLimitGuard,
    JwtGuard,
    UsersModule,
    'EMAIL_PROVIDER',
  ],
})
export class AuthModule {}
