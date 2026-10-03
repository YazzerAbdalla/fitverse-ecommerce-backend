import { Logger, Module } from '@nestjs/common';
import { UsersModule } from '../users/users.module';
import { AuthController } from './auth.controller';
import { AuthService } from './auth.service';
import { JwtModule } from '@nestjs/jwt';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { PassportModule } from '@nestjs/passport';
import { LocalStrategy } from './strateges/local.strategy';
import { JwtStrategy } from './strateges/jwt.strategy';
import { GoogleStrategy } from './strateges/google.strategy';
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
