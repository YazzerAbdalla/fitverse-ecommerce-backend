import { BullModule } from '@nestjs/bullmq';
import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { TypeOrmModule } from '@nestjs/typeorm';
import { AuthModule } from '../auth/auth.module';
import { NotificationWorker } from './notifications.worker';
import { EMAIL_PROVIDER, NoopEmailProvider } from './email.provider';
import { SmtpEmailProvider } from './smtp-email.provider';
import { NotificationLog } from './entities/notification-log.entity';
import { Notification } from './entities/notification.entity';
import { NotificationDelivery } from './entities/notification-delivery.entity';
import { SystemChannel } from './channels/system.channel';
import { EmailChannel } from './channels/email.channel';
import { NotificationChannelFactory } from './channels/notification-channel.factory';
import { NotificationDispatcher } from './notification.dispatcher';
import { NotificationBulkProcessor } from './notification-bulk.processor';
import { NotificationsGateway } from './notifications.gateway';
import { NotificationService } from './notification.service';
import { NotificationsController } from './notifications.controller';

/**
 * This module exposes notification consumption for Phase 12.
 * It handles at-least-once handling with Redis idempotency (SET NX EX 24h) before EmailProvider side-effects.
 * Phase 12 dedup ensures duplicate eventId delivery skips EmailProvider.send and NotificationLog insert, with log+counter observability.
 * Phase 18 reuses this module for sales/new-product bulk fan-out via the 'notification' BullMQ queue (no new top-level module).
 * Phase 18 US6/US7 adds delivery-state (CONSUMED + per-channel NotificationDelivery) plus dual-channel dispatch and WS history.
 */
@Module({
  imports: [
    TypeOrmModule.forFeature([
      NotificationLog,
      Notification,
      NotificationDelivery,
    ]),
    BullModule.registerQueue({ name: 'notification' }),
    AuthModule,
  ],
  controllers: [NotificationsController],
  providers: [
    NotificationWorker,
    NotificationBulkProcessor,
    NotificationsGateway,
    NotificationService,
    SystemChannel,
    EmailChannel,
    NotificationChannelFactory,
    NotificationDispatcher,
    SmtpEmailProvider,
    NoopEmailProvider,
    {
      provide: EMAIL_PROVIDER,
      inject: [ConfigService, SmtpEmailProvider, NoopEmailProvider],
      useFactory: (
        config: ConfigService,
        smtp: SmtpEmailProvider,
        noop: NoopEmailProvider,
      ) => {
        // EMAIL_PROVIDER switch is config-driven (smtp/resend in prod, noop in dev/test) — never hardcoded
        const provider = config.get<string>('EMAIL_PROVIDER') ?? 'noop';
        // 'resend' uses Resend's SMTP relay via the same nodemailer transport
        return ['smtp', 'resend'].includes(provider.toLowerCase())
          ? smtp
          : noop;
      },
    },
  ],
  exports: [
    NotificationWorker,
    NotificationService,
    EMAIL_PROVIDER,
    SystemChannel,
    EmailChannel,
    NotificationChannelFactory,
    NotificationDispatcher,
  ],
})
export class NotificationsModule {}
