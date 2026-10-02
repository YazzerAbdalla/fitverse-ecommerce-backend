import { BadRequestException, Injectable } from '@nestjs/common';
import { EmailChannel } from './email.channel';
import type {
  NotificationChannel,
  NotificationChannelKey,
} from './notification-channel.interface';
import { SystemChannel } from './system.channel';

/**
 * This service is responsible for resolving notification channel strategies.
 * It handles extensible channel lookup so future sms|push channels plug in without caller changes.
 */
@Injectable()
export class NotificationChannelFactory {
  constructor(
    private readonly systemChannel: SystemChannel,
    private readonly emailChannel: EmailChannel,
  ) {}

  /**
   * Creates the strategy for a channel key.
   * @param channel - Channel key ('system' | 'email').
   * @returns Strategy implementing NotificationChannel.
   * @throws BadRequestException for unknown channels (e.g. 'sms' pre-V2).
   */
  create(channel: string): NotificationChannel {
    // Normalized lookup keeps dispatcher input case-tolerant ('SYSTEM' vs 'system').
    const key = (channel ?? '').toLowerCase();
    if (key === 'system') return this.systemChannel;
    if (key === 'email') return this.emailChannel;
    // Unknown channel (e.g. 'sms') is a client/config error — 400, never silent fallback.
    throw new BadRequestException(`Unknown notification channel: ${channel}`);
  }

  /**
   * Lists supported channel keys (used for validation/logging).
   * @returns Supported keys in V1.
   */
  supported(): NotificationChannelKey[] {
    return ['system', 'email'];
  }
}
