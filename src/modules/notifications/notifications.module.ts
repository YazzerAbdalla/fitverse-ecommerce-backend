import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { EventVerificationConsumer } from './event-verification.consumer';
import { NotificationWorker } from './notifications.worker';
import { EMAIL_PROVIDER, NoopEmailProvider } from './email.provider';
import { NotificationLog } from './entities/notification-log.entity';

/**
 * This module exposes notification consumption for Phase 12.
 * It handles at-least-once handling with Redis idempotency (SET NX EX 24h) before EmailProvider side-effects.
 * Phase 12 dedup ensures duplicate eventId delivery skips EmailProvider.send and NotificationLog insert, with log+counter observability.
 */
@Module({
  imports: [TypeOrmModule.forFeature([NotificationLog])],
  providers: [
    EventVerificationConsumer,
    NotificationWorker,
    {
      provide: EMAIL_PROVIDER,
      useClass: NoopEmailProvider,
    },
  ],
  exports: [EventVerificationConsumer, NotificationWorker, EMAIL_PROVIDER],
})
export class NotificationsModule {}
