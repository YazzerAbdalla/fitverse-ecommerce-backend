import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
  Unique,
} from 'typeorm';
import User from '../../users/entity/user.entity';
import { NotificationChannel } from './notification-channel.enum';
import { NotificationStatus } from './notification-status.enum';

/**
 * This entity represents a user-visible inbox row (Phase 18 US7, data-model §3b).
 * It handles per-(eventId, channel) history with independent read state and enforces
 * one row per event-channel pair so dual-channel events yield two rows.
 */
@Entity('notification')
// One row per (eventId, channel): duplicate consume upserts orIgnore with 0 new rows
@Unique('UQ_notification_eventId_channel', ['eventId', 'channel'])
@Index('IDX_notification_userId', ['userId'])
@Index('IDX_notification_eventId', ['eventId'])
@Index('IDX_notification_channel', ['channel'])
@Index('IDX_notification_type', ['type'])
// History paging is always scoped to one user ordered by newest first
@Index('IDX_notification_userId_sentAt', ['userId', 'sentAt'])
// Unread-count is a filtered count on (userId, isRead=false)
@Index('IDX_notification_userId_isRead', ['userId', 'isRead'])
export class Notification {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ type: 'uuid' })
  userId!: string;

  @ManyToOne(() => User, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'userId' })
  user!: User;

  // Logical link to OutboxEvent.id only (no hard FK so FAILED-retained rows survive business deletes)
  @Column({ type: 'uuid' })
  eventId!: string;

  @Column({
    type: 'enum',
    enum: NotificationChannel,
    enumName: 'notification_channel',
  })
  channel!: NotificationChannel;

  @Column({ type: 'varchar', length: 64 })
  type!: string;

  @Column({ type: 'varchar', length: 256 })
  title!: string;

  @Column({ type: 'text' })
  body!: string;

  @Column({ type: 'jsonb', default: {} })
  data!: Record<string, unknown>;

  @Column({
    type: 'enum',
    enum: NotificationStatus,
    enumName: 'notification_status',
    default: NotificationStatus.PENDING,
  })
  status!: NotificationStatus;

  @Column({ type: 'boolean', default: false })
  isRead!: boolean;

  @Column({ type: 'timestamptz', nullable: true })
  readAt!: Date | null;

  @CreateDateColumn({ type: 'timestamptz' })
  sentAt!: Date;

  @Column({ type: 'timestamptz', nullable: true })
  deliveredAt!: Date | null;
}
