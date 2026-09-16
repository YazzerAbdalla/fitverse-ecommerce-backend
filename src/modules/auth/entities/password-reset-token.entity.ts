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

@Entity()
@Check(`"expiresAt" > "createdAt"`)
@Index('IDX_prt_userId', ['userId'])
@Index('IDX_prt_tokenHash', ['tokenHash'])
@Index('IDX_prt_expiresAt', ['expiresAt'])
@Index('IDX_prt_userId_expiresAt', ['userId', 'expiresAt'])
export class PasswordResetToken {
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
