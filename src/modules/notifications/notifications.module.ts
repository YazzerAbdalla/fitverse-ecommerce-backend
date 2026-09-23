import { Module } from '@nestjs/common';
import { NotificationWorker } from './notifications.worker';

/**
 * This module exposes notification consumption.
 * It handles at-least-once handling without business mutation.
 */
@Module({
  providers: [NotificationWorker],
  exports: [NotificationWorker],
})
export class NotificationsModule {}
