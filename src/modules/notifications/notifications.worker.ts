import { Injectable, Logger } from '@nestjs/common';
import { EventPattern, Payload } from '@nestjs/microservices';

/**
 * This worker is responsible for notification consumption.
 * It handles at-least-once domain events without mutating business state.
 */
@Injectable()
export class NotificationWorker {
  private readonly logger = new Logger(NotificationWorker.name);

  // In-memory dedup for V1 (future may use Redis SET NX or DB)
  private readonly processed = new Set<string>();

  /**
   * Handles order.created events.
   * @param data - Event payload containing eventId, version, correlationId, orderId, etc.
   */
  @EventPattern('order.created')
  async handleOrderCreated(@Payload() data: any): Promise<void> {
    const eventId = data?.eventId || data?.payload?.eventId || 'unknown';
    // at-least-once duplicate eventId tolerated — log and return
    if (this.processed.has(eventId)) {
      this.logger.log(
        `duplicate eventId=${eventId} already processed for order.created`,
      );
      return;
    }
    this.logger.log(
      `notification received order.created eventId=${eventId} correlationId=${data?.correlationId || data?.payload?.correlationId || 'unknown'} orderId=${data?.orderId || data?.payload?.orderId || 'unknown'}`,
    );
    this.processed.add(eventId);
    // No Inventory/Order mutation — consumer-side only
  }

  /**
   * Handles order.completed events.
   * @param data - Event payload.
   */
  @EventPattern('order.completed')
  async handleOrderCompleted(@Payload() data: any): Promise<void> {
    const eventId = data?.eventId || data?.payload?.eventId || 'unknown';
    if (this.processed.has(eventId)) {
      this.logger.log(
        `duplicate eventId=${eventId} already processed for order.completed`,
      );
      return;
    }
    this.logger.log(
      `notification received order.completed eventId=${eventId} correlationId=${data?.correlationId || 'unknown'} orderId=${data?.orderId || 'unknown'}`,
    );
    this.processed.add(eventId);
  }

  /**
   * Handles order.cancelled events.
   * @param data - Event payload.
   */
  @EventPattern('order.cancelled')
  async handleOrderCancelled(@Payload() data: any): Promise<void> {
    const eventId = data?.eventId || data?.payload?.eventId || 'unknown';
    if (this.processed.has(eventId)) {
      this.logger.log(
        `duplicate eventId=${eventId} already processed for order.cancelled`,
      );
      return;
    }
    this.logger.log(
      `notification received order.cancelled eventId=${eventId} correlationId=${data?.correlationId || 'unknown'} orderId=${data?.orderId || 'unknown'}`,
    );
    this.processed.add(eventId);
  }

  /**
   * Handles reservation.expired events.
   * @param data - Event payload.
   */
  @EventPattern('reservation.expired')
  async handleReservationExpired(@Payload() data: any): Promise<void> {
    const eventId = data?.eventId || data?.payload?.eventId || 'unknown';
    if (this.processed.has(eventId)) {
      this.logger.log(
        `duplicate eventId=${eventId} already processed for reservation.expired`,
      );
      return;
    }
    this.logger.log(
      `notification received reservation.expired eventId=${eventId} correlationId=${data?.correlationId || 'unknown'} reservationId=${data?.reservationId || 'unknown'}`,
    );
    this.processed.add(eventId);
  }
}
