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
import { NoopWhatsAppProvider } from './providers/whatsapp.provider';
import { RateLimitGuard } from './guards/rate-limit.guard';

@Module({
  imports: [
    UsersModule,
    TypeOrmModule.forFeature([PasswordResetToken, OtpVerification]),
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
    { provide: 'WHATSAPP_PROVIDER', useClass: NoopWhatsAppProvider },
  ],
  controllers: [AuthController],
  exports: [AuthService, RateLimitGuard],
})
export class AuthModule {}
