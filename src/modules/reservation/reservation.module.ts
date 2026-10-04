import { BullModule } from '@nestjs/bullmq';
import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { TypeOrmModule } from '@nestjs/typeorm';
import Redis from 'ioredis';
import { Reservation } from './entities/reservation.entity';
import { ReservationItem } from './entities/reservation-item.entity';
import { ReservationService } from './reservation.service';
import { ReservationController } from './reservation.controller';
import { ReservationExpirationProcessor } from './reservation-expiration.processor';
import { ReservationExpirationService } from './reservation-expiration.service';
import { OutboxModule } from '../outbox/outbox.module';
// AuthModule (re-exports UsersModule): @Auth() JwtGuard needs UsersService
// in this scope (S-1 wiring).
import { AuthModule } from '../auth/auth.module';

@Module({
  imports: [
    ConfigModule,
    TypeOrmModule.forFeature([Reservation, ReservationItem]),
    BullModule.registerQueue({ name: 'reservation-expiration' }),
    OutboxModule,
    AuthModule,
  ],
  controllers: [ReservationController],
  providers: [
    ReservationService,
    ReservationExpirationService,
    ReservationExpirationProcessor,
    {
      provide: 'REDIS_CLIENT',
      useFactory: (configService: ConfigService) => {
        const url = configService.get<string>('REDIS_URL');
        // ioredis client with lazyConnect — fails gracefully if Redis down (poison falls back to memory)
        try {
          if (url)
            return new Redis(url, {
              lazyConnect: true,
              maxRetriesPerRequest: 1,
            });
          const host = configService.get<string>('REDIS_HOST', '127.0.0.1');
          const port = parseInt(
            configService.get<string>('REDIS_PORT', '6379'),
            10,
          );
          return new Redis({
            host,
            port,
            lazyConnect: true,
            maxRetriesPerRequest: 1,
          });
        } catch {
          return null;
        }
      },
      inject: [ConfigService],
    },
  ],
  exports: [ReservationService, ReservationExpirationService],
})
export class ReservationModule {}
