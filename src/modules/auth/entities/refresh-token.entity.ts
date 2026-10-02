import {
  Check,
  Column,
  CreateDateColumn,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';
import User from '../../users/entity/user.entity';

/**
 * This entity represents a refresh token for silent accessToken renewal.
 * It handles opaque token storage (sha256 hash only) and enforces single-use rotation.
 */
@Entity('refresh_token')
@Check(`"expiresAt" > "createdAt"`)
@Index('IDX_refresh_token_userId', ['userId'])
@Index('IDX_refresh_token_tokenHash', ['tokenHash'])
@Index('IDX_refresh_token_expiresAt', ['expiresAt'])
@Index('IDX_refresh_token_userId_expiresAt', ['userId', 'expiresAt'])
export class RefreshToken {
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
  revokedAt!: Date | null;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt!: Date;

  @UpdateDateColumn({ type: 'timestamptz' })
  updatedAt!: Date;
}
