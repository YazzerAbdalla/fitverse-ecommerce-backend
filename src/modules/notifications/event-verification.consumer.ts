import { Injectable, Logger } from '@nestjs/common';
import { Ctx, EventPattern, Payload, RmqContext } from '@nestjs/microservices';

/**
 * This consumer is responsible for verification of domain events from RabbitMQ.
 * It handles at-least-once delivery (noAck=false, manual ACK after processing) and is duplicate tolerant.
 * Phase 11 verification consumer performs no business mutation and therefore tolerates duplicate events.
 * Persistent consumer-side idempotency is deferred to future consumers (email, webhooks).
 * SENT in outbox_event means published to RabbitMQ exchange, not that this consumer processed it.
 */
@Injectable()
export class EventVerificationConsumer {
  private readonly logger = new Logger(EventVerificationConsumer.name);

  /**
   * Handles order.created events with manual ACK.
   * @param data - Event envelope {version, eventId, eventType, occurredAt, correlationId, data}
   * @param context - RmqContext for manual acknowledgement
   */
  @EventPattern('order.created')
  async handleOrderCreated(@Payload() data: any, @Ctx() context?: RmqContext): Promise<void> {
    const channel = context?.getChannelRef();
    const originalMsg = context?.getMessage();
    try {
      const envelope = data as any;
      const eventId = envelope?.eventId || envelope?.data?.eventId || envelope?.payload?.eventId || 'unknown';
      const correlationId = envelope?.correlationId || envelope?.data?.correlationId || 'unknown';
      const orderId = envelope?.data?.orderId || envelope?.orderId || 'unknown';
      // Duplicate tolerant — no business mutation, just log (in-memory Set not needed for correctness)
      this.logger.log(
        `notification received order.created eventId=${eventId} correlationId=${correlationId} orderId=${orderId}`,
      );
      // ACK only after verification processing succeeds
      if (channel && originalMsg) channel.ack(originalMsg);
    } catch (e: any) {
      this.logger.error(`order.created processing failed: ${e?.message}`, e?.stack);
      // No ACK — allow RabbitMQ requeue/redelivery per queue config
      // Do not throw to prevent double ACK; rely on noAck=false
    }
  }

  /**
   * Handles order.completed events.
   * @param data - Event envelope
   * @param context - RmqContext
   */
  @EventPattern('order.completed')
  async handleOrderCompleted(@Payload() data: any, @Ctx() context?: RmqContext): Promise<void> {
    const channel = context?.getChannelRef();
    const originalMsg = context?.getMessage();
    try {
      const envelope = data as any;
      const eventId = envelope?.eventId || 'unknown';
      const correlationId = envelope?.correlationId || 'unknown';
      const orderId = envelope?.data?.orderId || envelope?.orderId || 'unknown';
      this.logger.log(
        `notification received order.completed eventId=${eventId} correlationId=${correlationId} orderId=${orderId}`,
      );
      if (channel && originalMsg) channel.ack(originalMsg);
    } catch (e: any) {
      this.logger.error(`order.completed processing failed: ${e?.message}`, e?.stack);
    }
  }

  /**
   * Handles order.cancelled events.
   * @param data - Event envelope
   * @param context - RmqContext
   */
  @EventPattern('order.cancelled')
  async handleOrderCancelled(@Payload() data: any, @Ctx() context?: RmqContext): Promise<void> {
    const channel = context?.getChannelRef();
    const originalMsg = context?.getMessage();
    try {
      const envelope = data as any;
      const eventId = envelope?.eventId || 'unknown';
      const correlationId = envelope?.correlationId || 'unknown';
      const orderId = envelope?.data?.orderId || envelope?.orderId || 'unknown';
      this.logger.log(
        `notification received order.cancelled eventId=${eventId} correlationId=${correlationId} orderId=${orderId}`,
      );
      if (channel && originalMsg) channel.ack(originalMsg);
    } catch (e: any) {
      this.logger.error(`order.cancelled processing failed: ${e?.message}`, e?.stack);
    }
  }

  /**
   * Handles reservation.expired events.
   * @param data - Event envelope
   * @param context - RmqContext
   */
  @EventPattern('reservation.expired')
  async handleReservationExpired(@Payload() data: any, @Ctx() context?: RmqContext): Promise<void> {
    const channel = context?.getChannelRef();
    const originalMsg = context?.getMessage();
    try {
      const envelope = data as any;
      const eventId = envelope?.eventId || 'unknown';
      const correlationId = envelope?.correlationId || 'unknown';
      const reservationId = envelope?.data?.reservationId || envelope?.reservationId || 'unknown';
      this.logger.log(
        `notification received reservation.expired eventId=${eventId} correlationId=${correlationId} reservationId=${reservationId}`,
      );
      if (channel && originalMsg) channel.ack(originalMsg);
    } catch (e: any) {
      this.logger.error(`reservation.expired processing failed: ${e?.message}`, e?.stack);
    }
  }
}

/**
 * @deprecated Use EventVerificationConsumer — NotificationWorker kept for backward compat.
 * Phase 11 does not implement end-user notifications; this verification consumer only logs.
 */
export class NotificationWorker extends EventVerificationConsumer {}
