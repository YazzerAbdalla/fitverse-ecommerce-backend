import { Module } from '@nestjs/common';
import { UsersService } from './users.service';
import { UsersController } from './users.controller';
import { TypeOrmModule } from '@nestjs/typeorm';
import User from './entity/user.entity';

/**
 * This module exposes user persistence and self-service profile endpoints.
 * It handles user CRUD-by-email plus GET /users/me and PATCH /users/me/preferences.
 *
 * Note (S-1): UsersController's @Auth() JwtGuard needs UsersService, which is
 * provided right here — no AuthModule import, so the auth->users edge stays
 * one-way (no circular dependency).
 */
@Module({
  imports: [TypeOrmModule.forFeature([User])],
  controllers: [UsersController],
  providers: [UsersService],
  exports: [UsersService],
})
export class UsersModule {}
