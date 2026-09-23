import { Module } from '@nestjs/common';
import { EventVerificationConsumer, NotificationWorker } from './event-verification.consumer';

/**
 * This module exposes verification consumption for Phase 11.
 * It handles at-least-once handling without business mutation.
 * Phase 11 does not implement end-user notifications; future phases (Email, Webhooks) will.
 */
@Module({
  providers: [EventVerificationConsumer, NotificationWorker],
  exports: [EventVerificationConsumer, NotificationWorker],
})
export class NotificationsModule {}
