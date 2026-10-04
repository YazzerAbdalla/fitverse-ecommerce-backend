/**
 * Post-commit auth domain event publishing (transport + bounded wait + fail-open).
 *
 * Responsibility (SRP): post-commit auth event publishing, nothing else.
 * Used by: AuthService (register/reset/verify/resend flows, after commit).
 * Depends on: NOTIFICATION_SERVICE ClientProxy (optional).
 */
import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import { ClientProxy } from '@nestjs/microservices';
import { lastValueFrom } from 'rxjs';

/**
 * This publisher is responsible for emitting auth domain events AFTER the DB
 * commit (publish-after-commit). It owns the transport call, the bounded wait,
 * and fail-open logging — never the transaction.
 *
 * Responsibility (SRP): post-commit auth event publishing, nothing else.
 * Used by: AuthService (register/reset/verify/resend flows, after commit).
 * Depends on: NOTIFICATION_SERVICE ClientProxy (optional — absent in tests).
 *
 * Signature frozen for CC-C EventBusPort adoption in RP-OUTBOX (research D4).
 */
@Injectable()
export class AuthEventPublisher {
  private readonly logger = new Logger(AuthEventPublisher.name);

  constructor(
    @Optional()
    @Inject('NOTIFICATION_SERVICE')
    private readonly notificationClient?: ClientProxy,
  ) {}

  /**
   * Emits an auth domain event after the DB commit (publish-after-commit).
   * Never call inside dataSource.transaction — broker I/O stays outside the tx.
   * Fail-open: logs and resolves, never throws to the caller.
   *
   * @param eventType - Event name (email.verification_requested,
   *   auth.password_reset_requested, auth.email_verified).
   * @param payload - Event payload (may contain rawToken once; never logged raw).
   * @returns Void.
   */
  async emit(
    eventType: string,
    payload: Record<string, unknown>,
  ): Promise<void> {
    try {
      if (this.notificationClient) {
        // Bounded wait so a down broker can never hang the request path.
        const obs = this.notificationClient.emit(eventType, payload);
        await Promise.race([
          lastValueFrom(obs),
          new Promise((_, reject) =>
            setTimeout(() => reject(new Error('emit timeout 2000ms')), 2000),
          ),
        ]);
      }
      // Hash prefix only in logs — rawToken is never logged.
      const userId = payload.userId;
      const userLabel = typeof userId === 'string' ? userId : 'unknown';
      this.logger.log(
        `auth event emitted type=${eventType} userId=${userLabel}`,
      );
    } catch (e: unknown) {
      // Async after commit never rolls back business — log only.
      this.logger.error(
        `Failed to emit auth event type=${eventType}: ${(e as Error)?.message ?? e}`,
      );
    }
  }
}
