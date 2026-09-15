import {
  BadRequestException,
  Inject,
  Injectable,
  Logger,
  UnauthorizedException,
} from '@nestjs/common';
import * as bcrypt from 'bcrypt';
import * as crypto from 'crypto';
import { UsersService } from '../users/users.service';
import { UserRegisterDto } from './dto/user-register.dto';
import User, { AuthProvider } from '../users/entity/user.entity';
import { JwtService } from '@nestjs/jwt';
import { JwtPayloadProps } from './types';
import { DataSource } from 'typeorm';
import { PasswordResetToken } from './entities/password-reset-token.entity';
import {
  OtpVerification,
  OtpPurpose,
} from './entities/otp-verification.entity';
import { CACHE_MANAGER } from '@nestjs/cache-manager';
import type { Cache } from 'cache-manager';
import { ConfigService } from '@nestjs/config';
import type { WhatsAppProvider } from './providers/whatsapp.provider';
import { GoogleProfile } from './strateges/google.strategy';

@Injectable()
export class AuthService {
  constructor(
    private readonly usersService: UsersService,
    private readonly logger: Logger,
    private readonly jwtService: JwtService,
    private readonly dataSource: DataSource,
    @Inject(CACHE_MANAGER) private readonly cache: Cache,
    private readonly configService: ConfigService,
    @Inject('WHATSAPP_PROVIDER')
    private readonly whatsappProvider: WhatsAppProvider,
  ) {}

  private saltOrRounds = 10;

  // For testing: allow capturing raw tokens
  public lastRawToken?: string;
  public lastOtp?: string;

  async register(userRegisterDto: UserRegisterDto) {
    const { email, password } = userRegisterDto;
    this.logger.debug(`Register attempt for ${email}`);
    // Check if this email already exist
    const isEmailExist = await this.usersService.findUserByEmail(email);
    if (isEmailExist) {
      this.logger.error(`User try to use duplicated email ${email}`);
      throw new BadRequestException('This email already exist.');
    }

    const hashedPassword = await bcrypt.hash(password, this.saltOrRounds);

    const newUser = { ...userRegisterDto, password: hashedPassword };

    await this.usersService.createNewUser(newUser);

    this.logger.log(`New user with email ${email} had registered successfuly`);

    return { message: 'User created successfuly.', data: newUser };
  }

  async userValidation(
    email: string,
    password: string,
  ): Promise<null | Partial<User>> {
    const isUserExist = await this.usersService.findUserByEmail(email);
    if (!isUserExist || !isUserExist.password) return null;
    const isSamePasswordHash = await bcrypt.compare(
      password,
      isUserExist.password,
    );

    if (isSamePasswordHash) {
      const { password, ...filteredUser } = isUserExist;
      return filteredUser;
    }

    return null;
  }

  //Generate the jwt for user after validation his credentionals
  async login(user: Partial<User>) {
    const { id, email, firstName, lastName, role, tokenVersion } = user as any;
    const fullName = firstName + ' ' + lastName;
    const payload: JwtPayloadProps = {
      sub: id,
      email,
      fullName,
      role,
      tokenVersion: typeof tokenVersion === 'number' ? tokenVersion : 0,
    };

    const accessToken = await this.jwtService.signAsync(payload as any);

    this.logger.log(`User with email ${email} logged in successfuly.`);

    return { message: 'User loged in successfuly', accessToken };
  }

  // ============ Phase 16: Forgot Password & Recovery Token ============
  async requestPasswordReset(email: string): Promise<void> {
    const user = await this.usersService.findUserByEmail(email);
    if (!user) {
      this.logger.debug(`forgot-password: email not found ${email}`);
      return;
    }
    const rawToken = crypto.randomBytes(32).toString('hex');
    this.lastRawToken = rawToken;
    const tokenHash = crypto
      .createHash('sha256')
      .update(rawToken)
      .digest('hex');
    const ttl = this.configService.get<string>('RESET_TOKEN_TTL') || '15m';
    const expiresAt = new Date(Date.now() + this.parseTtlMs(ttl));

    await this.dataSource.transaction(async (manager) => {
      await manager
        .createQueryBuilder()
        .update(PasswordResetToken)
        .set({ usedAt: new Date() })
        .where(
          'userId = :userId AND "usedAt" IS NULL AND "expiresAt" > NOW()',
          {
            userId: user.id,
          },
        )
        .execute();
      const repo = manager.getRepository(PasswordResetToken);
      await repo.save(
        repo.create({
          userId: user.id,
          tokenHash,
          expiresAt,
          usedAt: null,
        }),
      );
    });
    // publish after commit (hybrid: RabbitMQ for password reset)
    try {
      this.logger.log(
        `Password reset token created for ${email}, expires ${expiresAt.toISOString()}`,
      );
      // TODO: publish to RabbitMQ topic auth.password_reset_requested
    } catch (e) {
      this.logger.warn(`Failed to publish password reset event: ${e}`);
    }
  }

  async validateResetToken(email: string, rawToken: string): Promise<User> {
    const user = await this.usersService.findUserByEmail(email);
    if (!user) throw new BadRequestException('Invalid or expired token.');
    const tokenHash = crypto
      .createHash('sha256')
      .update(rawToken)
      .digest('hex');
    const repo = this.dataSource.getRepository(PasswordResetToken);
    const token = await repo.findOne({
      where: { tokenHash, userId: user.id },
    });
    if (!token || token.usedAt || token.expiresAt.getTime() <= Date.now()) {
      throw new BadRequestException('Invalid or expired token.');
    }
    return user;
  }

  async resetPassword(dto: {
    email: string;
    token: string;
    newPassword: string;
  }): Promise<void> {
    if (dto.newPassword === dto.email) {
      throw new BadRequestException('Password must not equal email');
    }
    const user = await this.usersService.findUserByEmail(dto.email);
    if (!user) throw new BadRequestException('Invalid or expired token.');
    const tokenHash = crypto
      .createHash('sha256')
      .update(dto.token)
      .digest('hex');

    await this.dataSource.transaction(async (manager) => {
      const repo = manager.getRepository(PasswordResetToken);
      const token = await repo
        .createQueryBuilder('t')
        .setLock('pessimistic_write')
        .where('t.tokenHash = :tokenHash AND t.userId = :userId', {
          tokenHash,
          userId: user.id,
        })
        .getOne();
      if (!token || token.usedAt || token.expiresAt.getTime() <= Date.now()) {
        throw new BadRequestException('Invalid or expired token.');
      }
      const hashed = await bcrypt.hash(dto.newPassword, this.saltOrRounds);
      const userRepo = manager.getRepository(User);
      await userRepo.update(user.id, {
        password: hashed,
        tokenVersion: () => '"tokenVersion" + 1',
        passwordChangedAt: new Date(),
      });
      await repo.update(token.id, { usedAt: new Date() });
      // invalidate other active tokens
      await manager
        .createQueryBuilder()
        .update(PasswordResetToken)
        .set({ usedAt: new Date() })
        .where('userId = :userId AND id != :id AND "usedAt" IS NULL', {
          userId: user.id,
          id: token.id,
        })
        .execute();
    });
    this.logger.log(`Password reset successful for ${dto.email}`);
  }

  // ============ Phase 16: WhatsApp OTP — TODO (Future) DEFERRED per 2026-09-16 ============
  // Logic remains implemented but controller returns 501 until WhatsApp Business setup.
  // Password-only login is enforced in V1. Re-enable by removing 501 guard in auth.controller.ts.
  async requestWhatsAppOtp(
    dto: { phoneNumber?: string; purpose?: OtpPurpose },
    currentUser?: Partial<User>,
  ): Promise<{ expiresIn: number }> {
    let phone = dto.phoneNumber;
    if (!phone && (currentUser as any)?.phoneNumber)
      phone = (currentUser as any).phoneNumber;
    if (!phone) throw new BadRequestException('phoneNumber is required');
    const e164 = /^\+[1-9]\d{1,14}$/;
    if (!e164.test(phone))
      throw new BadRequestException('Invalid phoneNumber, must be E.164');
    const purpose = (dto.purpose as OtpPurpose) || OtpPurpose.Login;
    if ((purpose as unknown as string) === 'reset_password') {
      throw new BadRequestException(
        'purpose reset_password not supported in V1',
      );
    }
    // cooldown 60s via Redis SET NX EX
    const cooldownKey = `otp:cooldown:${phone}`;
    try {
      const exists = await (this.cache as any).get(cooldownKey);
      if (exists)
        throw new BadRequestException(
          'Resend cooldown active, try in 60 seconds',
        );
    } catch (e) {
      if (e?.status === 400) throw e;
      this.logger.warn(`Redis cooldown check fail-open: ${e}`);
    }
    const otp = crypto.randomInt(100000, 999999).toString();
    this.lastOtp = otp;
    const codeHash = crypto.createHash('sha256').update(otp).digest('hex');
    const ttlMs = this.parseTtlMs(
      this.configService.get<string>('OTP_TTL') || '5m',
    );
    const expiresAt = new Date(Date.now() + ttlMs);
    const cacheKey = `otp:whatsapp:${phone}`;
    try {
      await (this.cache as any).set(
        cacheKey,
        {
          hash: codeHash,
          attempts: 0,
          createdAt: Date.now(),
          expiresAt: expiresAt.getTime(),
          purpose,
        },
        ttlMs,
      );
      await (this.cache as any).set(cooldownKey, '1', 60_000);
    } catch (e) {
      this.logger.warn(`Redis set fail-open: ${e}`);
    }
    // persist to PG
    try {
      const repo = this.dataSource.getRepository(OtpVerification);
      const user = phone ? await this.findUserByPhone(phone) : null;
      await repo.save(
        repo.create({
          phoneNumber: phone,
          userId: user?.id || null,
          purpose,
          codeHash,
          expiresAt,
          attempts: 0,
          verifiedAt: null,
        } as any),
      );
    } catch (e) {
      this.logger.warn(`PG OtpVerification save failed: ${e}`);
    }
    try {
      await this.whatsappProvider.sendOtp(
        phone,
        otp,
        Math.round(ttlMs / 60000),
      );
    } catch (e) {
      this.logger.error(`WhatsApp send failed for ${phone}: ${e}`);
    }
    return { expiresIn: Math.round(ttlMs / 1000) };
  }

  async verifyWhatsAppOtp(dto: {
    phoneNumber: string;
    otp: string;
    purpose?: OtpPurpose;
  }): Promise<any> {
    const phone = dto.phoneNumber;
    const purpose = (dto.purpose as OtpPurpose) || OtpPurpose.Login;
    const codeHash = crypto.createHash('sha256').update(dto.otp).digest('hex');
    const cacheKey = `otp:whatsapp:${phone}`;
    let redisData: any = null;
    let redisAvailable = true;
    try {
      redisData = await (this.cache as any).get(cacheKey);
    } catch (e) {
      redisAvailable = false;
      this.logger.warn(`Redis get fail-open, fallback to DB: ${e}`);
    }

    // Redis path
    if (redisAvailable && redisData) {
      // increment attempts on every attempt per B2 choice B
      redisData.attempts = (redisData.attempts || 0) + 1;
      const attemptsOk = redisData.attempts <= 3;
      const notExpired = redisData.expiresAt > Date.now();
      const hashOk = this.timingSafeEqual(redisData.hash, codeHash);
      if (!notExpired) {
        try {
          await (this.cache as any).del(cacheKey);
        } catch {
          void 0;
        }
        throw new BadRequestException('Invalid or expired OTP');
      }
      if (!attemptsOk) {
        try {
          await (this.cache as any).del(cacheKey);
        } catch {
          void 0;
        }
        throw new BadRequestException('Too many attempts, request new OTP');
      }
      if (!hashOk) {
        try {
          await (this.cache as any).set(
            cacheKey,
            redisData,
            redisData.expiresAt - Date.now(),
          );
        } catch {
          void 0;
        }
        // also increment PG attempts
        await this.incrementOtpAttempts(phone);
        throw new BadRequestException('Invalid or expired OTP');
      }
      // success: delete Redis, update PG, mark phoneVerified / issue JWT
      try {
        await (this.cache as any).del(cacheKey);
      } catch {
        void 0;
      }
      await this.markOtpVerified(phone, purpose);
      return this.handleOtpSuccess(phone, purpose);
    }

    // Fallback DB path (Q4)
    const repo = this.dataSource.getRepository(OtpVerification);
    const latest = await repo.find({
      where: { phoneNumber: phone },
      order: { createdAt: 'DESC' },
      take: 1,
    });
    const row = latest[0];
    if (!row || row.verifiedAt || row.expiresAt.getTime() <= Date.now()) {
      throw new BadRequestException('Invalid or expired OTP');
    }
    // increment attempts on every attempt per B2
    row.attempts += 1;
    await repo.save(row);
    if (row.attempts > 3)
      throw new BadRequestException('Too many attempts, request new OTP');
    if (!this.timingSafeEqual(row.codeHash, codeHash)) {
      throw new BadRequestException('Invalid or expired OTP');
    }
    row.verifiedAt = new Date();
    await repo.save(row);
    return this.handleOtpSuccess(phone, purpose);
  }

  private async handleOtpSuccess(phone: string, purpose: OtpPurpose) {
    const user = await this.findUserByPhone(phone);
    if (purpose === OtpPurpose.VerifyPhone) {
      if (user) {
        await this.dataSource
          .getRepository(User)
          .update(user.id, { phoneVerified: true });
      }
      return { verified: true };
    }
    // purpose login
    const target = user;
    if (!target) {
      // if no user with phone, try to find or create? For login, require existing user; if not found, we can still allow? Create anonymous? For V1 require existing user with phone, else 400
      throw new BadRequestException('No user found with this phone number');
    }
    if (!target.phoneVerified) {
      await this.dataSource
        .getRepository(User)
        .update(target.id, { phoneVerified: true });
    }
    return this.login(target);
  }

  private async findUserByPhone(phone: string): Promise<User | null> {
    return await this.dataSource
      .getRepository(User)
      .findOne({ where: { phoneNumber: phone } });
  }

  private async incrementOtpAttempts(phone: string) {
    try {
      const repo = this.dataSource.getRepository(OtpVerification);
      const rows = await repo.find({
        where: { phoneNumber: phone },
        order: { createdAt: 'DESC' },
        take: 1,
      });
      if (rows[0]) {
        rows[0].attempts += 1;
        await repo.save(rows[0]);
      }
    } catch {
      void 0;
    }
  }

  private async markOtpVerified(phone: string, purpose: OtpPurpose) {
    try {
      const repo = this.dataSource.getRepository(OtpVerification);
      const rows = await repo.find({
        where: { phoneNumber: phone, purpose },
        order: { createdAt: 'DESC' },
        take: 1,
      });
      if (rows[0]) {
        rows[0].verifiedAt = new Date();
        rows[0].attempts += 1;
        await repo.save(rows[0]);
      }
    } catch {
      void 0;
    }
  }

  private timingSafeEqual(a: string, b: string): boolean {
    try {
      const bufA = Buffer.from(a, 'utf8');
      const bufB = Buffer.from(b, 'utf8');
      if (bufA.length !== bufB.length) return false;
      return crypto.timingSafeEqual(bufA, bufB);
    } catch {
      return a === b;
    }
  }

  private parseTtlMs(ttl: string): number {
    if (ttl.endsWith('m')) return parseInt(ttl, 10) * 60_000;
    if (ttl.endsWith('s')) return parseInt(ttl, 10) * 1000;
    if (ttl.endsWith('h')) return parseInt(ttl, 10) * 3600_000;
    return 15 * 60_000;
  }

  // ============ Phase 16: Google OAuth ============
  async handleGoogleLogin(
    profile: GoogleProfile,
  ): Promise<{ user: User; accessToken: string }> {
    if (!profile.verified)
      throw new BadRequestException('Google email not verified');
    const user = await this.usersService.findByGoogleId(profile.googleId);
    if (user) {
      const token = (await this.login(user)).accessToken;
      return { user, accessToken: token };
    }
    const existingByEmail = await this.usersService.findUserByEmail(
      profile.email,
    );
    if (existingByEmail) {
      // auto-link per Q1
      await this.dataSource.getRepository(User).update(existingByEmail.id, {
        googleId: profile.googleId,
        provider: AuthProvider.Google,
      });
      const updated = await this.usersService.findUserById(existingByEmail.id);
      const token = (await this.login(updated as any)).accessToken;
      return { user: updated!, accessToken: token };
    }
    const repo = this.dataSource.getRepository(User);
    const created = repo.create({
      email: profile.email,
      firstName: profile.firstName || 'Google',
      lastName: profile.lastName || 'User',
      googleId: profile.googleId,
      provider: AuthProvider.Google,
      password: null,
      phoneVerified: false,
      emailVerified: profile.verified,
    } as any);
    const saved = (await repo.save(created as any)) as unknown as User;
    const token = (await this.login(saved)).accessToken;
    return { user: saved, accessToken: token };
  }

  async linkGoogleAccount(
    userId: string,
    profile: GoogleProfile,
  ): Promise<User> {
    if (!profile.verified)
      throw new BadRequestException('Google email not verified');
    const existing = await this.usersService.findByGoogleId(profile.googleId);
    if (existing && existing.id !== userId)
      throw new BadRequestException('Google account already linked');
    await this.dataSource.getRepository(User).update(userId, {
      googleId: profile.googleId,
      provider: AuthProvider.Google,
    });
    return (await this.usersService.findUserById(userId))!;
  }
}
