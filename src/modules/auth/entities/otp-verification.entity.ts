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

export enum OtpPurpose {
  Login = 'login',
  VerifyPhone = 'verify_phone',
}

@Entity()
@Check(`"expiresAt" > "createdAt"`)
@Check(`"attempts" <= 3`)
@Index('IDX_otp_phoneNumber', ['phoneNumber'])
@Index('IDX_otp_expiresAt', ['expiresAt'])
@Index('IDX_otp_phoneNumber_createdAt', ['phoneNumber', 'createdAt'])
export class OtpVerification {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column()
  phoneNumber!: string;

  @Column({ type: 'uuid', nullable: true })
  userId!: string | null;

  @ManyToOne(() => User, { nullable: true, onDelete: 'SET NULL' })
  @JoinColumn({ name: 'userId' })
  user!: User | null;

  @Column({ type: 'enum', enum: OtpPurpose, default: OtpPurpose.Login })
  purpose!: OtpPurpose;

  @Column()
  codeHash!: string;

  @Column({ type: 'timestamptz' })
  expiresAt!: Date;

  @Column({ default: 0 })
  attempts!: number;

  @Column({ type: 'timestamptz', nullable: true })
  verifiedAt!: Date | null;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt!: Date;
}
