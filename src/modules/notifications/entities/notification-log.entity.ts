import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
} from 'typeorm';

/**
 * This entity represents an audit log of outbound notifications.
 * It handles durable fallback dedup via eventId unique constraint and provides forensics.
 * Redis SET NX is primary dedup (24h); this table is optional fallback if Redis is flushed.
 */
@Entity('notification_log')
@Index(['userId'])
@Index(['aggregateId'])
@Index(['template'])
export class NotificationLog {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Index()
  @Column({ type: 'uuid' })
  userId!: string;

  @Column({ type: 'varchar', length: 64 })
  template!: string;

  @Column({ type: 'varchar', length: 256, nullable: true })
  subject!: string | null;

  @Index()
  @Column({ type: 'uuid', nullable: true })
  aggregateId!: string | null;

  @Index()
  @Column({ type: 'uuid', unique: true })
  eventId!: string;

  @Column({ type: 'varchar', length: 32, default: 'noop' })
  provider!: string;

  @Column({ type: 'varchar', length: 256, nullable: true })
  messageId!: string | null;

  @CreateDateColumn({ type: 'timestamptz' })
  sentAt!: Date;
}
