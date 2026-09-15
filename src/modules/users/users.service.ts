import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import User from './entity/user.entity';
import { UserRegisterDto } from '../auth/dto/user-register.dto';

@Injectable()
export class UsersService {
  constructor(
    @InjectRepository(User)
    private readonly userRepo: Repository<User>,
  ) {}

  async findUserByEmail(email: string): Promise<User | null> {
    return await this.userRepo.findOne({ where: { email } });
  }

  async findUserById(id: string): Promise<User | null> {
    return await this.userRepo.findOne({ where: { id } });
  }

  async findByGoogleId(googleId: string): Promise<User | null> {
    return await this.userRepo.findOne({ where: { googleId } });
  }

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

  async incrementTokenVersion(userId: string): Promise<void> {
    await this.userRepo.increment({ id: userId }, 'tokenVersion', 1);
  }

  async createNewUser(data: any) {
    return await this.userRepo.save(data);
  }
}
