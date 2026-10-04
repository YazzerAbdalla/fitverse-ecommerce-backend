/**
 * User-record persistence: the sole writer of the user table.
 *
 * Responsibility (SRP): user persistence, nothing else.
 * Used by: AuthService/AuthController (via boundary), JwtGuard,
 *   UsersController, NotificationsModule (contact resolution).
 * Depends on: TypeORM User repository, DataSource (tx participation).
 */
import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { DataSource, EntityManager, Repository } from 'typeorm';
import User from './entity/user.entity';
import { AuthProvider } from './entity/user.entity';
import { UpdatePreferencesDto } from './dto/update-preferences.dto';

/**
 * This service is responsible for user persistence domain.
 * It handles user lookup, password/tokenVersion maintenance, creation and notification preferences.
 */
@Injectable()
export class UsersService {
  private readonly logger = new Logger(UsersService.name);

  constructor(
    @InjectRepository(User)
    private readonly userRepo: Repository<User>,
    private readonly dataSource: DataSource,
  ) {}

  /**
   * Finds a user by email.
   * @param email - User email address.
   * @param manager - Optional tx-scoped manager (participates, never commits).
   * @returns The user or null if not found.
   */
  async findUserByEmail(
    email: string,
    manager?: EntityManager,
  ): Promise<User | null> {
    this.logger.debug(`users findByEmail email=${email}`);
    const repo = manager ? manager.getRepository(User) : this.userRepo;
    return await repo.findOne({ where: { email } });
  }

  /**
   * Finds a user by id.
   * @param id - User UUID.
   * @param manager - Optional tx-scoped manager (participates, never commits).
   * @returns The user or null if not found.
   */
  async findUserById(
    id: string,
    manager?: EntityManager,
  ): Promise<User | null> {
    this.logger.debug(`users findById id=${id}`);
    const repo = manager ? manager.getRepository(User) : this.userRepo;
    return await repo.findOne({ where: { id } });
  }

  /**
   * Finds a user by id with a write lock (serializes concurrent mutations).
   * @param manager - Tx-scoped manager of the enclosing transaction.
   * @param id - User UUID.
   * @returns The locked user or null if not found.
   */
  async findUserByIdForUpdate(
    manager: EntityManager,
    id: string,
  ): Promise<User | null> {
    this.logger.debug(`users findForUpdate start id=${id}`);
    return await manager
      .getRepository(User)
      .createQueryBuilder('u')
      .setLock('pessimistic_write')
      .where('u.id = :id', { id })
      .getOne();
  }

  /**
   * Finds a user by email with a write lock (serializes concurrent verify).
   * @param manager - Tx-scoped manager of the enclosing transaction.
   * @param email - User email address.
   * @returns The locked user or null if not found.
   */
  async findUserByEmailForUpdate(
    manager: EntityManager,
    email: string,
  ): Promise<User | null> {
    this.logger.debug(`users findByEmailForUpdate start email=${email}`);
    return await manager
      .getRepository(User)
      .createQueryBuilder('u')
      .setLock('pessimistic_write')
      .where('u.email = :email', { email })
      .getOne();
  }

  /**
   * Finds a user by Google id.
   * @param googleId - Google OAuth subject id.
   * @param manager - Optional tx-scoped manager (participates, never commits).
   * @returns The user or null if not found.
   */
  async findByGoogleId(
    googleId: string,
    manager?: EntityManager,
  ): Promise<User | null> {
    this.logger.debug(`users findByGoogleId`);
    const repo = manager ? manager.getRepository(User) : this.userRepo;
    return await repo.findOne({ where: { googleId } });
  }

  /**
   * Finds a user by phone number.
   * @param phoneNumber - E.164 phone number.
   * @param manager - Optional tx-scoped manager (participates, never commits).
   * @returns The user or null if not found.
   */
  async findUserByPhone(
    phoneNumber: string,
    manager?: EntityManager,
  ): Promise<User | null> {
    this.logger.debug(`users findByPhone`);
    const repo = manager ? manager.getRepository(User) : this.userRepo;
    return await repo.findOne({ where: { phoneNumber } });
  }

  /**
   * Updates a user's password hash (and bumps tokenVersion).
   * Reshaped during RP-AUTH: the prior version built an explicit-version
   * update object and then ignored it (dead code — the method had no callers,
   * so nothing observable changes); this version honors it.
   * @param userId - User UUID.
   * @param hash - New bcrypt password hash.
   * @param tokenVersion - Optional explicit tokenVersion (defaults to increment).
   * @param options - Optional tx-scoped manager + passwordChangedAt stamp.
   * @returns Void.
   */
  async updatePassword(
    userId: string,
    hash: string,
    tokenVersion?: number,
    options?: { manager?: EntityManager; passwordChangedAt?: Date },
  ): Promise<void> {
    const repo = options?.manager
      ? options.manager.getRepository(User)
      : this.userRepo;
    // Explicit version when provided; otherwise atomic increment.
    const update: {
      password: string;
      tokenVersion: number | (() => string);
      passwordChangedAt?: Date;
    } = {
      password: hash,
      tokenVersion:
        typeof tokenVersion === 'number'
          ? tokenVersion
          : () => '"tokenVersion" + 1',
    };
    if (options?.passwordChangedAt) {
      update.passwordChangedAt = options.passwordChangedAt;
    }
    await repo.update(userId, update);
  }

  /**
   * Marks a user's email verified (idempotent flag set).
   * @param userId - User UUID.
   * @param manager - Optional tx-scoped manager (participates, never commits).
   * @returns Void.
   */
  async setEmailVerified(
    userId: string,
    manager?: EntityManager,
  ): Promise<void> {
    const repo = manager ? manager.getRepository(User) : this.userRepo;
    await repo.update(userId, { emailVerified: true });
  }

  /**
   * Marks a user's phone verified (idempotent flag set).
   * @param userId - User UUID.
   * @param manager - Optional tx-scoped manager (participates, never commits).
   * @returns Void.
   */
  async setPhoneVerified(
    userId: string,
    manager?: EntityManager,
  ): Promise<void> {
    const repo = manager ? manager.getRepository(User) : this.userRepo;
    await repo.update(userId, { phoneVerified: true });
  }

  /**
   * Issues (or re-issues) the single live email-verification token.
   * Overwrites the three verification columns so only one link is live;
   * the previous link dies exactly when the new one is born.
   * @param manager - Tx-scoped manager of the enclosing transaction.
   * @param userId - Owner user UUID.
   * @param tokenHash - sha256 hex of the new raw token (raw never stored).
   * @param expiresAt - Expiry instant (caller computes via Clock + TTL).
   * @returns Void.
   */
  async issueEmailVerificationToken(
    manager: EntityManager,
    userId: string,
    tokenHash: string,
    expiresAt: Date,
  ): Promise<void> {
    this.logger.debug(`users issueVerificationToken start id=${userId}`);
    await manager.getRepository(User).update(userId, {
      emailVerificationTokenHash: tokenHash,
      emailVerificationExpiresAt: expiresAt,
      emailVerificationUsedAt: null,
    });
  }

  /**
   * Consumes the live email-verification token (single-use) and flags verified.
   * @param manager - Tx-scoped manager of the enclosing transaction.
   * @param userId - Owner user UUID.
   * @param now - Consumption instant (caller passes Clock.now(); the store
   *   stays clock-free so the instant is explicit and testable).
   * @returns Void.
   */
  async consumeEmailVerificationToken(
    manager: EntityManager,
    userId: string,
    now: Date,
  ): Promise<void> {
    this.logger.debug(`users consumeVerificationToken start id=${userId}`);
    await manager.getRepository(User).update(userId, {
      emailVerificationUsedAt: now,
      emailVerified: true,
    });
  }

  /**
   * Links a Google identity to an existing user.
   * Unique-violation mapping stays with the caller (auth-domain error).
   * @param userId - User UUID.
   * @param googleId - Google OAuth subject id.
   * @param manager - Optional tx-scoped manager (participates, never commits).
   * @returns Void.
   * @throws Raw unique-violation error on double-link (caller maps to 409).
   */
  async linkGoogleAccount(
    userId: string,
    googleId: string,
    manager?: EntityManager,
  ): Promise<void> {
    const repo = manager ? manager.getRepository(User) : this.userRepo;
    await repo.update(userId, {
      googleId,
      provider: AuthProvider.Google,
    });
  }

  /**
   * Increments a user's tokenVersion (revokes outstanding JWTs).
   * @param userId - User UUID.
   * @param options - Optional tx-scoped manager + passwordChangedAt stamp
   *   (logout-all records the revocation moment; same single UPDATE).
   * @returns Void.
   */
  async incrementTokenVersion(
    userId: string,
    options?: { manager?: EntityManager; passwordChangedAt?: Date },
  ): Promise<void> {
    // One UPDATE shape for both paths: atomic increment, optional stamp.
    const update: {
      tokenVersion: () => string;
      passwordChangedAt?: Date;
    } = { tokenVersion: () => '"tokenVersion" + 1' };
    if (options?.passwordChangedAt) {
      update.passwordChangedAt = options.passwordChangedAt;
    }
    const repo = options?.manager
      ? options.manager.getRepository(User)
      : this.userRepo;
    await repo.update(userId, update);
  }

  /**
   * Persists a new user (opt-in flags pass through when present).
   * @param data - User creation payload (incl. optional marketingOptIn/emailOptIn).
   * @returns The saved user.
   */
  async createNewUser(data: Partial<User>): Promise<User> {
    return await this.userRepo.save(data);
  }

  /**
   * Updates a user's notification preferences.
   * @param userId - User UUID (owner from JWT sub).
   * @param dto - Either-or preference payload (marketingOptIn and/or emailOptIn).
   * @returns The persisted preference flags.
   * @throws BadRequestException if neither flag is provided.
   * @throws NotFoundException if the user does not exist.
   */
  async updatePreferences(
    userId: string,
    dto: UpdatePreferencesDto,
  ): Promise<{ marketingOptIn: boolean; emailOptIn: boolean }> {
    // Either-or update: at least one flag must be provided
    if (dto.marketingOptIn === undefined && dto.emailOptIn === undefined) {
      throw new BadRequestException(
        'At least one preference must be provided.',
      );
    }
    return this.dataSource.transaction(async (manager) => {
      // FOR UPDATE serializes concurrent PATCH calls for the same user
      const repo = manager.getRepository(User);
      const user = await repo.findOne({
        where: { id: userId },
        lock: { mode: 'pessimistic_write' },
      });
      if (!user) {
        throw new NotFoundException(`User ${userId} not found.`);
      }
      if (dto.marketingOptIn !== undefined) {
        user.marketingOptIn = dto.marketingOptIn;
      }
      if (dto.emailOptIn !== undefined) {
        user.emailOptIn = dto.emailOptIn;
      }
      const saved = await repo.save(user);
      this.logger.log(
        `preferences updated userId=${userId} marketingOptIn=${saved.marketingOptIn} emailOptIn=${saved.emailOptIn}`,
      );
      return {
        marketingOptIn: saved.marketingOptIn,
        emailOptIn: saved.emailOptIn,
      };
    });
  }
}
