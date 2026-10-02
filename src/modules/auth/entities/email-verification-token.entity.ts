import {
  Check,
  Column,
  CreateDateColumn,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
} from 'typeorm';
import User from '../../users/entity/user.entity';

/**
 * This entity represents a single-use email verification token (Phase 18, FR-001).
 * It handles sha256-hashed 24h verification hashes and enforces single-use via usedAt.
 */
@Entity('email_verification_token')
@Check(`"expiresAt" > "createdAt"`)
@Index('IDX_email_verification_token_userId', ['userId'])
@Index('IDX_email_verification_token_tokenHash', ['tokenHash'])
@Index('IDX_email_verification_token_expiresAt', ['expiresAt'])
@Index('IDX_email_verification_token_userId_expiresAt', ['userId', 'expiresAt'])
export class EmailVerificationToken {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ type: 'uuid' })
  userId!: string;

  @ManyToOne(() => User, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'userId' })
  user!: User;

  @Column({ type: 'varchar', length: 255 })
  tokenHash!: string;

  @Column({ type: 'timestamptz' })
  expiresAt!: Date;

  @Column({ type: 'timestamptz', nullable: true })
  usedAt!: Date | null;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt!: Date;
}
