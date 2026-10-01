import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { DataSource, Repository } from 'typeorm';
import User from './entity/user.entity';
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
   * @returns The user or null if not found.
   */
  async findUserByEmail(email: string): Promise<User | null> {
    return await this.userRepo.findOne({ where: { email } });
  }

  /**
   * Finds a user by id.
   * @param id - User UUID.
   * @returns The user or null if not found.
   */
  async findUserById(id: string): Promise<User | null> {
    return await this.userRepo.findOne({ where: { id } });
  }

  /**
   * Finds a user by Google id.
   * @param googleId - Google OAuth subject id.
   * @returns The user or null if not found.
   */
  async findByGoogleId(googleId: string): Promise<User | null> {
    return await this.userRepo.findOne({ where: { googleId } });
  }

  /**
   * Updates a user's password hash (and bumps tokenVersion).
   * @param userId - User UUID.
   * @param hash - New bcrypt password hash.
   * @param tokenVersion - Optional explicit tokenVersion (defaults to increment).
   * @returns Void.
   */
  async updatePassword(
    userId: string,
    hash: string,
    tokenVersion?: number,
  ): Promise<void> {
    const update: any = { password: hash };
    if (typeof tokenVersion === 'number') update.tokenVersion = tokenVersion;
    else update.tokenVersion = () => '"tokenVersion" + 1';
    // fallback to increment
    await this.userRepo.update(userId, {
      password: hash,
      tokenVersion: () => '"tokenVersion" + 1',
    });
  }

  /**
   * Increments a user's tokenVersion (revokes outstanding JWTs).
   * @param userId - User UUID.
   * @returns Void.
   */
  async incrementTokenVersion(userId: string): Promise<void> {
    await this.userRepo.increment({ id: userId }, 'tokenVersion', 1);
  }

  /**
   * Persists a new user (opt-in flags pass through when present).
   * @param data - User creation payload (incl. optional marketingOptIn/emailOptIn).
   * @returns The saved user.
   */
  async createNewUser(data: any) {
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
