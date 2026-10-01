import {
  Check,
  Column,
  Entity,
  Index,
  PrimaryGeneratedColumn,
  Unique,
} from 'typeorm';
import { NotificationChannel } from './notification-channel.enum';
import { NotificationStatus } from './notification-status.enum';

/**
 * This entity represents a per-channel delivery leg owned by NotificationsModule (data-model §3c).
 * It handles PENDING → SENT → DELIVERED transitions per (eventId, channel) and enforces
 * non-negative attempts with terminal FAILED after 3 channel attempts.
 */
@Entity('notification_delivery')
// Duplicate consume for the same channel upserts orIgnore with 0 new rows
@Unique('UQ_notification_delivery_eventId_channel', ['eventId', 'channel'])
@Index('IDX_notification_delivery_eventId', ['eventId'])
// Attempts must never go negative; incremented once per channel send attempt
@Check(`"attempts" >= 0`)
export class NotificationDelivery {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  // Logical link to OutboxEvent.id only (no hard FK so FAILED-retained rows survive business deletes)
  @Column({ type: 'uuid' })
  eventId!: string;

  @Column({
    type: 'enum',
    enum: NotificationChannel,
    enumName: 'notification_channel',
  })
  channel!: NotificationChannel;

  @Column({
    type: 'enum',
    enum: NotificationStatus,
    enumName: 'notification_status',
    default: NotificationStatus.PENDING,
  })
  status!: NotificationStatus;

  @Column({ type: 'int', default: 0 })
  attempts!: number;

  @Column({ type: 'varchar', length: 256, nullable: true })
  messageId!: string | null;

  @Column({ type: 'timestamptz', default: () => 'NOW()' })
  nextRetryAt!: Date;

  @Column({ type: 'timestamptz', nullable: true })
  deliveredAt!: Date | null;
}
