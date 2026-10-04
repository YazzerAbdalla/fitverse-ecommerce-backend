/**
 * Auth orchestration: transaction boundaries + delegation to intent-based
 * stores, UsersService, and AuthEventPublisher. No broker/cache I/O in tx.
 *
 * Responsibility (SRP): auth use-case orchestration, nothing else.
 * Used by: AuthController, LocalStrategy, GoogleStrategy flows.
 * Depends on: UsersService, JwtService, DataSource, Cache, ConfigService,
 *   WHATSAPP_PROVIDER, token stores, AuthEventPublisher, Clock, AUTH_TOKEN_CONFIG.
 */
import { CACHE_MANAGER } from '@nestjs/cache-manager';
import {
  BadRequestException,
  ConflictException,
  HttpException,
  Inject,
  Injectable,
  InternalServerErrorException,
  Logger,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import * as bcrypt from 'bcrypt';
import type { Cache } from 'cache-manager';
import * as crypto from 'crypto'; // randomInt only (OTP digits have no port)
import { DataSource } from 'typeorm';
import { SystemClock } from '../../common/clock';
import { generateHex } from '../../common/secure-token';
import { sha256Hex } from '../../common/token-hasher';
import User, { AuthProvider } from '../users/entity/user.entity';
import { UsersService } from '../users/users.service';
import { AuthEventPublisher } from './auth-event.publisher';
import type { AuthTokenConfig } from './auth-token.config';
import { AUTH_TOKEN_CONFIG } from './auth-token.config';
import { UserRegisterDto } from './dto/user-register.dto';
import { VerifyEmailDto } from './dto/verify-email.dto';
import { OtpPurpose } from './entities/otp-verification.entity';
import type { WhatsAppProvider } from './providers/whatsapp.provider';
import { OtpStore } from './stores/otp.store';
import { PasswordResetTokenStore } from './stores/password-reset-token.store';
import { RefreshTokenStore } from './stores/refresh-token.store';
import {
  VerificationCooldownError,
  VerificationTokenStore,
} from './stores/verification-token.store';
import { GoogleProfile } from './strategies/google.strategy';
import { JwtPayloadProps } from './types';

/**
 * Minimal Redis counter surface behind the cache-manager Keyv escape hatch.
 * cache-manager v7 types `Cache.stores: Keyv[]` with no singular `store` and
 * no `.client`; the ioredis client is only reachable via untyped internals.
 */
interface RedisCounterClient {
  incr(key: string): Promise<number>;
  expire(key: string, seconds: number): Promise<unknown>;
}

/**
 * Structural view of CACHE_MANAGER internals for best-effort counters.
 * Covers both the legacy singular `store` and the v7 `stores[0]` (Keyv)
 * shapes; every level is optional so absence means counter skipped (fail-open).
 */
type CacheWithStoreClient = {
  store?: {
    client?: RedisCounterClient;
    store?: { client?: RedisCounterClient };
  };
  stores?: Array<{
    client?: RedisCounterClient;
    store?: { client?: RedisCounterClient };
  }>;
  client?: RedisCounterClient;
};

/**
 * This service is responsible for auth orchestration (register, login,
 * refresh, logout, password-reset, verification, OTP, Google).
 * It owns transaction boundaries and delegates persistence to intent-based
 * stores, user writes to UsersService, and post-commit events to
 * AuthEventPublisher. It performs no broker/cache I/O inside transactions.
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
    private readonly refreshTokens: RefreshTokenStore,
    private readonly resetTokens: PasswordResetTokenStore,
    private readonly verificationTokens: VerificationTokenStore,
    private readonly otpStore: OtpStore,
    private readonly eventPublisher: AuthEventPublisher,
    private readonly clock: SystemClock,
    @Inject(AUTH_TOKEN_CONFIG) private readonly tokenConfig: AuthTokenConfig,
  ) {}

  private saltOrRounds = 10;

  // For testing: allow capturing raw tokens
  public lastRawToken?: string;
  public lastVerificationToken?: string;
  public lastOtp?: string;

  async register(userRegisterDto: UserRegisterDto) {
    const { email, password } = userRegisterDto;
    this.logger.debug(`Register attempt for ${email}`);
    // DB-READ: Check if this email already exist
    const isEmailExist = await this.usersService.findUserByEmail(email);
    if (isEmailExist) {
      this.logger.error(`User try to use duplicated email ${email}`);
      throw new BadRequestException('This email already exist.');
    }

    const hashedPassword = await bcrypt.hash(password, this.saltOrRounds);

    const newUser: Partial<User> = {
      ...userRegisterDto,
      password: hashedPassword,
    };

    let savedUser: User | null = null;

    // DB-Write Create new user
    try {
      savedUser = await this.usersService.createNewUser(newUser);

      this.logger.log(
        `New user with email ${email} had registered successfuly`,
      );
    } catch (e: any) {
      if (e instanceof ConflictException || e instanceof BadRequestException) {
        this.logger.error(
          'The email is already exist, please use another email',
        );
        throw new ConflictException(
          'The email is already exist, please use another email',
        );
      }

      if (e instanceof InternalServerErrorException) {
        this.logger.error('Internal server error while creating new user');
        throw new InternalServerErrorException(
          'Internal server error while creating new user',
        );
      }
    }

    // Fire-and-forget verification email after commit — never blocks 201 (spec FR-005, edge: DB down after User commit)
    this.requestEmailVerification(savedUser!).catch(
      (e: InternalServerErrorException) => {
        // Registration already committed; recovery via POST /auth/resend-verification
        this.logger.error(
          `requestEmailVerification after register failed email=${email}: ${e?.message ?? e}`,
        );
      },
    );

    // D3: same shape as before minus the credential material — the bcrypt hash
    // must never leave the server in a response body (approved S-delta).
    const { password: _dropped, ...safeUser } = newUser;
    return { message: 'User created successfuly.', data: safeUser };
  }

  /**
   * Validates local credentials for the passport-local strategy.
   *
   * @param email - Login email.
   * @param password - Plaintext password to compare (bcrypt).
   * @returns The user without password hash, or null (unknown user, OAuth-only
   *   account, or mismatch — all map to the same 401 downstream).
   */
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
      const { password: _blank, ...safeUser } = isUserExist;
      return safeUser;
    }

    return null;
  }

  async login(user: Partial<User>) {
    const { id, email, firstName, lastName, role, tokenVersion } = user;

    const fullName = firstName + ' ' + lastName;

    // Create the accessToken payload with tokenVersion for revocation
    const payload: JwtPayloadProps = {
      sub: id,
      email,
      fullName,
      role,
      tokenVersion: typeof tokenVersion === 'number' ? tokenVersion : 0,
    };

    const accessToken = await this.jwtService.signAsync(payload as any);

    // Issue refresh token (Phase 17)
    const refreshToken = await this.createRefreshTokenForUser(id!);

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
    const raw = generateHex();
    const tokenHash = sha256Hex(raw);
    // Lifetime from startup-resolved config (was per-access read + parse).
    const expiresAt = new Date(
      this.clock.now().getTime() + this.tokenConfig.refreshTokenTtlMs,
    );

    // Enforce cap 5 active LRU — revoke oldest if needed (store-owned reads).
    const activeCount = await this.refreshTokens.countActive(userId);
    if (activeCount >= 5) {
      // Find oldest active token
      const oldest = await this.refreshTokens.findOldestActive(userId);
      if (oldest) {
        // Revoke oldest — single-winner via UPDATE WHERE revokedAt IS NULL
        await this.refreshTokens.revokeById(undefined, oldest.id);
        this.logger.log(
          `Refresh cap evicted oldest userId=${userId} tokenId=${oldest.id}`,
        );
      }
    }

    try {
      await this.refreshTokens.create({ userId, tokenHash, expiresAt });
    } catch (e: any) {
      // Handle partial unique collision (prob negligible) — retry once
      if (this.isUniqueViolation(e)) {
        this.logger.warn(
          `Refresh tokenHash collision userId=${userId} retry once`,
        );
        const retryRaw = generateHex();
        const retryHash = sha256Hex(retryRaw);
        await this.refreshTokens.create({
          userId,
          tokenHash: retryHash,
          expiresAt,
        });
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
    const tokenHash = sha256Hex(rawRefresh);
    const prefix = tokenHash.slice(0, 6);

    let result: {
      accessToken: string;
      refreshToken: string;
      emailVerified: boolean;
    } | null = null;

    await this.dataSource.transaction(async (manager) => {
      // FOR UPDATE lookup — single-winner serialization (store-owned).
      const found = await this.refreshTokens.findByHashForUpdate(
        manager,
        tokenHash,
      );

      // Not found → 401 (no userId, no theft nuke)
      if (!found) {
        throw new UnauthorizedException('Invalid or expired refresh token');
      }

      // Load user through the users boundary (US2: no direct user repo here).
      const user = await this.usersService.findUserById(found.userId, manager);
      if (!user) {
        throw new UnauthorizedException('Invalid or expired refresh token');
      }

      // Revoked already → theft detection (reuse of rotated token)
      // This is single-use rotation: old token should be revokedAt NOT NULL after first refresh
      if (found.revokedAt) {
        // Theft: revoke all remaining active tokens for this user (outside rows already revoked)
        // Do bulk revoke before throwing 401 — must be observable.
        // Store-owned own-tx nuke (B5): the 401 below rolls the outer tx back.
        await this.refreshTokens.revokeAllActive(found.userId);
        this.logger.warn(
          `refresh reuse theft detected userId=${found.userId} hashPrefix=${prefix}`,
        );
        // Optional theft counter (best-effort, fail-open, observability only).
        // cache-manager exposes no incr; reach the ioredis client via the
        // Keyv escape hatch (singular `store` or v7 `stores[0]`).
        try {
          const cacheWithStore = this.cache as unknown as CacheWithStoreClient;
          const key = `idempotency:duplicate:skipped:refresh`;
          const keyvStore = cacheWithStore.store ?? cacheWithStore.stores?.[0];
          const redisClient =
            keyvStore?.client ??
            keyvStore?.store?.client ??
            cacheWithStore.client;
          if (redisClient && typeof redisClient.incr === 'function') {
            await redisClient.incr(key);
            await redisClient.expire(key, 86400);
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
      await this.refreshTokens.revokeById(manager, found.id);

      // Cap 5 LRU before insert — count active excluding the just-revoked old.
      const activeCount = await this.refreshTokens.countActive(
        found.userId,
        manager,
      );
      if (activeCount >= 5) {
        const oldest = await this.refreshTokens.findOldestActive(
          found.userId,
          manager,
        );
        if (oldest && oldest.id !== found.id) {
          await this.refreshTokens.revokeById(manager, oldest.id);
          this.logger.log(
            `Refresh cap evicted oldest on rotation userId=${found.userId} tokenId=${oldest.id}`,
          );
        }
      }

      const newRaw = generateHex();
      const newHash = sha256Hex(newRaw);
      const newExpiresAt = new Date(
        this.clock.now().getTime() + this.tokenConfig.refreshTokenTtlMs,
      );
      await this.refreshTokens.create(
        {
          userId: found.userId,
          tokenHash: newHash,
          expiresAt: newExpiresAt,
        },
        manager,
      );

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
    const tokenHash = sha256Hex(rawRefresh);
    // Idempotent UPDATE where revokedAt IS NULL — 0 rows is still 200 (store-owned).
    await this.refreshTokens.revokeByHashWhereActive(tokenHash);
    this.logger.log(`logout revoked prefix=${tokenHash.slice(0, 6)}`);
  }

  /**
   * Revokes all sessions for user via tokenVersion++ and bulk revokedAt.
   * @param userId - Authenticated user id from JwtGuard.
   * @throws UnauthorizedException if user not found.
   */
  async logoutAll(userId: string): Promise<void> {
    await this.dataSource.transaction(async (manager) => {
      // Locked read + nuke owned by UsersService (US2); same lock, same 404.
      const user = await this.usersService.findUserByIdForUpdate(
        manager,
        userId,
      );
      if (!user) throw new UnauthorizedException('User not found');
      // Increment tokenVersion atomically
      await this.usersService.incrementTokenVersion(userId, {
        manager,
        passwordChangedAt: new Date(),
      });
      // Bulk revoke all active refresh tokens (commits with this tx — no
      // rollback follows here, so the in-tx variant applies).
      await this.refreshTokens.revokeAllInTx(manager, userId);
    });
    this.logger.log(`logout-all revoked all for userId=${userId}`);
  }

  /**
   * Purges expired/revoked RefreshToken rows older than 7 days.
   * @returns Number of rows deleted.
   */
  async purgeExpiredTokens(): Promise<number> {
    const count = await this.refreshTokens.purgeExpired();
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
    const count = await this.verificationTokens.purgeExpired();
    if (count > 0)
      this.logger.log(`EmailVerificationToken purge deleted ${count} rows`);
    return count;
  }

  // ============ Phase 16: Forgot Password & Recovery Token ============
  /**
   * Starts a password reset: anti-enumeration void for unknown emails,
   * otherwise issues a single-use 15m token (priors invalidated) and emits
   * the send event after commit.
   *
   * @param email - Account email (never leaked on miss).
   * @returns Void.
   */
  async requestPasswordReset(email: string): Promise<void> {
    const user = await this.usersService.findUserByEmail(email);
    if (!user) {
      this.logger.debug(`forgot-password: email not found ${email}`);
      return;
    }
    const rawToken = generateHex();
    this.lastRawToken = rawToken;
    const tokenHash = sha256Hex(rawToken);
    const expiresAt = new Date(
      this.clock.now().getTime() + this.tokenConfig.resetTokenTtlMs,
    );

    await this.dataSource.transaction(async (manager) => {
      await this.resetTokens.issue(manager, user.id, tokenHash, expiresAt);
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
      await this.eventPublisher.emit(
        'auth.password_reset_requested',
        resetPayload,
      );
    } catch (e: any) {
      // Fire-and-forget after commit — 200 anti-enum already decided, never throw to caller
      if (
        e instanceof InternalServerErrorException ||
        e instanceof HttpException
      ) {
        return this.logger.error(
          `Failed to emit password reset event email=${email}: ${e?.message ?? e}`,
        );
      }
      this.logger.error(
        `Failed to emit password reset event email=${email}: ${e}`,
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
    const tokenHash = sha256Hex(rawToken);
    // Advisory read (S-2): no lock, UX pre-check only.
    const token = await this.resetTokens.findAdvisory(tokenHash, user.id);
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
    const tokenHash = sha256Hex(dto.token);

    await this.dataSource.transaction(async (manager) => {
      // S-2 authority: revalidated under FOR UPDATE (store-owned lookup).
      const token = await this.resetTokens.findForUpdate(
        manager,
        tokenHash,
        user.id,
      );
      if (
        !token ||
        token.usedAt ||
        token.expiresAt.getTime() <= this.clock.now().getTime()
      ) {
        throw new BadRequestException('Invalid or expired token.');
      }
      const hashed = await bcrypt.hash(dto.newPassword, this.saltOrRounds);
      // Password write owned by UsersService (US2): same hash + increment +
      // passwordChangedAt, inside this transaction.
      await this.usersService.updatePassword(user.id, hashed, undefined, {
        manager,
        passwordChangedAt: new Date(),
      });
      await this.resetTokens.consume(manager, token, user.id);
    });
    this.logger.log(`Password reset successful for ${dto.email}`);
  }

  // ============ Phase 18 (014 US1/US2): Email verification ============
  // NOTE (US4): TTL parsing moved to the shared parseDurationMs port and all
  // lifetimes come from startup-resolved AuthTokenConfig — the three private
  // parsers below were deleted after the rewire (identical outputs proven by
  // src/common/ports.spec.ts).

  /**
   * Creates (or refreshes) an email-verification token after commit and emits the send event.
   * Fire-and-forget: unknown email or already-verified returns void (anti-enum); failures never throw.
   * @param email - User email to verify.
   * @returns Void.
   */
  async requestEmailVerification(user: User): Promise<void> {
    const { email } = user;

    const expiresAt = new Date(
      this.clock.now().getTime() + this.tokenConfig.emailVerificationTtlMs,
    );

    let lastVerificationToken: string | undefined;

    await this.dataSource.transaction(async (manager) => {
      // Store-owned issue (invalidate priors + insert + collision retry);
      // returns the winning raw for the test hook + event below.
      const winningRaw = await this.verificationTokens.newVerificationIssue(
        manager,
        user.id,
        expiresAt,
        () => {
          const r = generateHex();
          return { raw: r, hash: sha256Hex(r) };
        },
        (e: unknown) => this.isUniqueViolation(e),
      );
      lastVerificationToken = winningRaw;
    });
    // Publish after commit — outside dataSource.transaction (constitution async rule).
    // lastVerificationToken is always set by the store on success; the tx
    // throws before reaching here otherwise.
    const rawForEvent = lastVerificationToken;
    // Test hook (same pattern as lastRawToken): E2E/integration capture the
    // raw without reading email bodies.
    this.lastVerificationToken = lastVerificationToken;
    await this.eventPublisher.emit('email.verification_requested', {
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
      // FOR UPDATE lookup scoped to (tokenHash, userId) — concurrent same raw serializes here (store-owned).
      const found = await this.verificationTokens.findForUpdate(
        manager,
        tokenHash,
        user.id,
      );
      // Single-use or expired or wrong-user hash → 400 without mutating
      if (
        !found ||
        found.usedAt ||
        found.expiresAt.getTime() <= this.clock.now().getTime()
      ) {
        throw new BadRequestException('Invalid or expired verification token');
      }
      await this.verificationTokens.markTokenAsUsed(manager, found);
      // Set verified once (idempotent flag, no toggle) via UsersService (US2).
      if (!user.emailVerified) {
        await this.usersService.setEmailVerified(user.id, manager);
      }
    });
    // Hash prefix only — raw token is never logged
    this.logger.log(
      `email verified userId=${user.id} hashPrefix=${hashPrefix}`,
    );
    // Optional post-commit event — outside the tx, fail-open
    await this.eventPublisher.emit('auth.email_verified', {
      userId: user.id,
      email: dto.email,
    });
    return { verified: true, emailVerified: true };
  }

  /**
   * Re-sends the verification email with anti-enumeration and a 60s per-email cooldown.
   * @param email - User email to re-send to.
   * @returns Anti-enum 200 message, or distinct already-verified 200.
   * @throws VerificationCooldownError when the 60s cooldown is still active
   *   (before any transaction; the controller renders the 429 wire shape).
   */
  async resendVerification(email: string): Promise<{ message: string }> {
    const normalized = email.toLowerCase();
    // 60s cooldown prevents burst re-sends — checked before any DB
    // Cache-Read: if the cooldown is active, throw before any DB transaction (0 calls).
    if (await this.verificationTokens.isCooldownActive(normalized)) {
      // Cooldown active → deny immediately, 0 transaction calls.
      throw new VerificationCooldownError(60);
    }

    // DB-Read: find user by email
    const user = await this.usersService.findUserByEmail(email);
    // Anti-enumeration: same message whether or not the email exists
    if (!user) {
      this.logger.debug(`resendVerification anti-enum email=${email}`);
      return {
        message:
          'This email is not registered or already verified. If an account exists, a verification email has been sent.',
      };
    }
    // Verified users get a distinct message and no new token/email
    if (user.emailVerified) {
      return { message: 'Email already verified' };
    }

    const expiresAt = new Date(
      this.clock.now().getTime() + this.tokenConfig.emailVerificationTtlMs,
    );

    let lastVerificationToken: string | undefined;

    await this.dataSource.transaction(async (manager) => {
      // Invalidate priors so the old link dies exactly when the new one is
      // born (a racing verifyEmail on the old raw serializes on FOR UPDATE
      // and sees usedAt → 400). Store-owned; returns the winning raw.
      const winningRaw = await this.verificationTokens.newVerificationIssue(
        manager,
        user.id,
        expiresAt,
        () => {
          const r = generateHex();
          return { raw: r, hash: sha256Hex(r) };
        },
        (e: unknown) => this.isUniqueViolation(e),
        false, // resend path never retried collisions (legacy propagates)
      );
      lastVerificationToken = winningRaw;
    });
    // Arm the 60s cooldown after a successful issue (store-owned, fail-open).
    await this.verificationTokens.markCooldown(normalized);
    // Test hook (same pattern as lastRawToken).
    this.lastVerificationToken = lastVerificationToken;
    // Publish after commit — outside dataSource.transaction
    await this.eventPublisher.emit('email.verification_requested', {
      userId: user.id,
      email,
      rawToken: lastVerificationToken,
      expiresAt: expiresAt.toISOString(),
    });
    return {
      message: 'If an account exists, a verification email has been sent.',
    };
  }

  // ============ Phase 16: WhatsApp OTP — TODO (Future) DEFERRED per 2026-09-16 ============
  // Logic remains implemented but controller returns 501 until WhatsApp Business setup.
  // Password-only login is enforced in V1. Re-enable by removing 501 guard in auth.controller.ts.
  /**
   * Issues a 6-digit OTP (deferred path: controller currently returns 501).
   *
   * @param dto - {phoneNumber, purpose} (phone falls back to the caller's own).
   * @param currentUser - Authenticated caller, if any.
   * @returns Seconds until expiry.
   * @throws BadRequestException on missing/invalid phone or unsupported purpose.
   */
  async requestWhatsAppOtp(
    dto: { phoneNumber?: string; purpose?: OtpPurpose },
    currentUser?: Partial<User>,
  ): Promise<{ expiresIn: number }> {
    let phone = dto.phoneNumber;
    if (!phone && currentUser?.phoneNumber) phone = currentUser.phoneNumber;

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
    const otp = crypto.randomInt(100000, 999999).toString();
    this.lastOtp = otp;
    const codeHash = sha256Hex(otp);
    const ttlMs = this.tokenConfig.otpTtlMs;
    const expiresAt = new Date(this.clock.now().getTime() + ttlMs);
    // State owned by OtpStore (cooldown gate, Redis record, PG audit).
    // Provider send stays here: external I/O after state, fail-open.
    const user = phone ? await this.usersService.findUserByPhone(phone) : null;
    await this.otpStore.issue(
      phone,
      purpose,
      { codeHash, expiresAt },
      ttlMs,
      user?.id ?? null,
    );
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

  /**
   * Verifies an OTP attempt and continues post-verification orchestration
   * (flag set or passwordless login). State machine lives in OtpStore.
   *
   * @param dto - {phoneNumber, otp, purpose}.
   * @returns Verification result or fresh login pair (purpose-dependent).
   * @throws BadRequestException on invalid/expired OTP or too many attempts.
   */
  async verifyWhatsAppOtp(dto: {
    phoneNumber: string;
    otp: string;
    purpose?: OtpPurpose;
  }): Promise<any> {
    const phone = dto.phoneNumber;
    const purpose = (dto.purpose as OtpPurpose) || OtpPurpose.Login;
    const codeHash = sha256Hex(dto.otp);
    // State machine owned by OtpStore (Redis primary, PG fallback). The
    // purpose for post-verification orchestration stays the verify call's
    // (legacy: dto.purpose || Login), not the stored record's.
    await this.otpStore.verifyAttempt(phone, codeHash, purpose);
    return this.handleOtpSuccess(phone, purpose);
  }

  private async handleOtpSuccess(phone: string, purpose: OtpPurpose) {
    const user = await this.usersService.findUserByPhone(phone);
    if (purpose === OtpPurpose.VerifyPhone) {
      if (user) {
        await this.usersService.setPhoneVerified(user.id);
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
      await this.usersService.setPhoneVerified(target.id);
    }
    return this.login(target);
  }

  // ============ Phase 16: Google OAuth ============ (Phase 17 extends to issue refresh)
  /**
   * Signs in with a verified Google profile: existing Google link returns,
   * verified-email match auto-links, otherwise a Google user is created.
   *
   * @param profile - Verified Google profile (email, names, googleId).
   * @returns User plus fresh access/refresh pair.
   * @throws BadRequestException on unverified provider email.
   */
  async handleGoogleLogin(profile: GoogleProfile): Promise<{
    user: Partial<User>;
    accessToken: string;
    refreshToken: string;
  }> {
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
      // auto-link per Q1 — write owned by UsersService (US2), 409 mapping kept here.
      try {
        await this.usersService.linkGoogleAccount(
          existingByEmail.id,
          profile.googleId,
        );
      } catch (e: any) {
        if (this.isUniqueViolation(e))
          throw new ConflictException('Google account already linked');
        throw e;
      }
      const updated = await this.usersService.findUserById(existingByEmail.id);
      const { accessToken, refreshToken } = await this.login(updated!);
      return { user: updated!, accessToken, refreshToken };
    }
    // Google-create owned by UsersService (US2): same fields, same 409 mapping.
    let saved: Partial<User>;
    try {
      saved = await this.usersService.createNewUser({
        email: profile.email,
        firstName: profile.firstName || 'Google',
        lastName: profile.lastName || 'User',
        googleId: profile.googleId,
        provider: AuthProvider.Google,
        password: null,
        phoneVerified: false,
        emailVerified: profile.verified,
      });
    } catch (e: any) {
      if (
        (e instanceof HttpException ||
          e instanceof ConflictException ||
          e instanceof BadRequestException) &&
        this.isUniqueViolation(e)
      )
        throw new ConflictException('Google account already linked');
      throw e;
    }
    const { accessToken, refreshToken } = await this.login(saved);
    return { user: saved, accessToken, refreshToken };
  }

  private isUniqueViolation(error: unknown): boolean {
    if (!(error instanceof Error)) return false;

    const code = 'code' in error ? error.code : undefined;
    const message = error.message;

    return (
      code === '23505' ||
      message.includes('duplicate') ||
      message.includes('UNIQUE') ||
      message.includes('UQ_user_googleId') ||
      message.includes('unique')
    );
  }

  /**
   * Links a Google identity to the current user (verified provider email only).
   *
   * @param userId - Owner user id (from the payload subject, S-1).
   * @param profile - Verified Google profile.
   * @returns The linked user.
   * @throws BadRequestException on unverified email; ConflictException on
   *   double-link.
   */
  async linkGoogleAccount(
    userId: string,
    profile: GoogleProfile,
  ): Promise<User> {
    if (!profile.verified)
      throw new BadRequestException('Google email not verified');
    const existing = await this.usersService.findByGoogleId(profile.googleId);
    if (existing && existing.id !== userId)
      throw new ConflictException('Google account already linked');
    // Write owned by UsersService (US2); 409 mapping kept here.
    try {
      await this.usersService.linkGoogleAccount(userId, profile.googleId);
    } catch (e: any) {
      if (this.isUniqueViolation(e))
        throw new ConflictException('Google account already linked');
      throw e;
    }
    return (await this.usersService.findUserById(userId))!;
  }
}
