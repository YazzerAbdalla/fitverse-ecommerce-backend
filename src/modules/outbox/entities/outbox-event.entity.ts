import {
  Check,
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
} from 'typeorm';
import { OutboxStatus } from './outbox-status.enum';

/**
 * This entity represents the transactional outbox for at-least-once domain events.
 * It handles durable buffering so business commit never depends on RabbitMQ availability.
 * Events are inserted inside the same DataSource.transaction as business state (FR-002)
 * and published asynchronously by OutboxPublisher via FOR UPDATE SKIP LOCKED.
 */
@Entity('outbox_event')
@Index(['status', 'nextRetryAt', 'createdAt'])
@Index(['eventType'])
@Index(['aggregateId'])
@Index(['createdAt'])
@Check(`"attempts" >= 0`)
@Check(`"payload"->>'version' IS NOT NULL`)
export class OutboxEvent {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ type: 'varchar', length: 64 })
  eventType!: string;

  @Column({ type: 'varchar', length: 32 })
  aggregateType!: string;

  @Column({ type: 'uuid' })
  aggregateId!: string;

  @Column({ type: 'jsonb' })
  payload!: Record<string, unknown>;

  @Column({
    type: 'enum',
    enum: OutboxStatus,
    default: OutboxStatus.PENDING,
  })
  status!: OutboxStatus;

  @Column({ type: 'int', default: 0 })
  attempts!: number;

  @Column({ type: 'timestamptz', default: () => 'NOW()' })
  nextRetryAt!: Date;

  @Column({ type: 'varchar', length: 1000, nullable: true })
  lastError!: string | null;

  @Column({ type: 'timestamptz', nullable: true })
  processingStartedAt!: Date | null;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt!: Date;

  @Column({ type: 'timestamptz', nullable: true })
  sentAt!: Date | null;
}
