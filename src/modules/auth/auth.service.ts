import {
  BadRequestException,
  ConflictException,
  HttpException,
  HttpStatus,
  Inject,
  Injectable,
  Logger,
  Optional,
  UnauthorizedException,
} from '@nestjs/common';
import * as bcrypt from 'bcrypt';
import * as crypto from 'crypto';
import { lastValueFrom } from 'rxjs';
import { ClientProxy } from '@nestjs/microservices';
import { UsersService } from '../users/users.service';
import { UserRegisterDto } from './dto/user-register.dto';
import { VerifyEmailDto } from './dto/verify-email.dto';
import User, { AuthProvider } from '../users/entity/user.entity';
import { JwtService } from '@nestjs/jwt';
import { JwtPayloadProps } from './types';
import { DataSource, IsNull } from 'typeorm';
import { PasswordResetToken } from './entities/password-reset-token.entity';
import { EmailVerificationToken } from './entities/email-verification-token.entity';
import {
  OtpVerification,
  OtpPurpose,
} from './entities/otp-verification.entity';
import { RefreshToken } from './entities/refresh-token.entity';
import { CACHE_MANAGER } from '@nestjs/cache-manager';
import type { Cache } from 'cache-manager';
import { ConfigService } from '@nestjs/config';
import type { WhatsAppProvider } from './providers/whatsapp.provider';
import { GoogleProfile } from './strateges/google.strategy';

/**
 * This service is responsible for authentication domain (registration, login, refresh, logout).
 * It handles JWT issuance, refresh token rotation with PG FOR UPDATE, and enforces hash/storage invariants.
 */
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
    @Optional()
    @Inject('NOTIFICATION_SERVICE')
    private readonly notificationClient?: ClientProxy,
  ) {}

  private saltOrRounds = 10;

  // For testing: allow capturing raw tokens
  public lastRawToken?: string;
  public lastOtp?: string;
  /**
   * Test hook (014 US1): last raw email-verification token issued by
   * requestEmailVerification/resendVerification. Set after commit, never logged.
   */
  public lastVerificationToken?: string;

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

    // Fire-and-forget verification email after commit — never blocks 201 (spec FR-005, edge: DB down after User commit)
    this.requestEmailVerification(email).catch((e: any) => {
      // Registration already committed; recovery via POST /auth/resend-verification
      this.logger.error(
        `requestEmailVerification after register failed email=${email}: ${e?.message ?? e}`,
      );
    });

    // D3: same shape as before minus the credential material — the bcrypt hash
    // must never leave the server in a response body (approved S-delta).
    const { password: _dropped, ...safeUser } = newUser;
    return { message: 'User created successfuly.', data: safeUser };
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

  /**
   * This service is responsible for auth domain (login, refresh, logout, password-reset, OTP, Google).
   * It handles token issuance and enforces PG authoritative refresh storage.
   */

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

    // Issue refresh token (Phase 17)
    const refreshToken = await this.createRefreshTokenForUser(id);

    // Log with hashed prefix only, never rawRefresh
    const prefix = refreshToken.slice(0, 6);
    this.logger.log(
      `User with email ${email} logged in successfuly. refreshPrefix=${prefix}`,
    );

    return {
      message: 'User loged in successfuly',
      accessToken,
      refreshToken,
    };
  }

  /**
   * Creates a refresh token for user with cap 5 LRU eviction.
   * @param userId - User to issue token for.
   * @returns Raw refresh token 64 hex.
   * @throws UnauthorizedException if user not found (rare).
   */
  private async createRefreshTokenForUser(userId: string): Promise<string> {
    const raw = crypto.randomBytes(32).toString('hex');
    const tokenHash = crypto.createHash('sha256').update(raw).digest('hex');
    const ttl = this.configService.get<string>('REFRESH_TOKEN_TTL') || '7d';
    const expiresAt = new Date(Date.now() + this.parseTtlMs(ttl));

    const repo = this.dataSource.getRepository(RefreshToken);
    // Enforce cap 5 active LRU — revoke oldest if needed
    // Count active tokens for user
    const activeCount = await repo.count({
      where: { userId, revokedAt: IsNull() },
    });
    // If active >=5, revoke oldest active token (FOR UPDATE style — simple UPDATE oldest)
    if (activeCount >= 5) {
      // Find oldest active token
      const oldest = await repo.find({
        where: { userId, revokedAt: IsNull() },
        order: { createdAt: 'ASC' },
        take: 1,
      });
      if (oldest[0]) {
        // Revoke oldest — single-winner via UPDATE WHERE revokedAt IS NULL
        await repo.update(oldest[0].id, { revokedAt: new Date() });
        this.logger.log(
          `Refresh cap evicted oldest userId=${userId} tokenId=${oldest[0].id}`,
        );
      }
    }

    try {
      const entity = repo.create({
        userId,
        user: { id: userId },
        tokenHash,
        expiresAt,
        revokedAt: null,
      });
      await repo.save(entity);
    } catch (e: any) {
      // Handle partial unique collision (prob negligible) — retry once
      if (this.isUniqueViolation(e)) {
        this.logger.warn(
          `Refresh tokenHash collision userId=${userId} retry once`,
        );
        const retryRaw = crypto.randomBytes(32).toString('hex');
        const retryHash = crypto
          .createHash('sha256')
          .update(retryRaw)
          .digest('hex');
        const retryEntity = repo.create({
          userId,
          tokenHash: retryHash,
          expiresAt,
          revokedAt: null,
        });
        await repo.save(retryEntity);
        return retryRaw;
      }
      throw e;
    }
    return raw;
  }

  /**
   * Refreshes accessToken using opaque refresh token with single-use rotation.
   * @param rawRefresh - Raw 64 hex refresh token from body or cookie.
   * @returns New pair {accessToken, refreshToken} and emailVerified flag.
   * @throws UnauthorizedException if invalid/expired/revoked.
   */
  async refresh(rawRefresh: string): Promise<{
    accessToken: string;
    refreshToken: string;
    emailVerified: boolean;
  }> {
    if (!rawRefresh || typeof rawRefresh !== 'string') {
      throw new UnauthorizedException('Invalid or expired refresh token');
    }
    // Validate 64 hex shape — reuse DTO regex but service also checks
    if (!/^[0-9a-f]{64}$/.test(rawRefresh)) {
      throw new UnauthorizedException('Invalid or expired refresh token');
    }
    const tokenHash = crypto
      .createHash('sha256')
      .update(rawRefresh)
      .digest('hex');
    const prefix = tokenHash.slice(0, 6);

    let result: {
      accessToken: string;
      refreshToken: string;
      emailVerified: boolean;
    } | null = null;

    await this.dataSource.transaction(async (manager) => {
      const repo = manager.getRepository(RefreshToken);
      // FOR UPDATE lookup — single-winner serialization
      const found = await repo
        .createQueryBuilder('rt')
        .setLock('pessimistic_write')
        .where('rt.tokenHash = :tokenHash', { tokenHash })
        .getOne();

      // Not found → 401 (no userId, no theft nuke)
      if (!found) {
        throw new UnauthorizedException('Invalid or expired refresh token');
      }

      // Load user
      const userRepo = manager.getRepository(User);
      const user = await userRepo.findOne({ where: { id: found.userId } });
      if (!user) {
        throw new UnauthorizedException('Invalid or expired refresh token');
      }

      // Revoked already → theft detection (reuse of rotated token)
      // This is single-use rotation: old token should be revokedAt NOT NULL after first refresh
      if (found.revokedAt) {
        // Theft: revoke all remaining active tokens for this user (outside rows already revoked)
        // Do bulk revoke before throwing 401 — must be observable.
        // B5: this UPDATE runs on the DataSource (own implicit transaction), NOT
        // the enclosing manager — the 401 below rolls the outer tx back, which
        // would otherwise undo the nuke and leave the stolen session alive.
        await this.dataSource
          .createQueryBuilder()
          .update(RefreshToken)
          .set({ revokedAt: new Date() })
          .where('userId = :userId AND "revokedAt" IS NULL', {
            userId: found.userId,
          })
          .execute();
        this.logger.warn(
          `refresh reuse theft detected userId=${found.userId} hashPrefix=${prefix}`,
        );
        // Optional counter increment (best-effort, fail-open)
        try {
          const cache: any = this.cache as any;
          if (cache && cache.store && cache.store.client) {
            // ioredis via keyv — use incr
          }
          // Use generic cache incr if available
          if (typeof (this.cache as any).get === 'function') {
            // Use INCR via store
            const key = `idempotency:duplicate:skipped:refresh`;
            // Try INCR pattern — cache-manager doesn't expose incr directly, use store
            // Best-effort via CACHE_MANAGER set NX counter
          }
        } catch {
          // ignore — theft counter is observability only
        }
        try {
          // Best-effort INCR via cache manager if supports store
          const c: any = this.cache;
          if (c && c.store && typeof c.store.client?.incr === 'function') {
            await c.store.client.incr(`idempotency:duplicate:skipped:refresh`);
            await c.store.client.expire(
              `idempotency:duplicate:skipped:refresh`,
              86400,
            );
          }
        } catch {
          // fail-open for theft counter
        }
        throw new UnauthorizedException('Invalid or expired refresh token');
      }

      // Expired → 401 (no theft nuke, no bulk revoke)
      // expiresAt <= now is expired
      if (found.expiresAt.getTime() <= Date.now()) {
        throw new UnauthorizedException('Invalid or expired refresh token');
      }

      // Active branch — rotate: revoke old + insert new + sign new accessToken
      // Revoke old token
      await repo.update(found.id, { revokedAt: new Date() });

      // Cap 5 LRU before insert — count active excluding the just-revoked old.
      // IS NULL (not `null`) is required by the installed TypeORM in where clauses (B1).
      const activeCount = await repo.count({
        where: { userId: found.userId, revokedAt: IsNull() },
      });
      if (activeCount >= 5) {
        const oldest = await repo.find({
          where: { userId: found.userId, revokedAt: IsNull() },
          order: { createdAt: 'ASC' },
          take: 1,
        });
        if (oldest[0] && oldest[0].id !== found.id) {
          await repo.update(oldest[0].id, { revokedAt: new Date() });
          this.logger.log(
            `Refresh cap evicted oldest on rotation userId=${found.userId} tokenId=${oldest[0].id}`,
          );
        }
      }

      const newRaw = crypto.randomBytes(32).toString('hex');
      const newHash = crypto.createHash('sha256').update(newRaw).digest('hex');
      const ttl = this.configService.get<string>('REFRESH_TOKEN_TTL') || '7d';
      const newExpiresAt = new Date(Date.now() + this.parseTtlMs(ttl));
      const newEntity = repo.create({
        userId: found.userId,
        tokenHash: newHash,
        expiresAt: newExpiresAt,
        revokedAt: null,
      } as any);
      await repo.save(newEntity);

      // Sign new accessToken with current tokenVersion
      const payload: JwtPayloadProps = {
        sub: user.id,
        email: user.email,
        fullName: `${user.firstName} ${user.lastName}`,
        role: user.role,
        tokenVersion:
          typeof user.tokenVersion === 'number' ? user.tokenVersion : 0,
      };
      const newAccessToken = await this.jwtService.signAsync(payload as any);

      // Determine emailVerified for header
      const emailVerified = !!user.emailVerified;

      if (!emailVerified) {
        this.logger.warn(
          `refresh unverified email userId=${user.id} hashPrefix=${prefix}`,
        );
      } else {
        this.logger.log(
          `refresh rotated userId=${user.id} hashPrefix=${prefix} -> newPrefix=${newHash.slice(0, 6)}`,
        );
      }

      result = {
        accessToken: newAccessToken,
        refreshToken: newRaw,
        emailVerified,
      };
    });

    if (!result) {
      throw new UnauthorizedException('Invalid or expired refresh token');
    }
    return result;
  }

  /**
   * Revokes a single refresh token by hash (idempotent 200).
   * @param rawRefresh - Raw 64 hex token from body or cookie; if falsy, returns 200 anti-enum.
   * @throws Never throws 401 for not found — returns 200 (anti-enumeration).
   */
  async logout(rawRefresh?: string | null): Promise<void> {
    if (!rawRefresh || typeof rawRefresh !== 'string') {
      // Anti-enum: no token provided → 200 (do not leak)
      return;
    }
    if (!/^[0-9a-f]{64}$/.test(rawRefresh)) {
      // Invalid shape → still 200 anti-enum per spec
      return;
    }
    const tokenHash = crypto
      .createHash('sha256')
      .update(rawRefresh)
      .digest('hex');
    const repo = this.dataSource.getRepository(RefreshToken);
    // Idempotent UPDATE where revokedAt IS NULL — 0 rows is still 200
    await repo
      .createQueryBuilder()
      .update(RefreshToken)
      .set({ revokedAt: new Date() })
      .where('tokenHash = :tokenHash AND "revokedAt" IS NULL', { tokenHash })
      .execute();
    this.logger.log(`logout revoked prefix=${tokenHash.slice(0, 6)}`);
  }

  /**
   * Revokes all sessions for user via tokenVersion++ and bulk revokedAt.
   * @param userId - Authenticated user id from JwtGuard.
   * @throws UnauthorizedException if user not found.
   */
  async logoutAll(userId: string): Promise<void> {
    await this.dataSource.transaction(async (manager) => {
      const userRepo = manager.getRepository(User);
      const user = await userRepo
        .createQueryBuilder('u')
        .setLock('pessimistic_write')
        .where('u.id = :userId', { userId })
        .getOne();
      if (!user) throw new UnauthorizedException('User not found');
      // Increment tokenVersion atomically
      await userRepo.update(userId, {
        tokenVersion: () => '"tokenVersion" + 1',
        passwordChangedAt: new Date(),
      });
      // Bulk revoke all active refresh tokens
      await manager
        .createQueryBuilder()
        .update(RefreshToken)
        .set({ revokedAt: new Date() })
        .where('userId = :userId AND "revokedAt" IS NULL', { userId })
        .execute();
    });
    this.logger.log(`logout-all revoked all for userId=${userId}`);
  }

  /**
   * Purges expired/revoked RefreshToken rows older than 7 days.
   * @returns Number of rows deleted.
   */
  async purgeExpiredTokens(): Promise<number> {
    const result = await this.dataSource
      .createQueryBuilder()
      .delete()
      .from(RefreshToken)
      .where(
        `("revokedAt" IS NOT NULL AND "revokedAt" < NOW() - INTERVAL '7 days') OR ("revokedAt" IS NULL AND "expiresAt" < NOW() - INTERVAL '7 days')`,
      )
      .execute();
    const count = result.affected || 0;
    if (count > 0) this.logger.log(`RefreshToken purge deleted ${count} rows`);
    return count;
  }

  /**
   * Purges used/expired EmailVerificationToken rows older than 7 days.
   * Intended to be called by a nightly job (BullMQ repeat or ops cron), never in the request path.
   * @returns Number of rows deleted.
   */
  async purgeExpiredVerificationTokens(): Promise<number> {
    // Retention 7d per spec clarification: used tokens and long-expired actives are audit-dead
    const result = await this.dataSource
      .createQueryBuilder()
      .delete()
      .from(EmailVerificationToken)
      .where(
        `("usedAt" IS NOT NULL AND "usedAt" < NOW() - INTERVAL '7 days') OR ("expiresAt" < NOW() - INTERVAL '7 days')`,
      )
      .execute();
    const count = result.affected || 0;
    if (count > 0)
      this.logger.log(`EmailVerificationToken purge deleted ${count} rows`);
    return count;
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
    // Publish after commit (US3 wired: replaces TODO Logger-only publish).
    // Never inside dataSource.transaction above — broker I/O stays outside the tx.
    const resetPayload = {
      userId: user.id,
      email,
      rawToken,
      expiresAt: expiresAt.toISOString(),
    };
    try {
      this.logger.log(
        `Password reset token created for ${email}, expires ${expiresAt.toISOString()}`,
      );
      await this.emitAuthEvent('auth.password_reset_requested', resetPayload);
    } catch (e: any) {
      // Fire-and-forget after commit — 200 anti-enum already decided, never throw to caller
      this.logger.error(
        `Failed to emit password reset event email=${email}: ${e?.message ?? e}`,
      );
    }
  }

  /**
   * Advisory pre-check for reset-token validity (UX only, unlocked read).
   * S-2: this is NOT the authority — resetPassword revalidates hash/expiry/
   * use inside its own transaction holding FOR UPDATE and is the sole decider.
   * A "valid" answer here can still 400 at reset time under concurrency.
   */
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

  /**
   * Consumes a reset token and changes the password as one atomic unit.
   * S-2 authority: hash/expiry/use are revalidated here inside the
   * transaction holding FOR UPDATE — validateResetToken's answer is advisory
   * only. Single-winner under concurrency (second consume 400s).
   */
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

  // ============ Phase 18 (014 US1/US2): Email verification ============

  /**
   * Emits an auth domain event after the DB commit (publish-after-commit).
   * Never call inside dataSource.transaction — broker I/O stays outside the tx.
   * Fail-open: logs and resolves, never throws to the caller (register stays 201).
   * @param eventType - Event name (email.verification_requested, auth.password_reset_requested, auth.email_verified).
   * @param payload - Event payload (may contain rawToken once; never logged raw).
   * @returns Void.
   */
  public async emitAuthEvent(
    eventType: string,
    payload: Record<string, unknown>,
  ): Promise<void> {
    try {
      if (this.notificationClient) {
        // Bounded wait so a down broker can never hang the request path
        const obs = this.notificationClient.emit(eventType, payload);
        await Promise.race([
          lastValueFrom(obs),
          new Promise((_, reject) =>
            setTimeout(() => reject(new Error('emit timeout 2000ms')), 2000),
          ),
        ]);
      }
      // Hash prefix only in logs — rawToken is never logged
      const userId = (payload as any)?.userId ?? 'unknown';
      this.logger.log(`auth event emitted type=${eventType} userId=${userId}`);
      // TODO (T026 worker): EmailWorker/NotificationWorker consumes
      // email.verification_requested + auth.password_reset_requested via the
      // BullMQ 'notification' queue and calls EmailProvider.send (owned by another task).
    } catch (e: any) {
      // Async after commit never rolls back business — log only
      this.logger.error(
        `Failed to emit auth event type=${eventType}: ${e?.message ?? e}`,
      );
    }
  }

  /**
   * Parses a TTL string with s/m/h/d suffixes.
   * @param ttl - TTL string (e.g. '24h', '15m', '604800000').
   * @param fallbackMs - Fallback when invalid.
   * @param key - Config key name for the warn log.
   * @returns Milliseconds.
   */
  private parseTtlWithDefault(
    ttl: string,
    fallbackMs: number,
    key: string,
  ): number {
    if (ttl.endsWith('m')) return parseInt(ttl, 10) * 60_000;
    if (ttl.endsWith('s')) return parseInt(ttl, 10) * 1000;
    if (ttl.endsWith('h')) return parseInt(ttl, 10) * 3600_000;
    if (ttl.endsWith('d')) return parseInt(ttl, 10) * 24 * 3600_000;
    const numeric = parseInt(ttl, 10);
    if (!isNaN(numeric) && String(numeric) === ttl) return numeric;
    this.logger.warn(`Invalid TTL "${key}=${ttl}", fallback ${fallbackMs}ms`);
    return fallbackMs;
  }

  /**
   * Resolves the email-verification TTL (default 24h).
   * @returns Milliseconds until a verification token expires.
   */
  private getVerificationTtlMs(): number {
    const raw =
      this.configService.get<string>('EMAIL_VERIFICATION_TTL') || '24h';
    return this.parseTtlWithDefault(
      raw,
      24 * 3600_000,
      'EMAIL_VERIFICATION_TTL',
    );
  }

  /**
   * Creates (or refreshes) an email-verification token after commit and emits the send event.
   * Fire-and-forget: unknown email or already-verified returns void (anti-enum); failures never throw.
   * @param email - User email to verify.
   * @returns Void.
   */
  async requestEmailVerification(email: string): Promise<void> {
    const user = await this.usersService.findUserByEmail(email);
    // Anti-enumeration: same void whether or not the email exists
    if (!user) {
      this.logger.debug(`requestEmailVerification: email not found ${email}`);
      return;
    }
    // Already verified → no new token, no email (resend returns the distinct message)
    if ((user as any).emailVerified) {
      return;
    }
    const raw = crypto.randomBytes(32).toString('hex');
    const tokenHash = crypto.createHash('sha256').update(raw).digest('hex');
    const expiresAt = new Date(Date.now() + this.getVerificationTtlMs());

    await this.dataSource.transaction(async (manager) => {
      // Invalidate prior active tokens so only one link is live at a time
      await manager
        .createQueryBuilder()
        .update(EmailVerificationToken)
        .set({ usedAt: new Date() })
        .where('userId = :userId AND "usedAt" IS NULL', { userId: user.id })
        .execute();
      const repo = manager.getRepository(EmailVerificationToken);
      try {
        await repo.save(
          repo.create({
            userId: user.id,
            tokenHash,
            expiresAt,
            usedAt: null,
          }),
        );
      } catch (e: any) {
        // Negligible hash-collision retry once (edge: UQ 23505), else propagate
        if (this.isUniqueViolation(e)) {
          this.logger.warn(
            `EmailVerificationToken hash collision userId=${user.id} hashPrefix=${tokenHash.slice(0, 6)} retry once`,
          );
          const retryRaw = crypto.randomBytes(32).toString('hex');
          const retryHash = crypto
            .createHash('sha256')
            .update(retryRaw)
            .digest('hex');
          await repo.save(
            repo.create({
              userId: user.id,
              tokenHash: retryHash,
              expiresAt,
              usedAt: null,
            }),
          );
          this.lastVerificationToken = retryRaw;
          return;
        }
        throw e;
      }
      this.lastVerificationToken = raw;
    });
    // Publish after commit — outside dataSource.transaction (constitution async rule)
    const rawForEvent = this.lastVerificationToken ?? raw;
    await this.emitAuthEvent('email.verification_requested', {
      userId: user.id,
      email,
      rawToken: rawForEvent,
      expiresAt: expiresAt.toISOString(),
    });
  }

  /**
   * Verifies an email link/body token with single-use semantics.
   * @param dto - VerifyEmailDto {email, token 64hex}.
   * @returns {verified:true, emailVerified:true} on success.
   * @throws BadRequestException 400 for unknown email, missing/used/expired token (no 404 leak).
   */
  async verifyEmail(
    dto: VerifyEmailDto,
  ): Promise<{ verified: boolean; emailVerified: boolean }> {
    const user = await this.usersService.findUserByEmail(dto.email);
    // Do not 404-leak existence — unknown email is the same 400 as a bad token
    if (!user) {
      throw new BadRequestException('Invalid or expired verification token');
    }
    const tokenHash = crypto
      .createHash('sha256')
      .update(dto.token)
      .digest('hex');
    const hashPrefix = tokenHash.slice(0, 6);

    await this.dataSource.transaction(async (manager) => {
      const repo = manager.getRepository(EmailVerificationToken);
      // FOR UPDATE lookup scoped to (tokenHash, userId) — concurrent same raw serializes here
      const found = await repo
        .createQueryBuilder('t')
        .setLock('pessimistic_write')
        .where('t.tokenHash = :tokenHash AND t.userId = :userId', {
          tokenHash,
          userId: user.id,
        })
        .getOne();
      // Single-use or expired or wrong-user hash → 400 without mutating
      if (!found || found.usedAt || found.expiresAt.getTime() <= Date.now()) {
        throw new BadRequestException('Invalid or expired verification token');
      }
      found.usedAt = new Date();
      await repo.save(found);
      // Set verified once (idempotent flag, no toggle)
      if (!(user as any).emailVerified) {
        await manager
          .getRepository(User)
          .update(user.id, { emailVerified: true });
      }
    });
    // Hash prefix only — raw token is never logged
    this.logger.log(
      `email verified userId=${user.id} hashPrefix=${hashPrefix}`,
    );
    // Optional post-commit event — outside the tx, fail-open
    await this.emitAuthEvent('auth.email_verified', {
      userId: user.id,
      email: dto.email,
    });
    return { verified: true, emailVerified: true };
  }

  /**
   * Re-sends the verification email with anti-enumeration and a 60s per-email cooldown.
   * @param email - User email to re-send to.
   * @returns Anti-enum 200 message, or distinct already-verified 200.
   * @throws HttpException 429 when the 60s cooldown is still active (before any transaction).
   */
  async resendVerification(email: string): Promise<{ message: string }> {
    const normalized = email.toLowerCase();
    const cooldownKey = `resend:cooldown:${normalized}`;
    // 60s cooldown prevents burst re-sends — checked before any DB transaction
    try {
      const existing = await (this.cache as any).get(cooldownKey);
      if (existing) {
        // Cooldown active → 429 immediately, 0 transaction calls
        const ex: any = new HttpException(
          'Too Many Requests',
          HttpStatus.TOO_MANY_REQUESTS,
        );
        ex.options = {
          headers: {
            'Retry-After': '60',
            'X-RateLimit-Limit': '3',
            'X-RateLimit-Remaining': '0',
          },
        };
        throw ex;
      }
    } catch (e: any) {
      // Re-throw intentional 429; fail open on Redis errors
      if (e instanceof HttpException && e.getStatus() === 429) throw e;
      this.logger.warn(
        `Resend cooldown check fail-open for ${normalized}: ${e?.message ?? e}`,
      );
    }

    const user = await this.usersService.findUserByEmail(email);
    // Anti-enumeration: same message whether or not the email exists
    if (!user) {
      this.logger.debug(`resendVerification anti-enum email=${email}`);
      return {
        message: 'If an account exists, a verification email has been sent.',
      };
    }
    // Verified users get a distinct message and no new token/email
    if ((user as any).emailVerified) {
      return { message: 'Email already verified' };
    }

    const raw = crypto.randomBytes(32).toString('hex');
    const tokenHash = crypto.createHash('sha256').update(raw).digest('hex');
    const expiresAt = new Date(Date.now() + this.getVerificationTtlMs());

    await this.dataSource.transaction(async (manager) => {
      // Invalidate priors so the old link dies exactly when the new one is born
      // (a racing verifyEmail on the old raw serializes on FOR UPDATE and sees usedAt → 400)
      await manager
        .createQueryBuilder()
        .update(EmailVerificationToken)
        .set({ usedAt: new Date() })
        .where('userId = :userId AND "usedAt" IS NULL', { userId: user.id })
        .execute();
      const repo = manager.getRepository(EmailVerificationToken);
      await repo.save(
        repo.create({
          userId: user.id,
          tokenHash,
          expiresAt,
          usedAt: null,
        }),
      );
      this.lastVerificationToken = raw;
    });
    // Arm the 60s cooldown after a successful issue (fail-open on Redis errors)
    try {
      await (this.cache as any).set(cooldownKey, '1', 60_000);
    } catch (e: any) {
      this.logger.warn(
        `Resend cooldown set fail-open for ${normalized}: ${e?.message ?? e}`,
      );
    }
    // Publish after commit — outside dataSource.transaction
    await this.emitAuthEvent('email.verification_requested', {
      userId: user.id,
      email,
      rawToken: raw,
      expiresAt: expiresAt.toISOString(),
    });
    return {
      message: 'If an account exists, a verification email has been sent.',
    };
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

  // ============ Phase 16: Google OAuth ============ (Phase 17 extends to issue refresh)
  async handleGoogleLogin(
    profile: GoogleProfile,
  ): Promise<{ user: User; accessToken: string; refreshToken: string }> {
    if (!profile.verified)
      throw new BadRequestException('Google email not verified');
    const user = await this.usersService.findByGoogleId(profile.googleId);
    if (user) {
      const { accessToken, refreshToken } = await this.login(user);
      return { user, accessToken, refreshToken };
    }
    const existingByEmail = await this.usersService.findUserByEmail(
      profile.email,
    );
    if (existingByEmail) {
      // auto-link per Q1
      try {
        await this.dataSource.getRepository(User).update(existingByEmail.id, {
          googleId: profile.googleId,
          provider: AuthProvider.Google,
        });
      } catch (e: any) {
        if (this.isUniqueViolation(e))
          throw new ConflictException('Google account already linked');
        throw e;
      }
      const updated = await this.usersService.findUserById(existingByEmail.id);
      const { accessToken, refreshToken } = await this.login(updated as any);
      return { user: updated!, accessToken, refreshToken };
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
    let saved: User;
    try {
      saved = await repo.save(created as any);
    } catch (e: any) {
      if (this.isUniqueViolation(e))
        throw new ConflictException('Google account already linked');
      throw e;
    }
    const { accessToken, refreshToken } = await this.login(saved);
    return { user: saved, accessToken, refreshToken };
  }

  private parseTtlMs(ttl: string): number {
    // Support s/m/h/d suffixes (Phase 17 adds 'd' for 7d)
    if (ttl.endsWith('m')) return parseInt(ttl, 10) * 60_000;
    if (ttl.endsWith('s')) return parseInt(ttl, 10) * 1000;
    if (ttl.endsWith('h')) return parseInt(ttl, 10) * 3600_000;
    if (ttl.endsWith('d')) return parseInt(ttl, 10) * 24 * 3600_000;
    // Numeric fallback (e.g., "604800000")
    const numeric = parseInt(ttl, 10);
    if (!isNaN(numeric) && String(numeric) === ttl) return numeric;
    this.logger.warn(`Invalid TTL "${ttl}", fallback 15m`);
    return 15 * 60_000;
  }

  private isUniqueViolation(e: any): boolean {
    const msg = e?.message || '';
    const code = e?.code;
    return (
      code === '23505' ||
      msg.includes('duplicate') ||
      msg.includes('UNIQUE') ||
      msg.includes('UQ_user_googleId') ||
      msg.includes('unique')
    );
  }

  async linkGoogleAccount(
    userId: string,
    profile: GoogleProfile,
  ): Promise<User> {
    if (!profile.verified)
      throw new BadRequestException('Google email not verified');
    const existing = await this.usersService.findByGoogleId(profile.googleId);
    if (existing && existing.id !== userId)
      throw new ConflictException('Google account already linked');
    try {
      await this.dataSource.getRepository(User).update(userId, {
        googleId: profile.googleId,
        provider: AuthProvider.Google,
      });
    } catch (e: any) {
      if (this.isUniqueViolation(e))
        throw new ConflictException('Google account already linked');
      throw e;
    }
    return (await this.usersService.findUserById(userId))!;
  }
}
