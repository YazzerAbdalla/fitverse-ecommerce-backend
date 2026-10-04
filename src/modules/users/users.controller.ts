/**
 * User self-service HTTP endpoints (profile read, preference update).
 * No business logic, no persistence — delegates to UsersService.
 *
 * Responsibility (SRP): user HTTP transport, nothing else.
 * Used by: UsersModule (route registration).
 * Depends on: UsersService.
 */
import {
  Body,
  Controller,
  Get,
  NotFoundException,
  Patch,
  UnauthorizedException,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiResponse } from '@nestjs/swagger';
import { Auth } from '../auth/decorators/auth.decorator';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import type { JwtPayloadProps } from '../auth/types';
import { UpdatePreferencesDto } from './dto/update-preferences.dto';
import { toSafeUser } from './dto/safe-user-response.dto';
import { UsersService } from './users.service';

/**
 * This controller exposes user self-service endpoints.
 * It handles reading own profile (incl. verification and preference flags) and updating preferences thinly.
 */
@Controller('users')
export class UsersController {
  constructor(private readonly usersService: UsersService) {}

  /**
   * Returns the current user's profile (client-safe projection).
   * @param user - Authenticated JWT payload.
   * @returns Own user as SafeUserResponseDto (never password/token hashes).
   * @throws UnauthorizedException if the payload carries no subject.
   * @throws NotFoundException if the user row no longer exists.
   */
  @Get('me')
  @Auth()
  @ApiBearerAuth('JWT-auth')
  @ApiOperation({ summary: 'Get own profile' })
  @ApiResponse({ status: 200, description: 'Own user with preference flags' })
  @ApiResponse({ status: 401, description: 'Unauthorized' })
  @ApiResponse({ status: 404, description: 'User not found' })
  async getMe(@CurrentUser() user: JwtPayloadProps) {
    const userId = user?.sub;
    if (!userId) {
      throw new UnauthorizedException();
    }
    const found = await this.usersService.findUserById(userId);
    if (!found) {
      throw new NotFoundException(`User ${userId} not found.`);
    }
    // Allow-list projection: password hash and any future token columns
    // can never leak even when the entity gains new sensitive fields.
    return toSafeUser(found);
  }

  /**
   * Updates the current user's notification preferences.
   * @param userId - Authenticated user id (JWT sub).
   * @param dto - Either-or preference payload.
   * @returns The persisted preference flags.
   * @throws BadRequestException if neither flag is provided.
   */
  @Patch('me/preferences')
  @Auth()
  @ApiBearerAuth('JWT-auth')
  @ApiOperation({ summary: 'Update own notification preferences' })
  @ApiResponse({ status: 200, description: 'Updated preference flags' })
  @ApiResponse({ status: 401, description: 'Unauthorized' })
  async updatePreferences(
    @CurrentUser('sub') userId: string,
    @Body() dto: UpdatePreferencesDto,
  ) {
    return this.usersService.updatePreferences(userId, dto);
  }
}
