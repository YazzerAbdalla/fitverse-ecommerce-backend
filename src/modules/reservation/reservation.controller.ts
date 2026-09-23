import {
  Body,
  Controller,
  ForbiddenException,
  Get,
  Param,
  Patch,
  Post,
  Query,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOperation,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';
import { Auth } from '../auth/decorators/auth.decorator';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { UserRoles } from '../users/enum/roles';
import { ReservationService } from './reservation.service';
import { CreateReservationDto } from './dto/create-reservation.dto';
import { UpdateReservationStatusDto } from './dto/update-reservation-status.dto';
import { Reservation } from './entities/reservation.entity';

/**
 * This controller exposes reservation endpoints.
 * It handles thin delegation to ReservationService inside DataSource.transaction and documents idempotency semantics.
 * Same-transition (EXPIRED→EXPIRED, CANCELLED→CANCELLED) returns 200 idempotent with 0 delta; cross-transition returns 409.
 */
@ApiTags('reservations')
@Controller('reservations')
@Auth(UserRoles.User, UserRoles.Admin)
export class ReservationController {
  constructor(private readonly reservationService: ReservationService) {}

  @Post()
  @Auth(UserRoles.Admin, UserRoles.User)
  async create(
    @CurrentUser('sub') userId: string,
    @CurrentUser('role') role: UserRoles,
    @Body() dto: CreateReservationDto,
  ): Promise<Reservation> {
    // checkout-only: block User role
    if (role !== UserRoles.Admin) {
      throw new ForbiddenException(
        'Reservation can only be created via POST /order/checkout',
      );
    }
    return this.reservationService.dataSource.transaction((manager) =>
      this.reservationService.create(manager, userId, dto),
    );
  }

  @Get(':id')
  async getOne(
    @CurrentUser('sub') userId: string,
    @CurrentUser('role') role: UserRoles,
    @Param('id') id: string,
  ): Promise<Reservation> {
    return this.reservationService.findById(userId, id, role);
  }

  @Get()
  async list(
    @CurrentUser('sub') userId: string,
    @CurrentUser('role') role: UserRoles,
    @Query('page') page?: string,
    @Query('limit') limit?: string,
    @Query('userId') filterUserId?: string,
  ) {
    return this.reservationService.listByUser(
      userId,
      { page: page ? +page : 1, limit: limit ? +limit : 20 },
      filterUserId ? { userId: filterUserId } : undefined,
      role,
    );
  }

  @Patch(':id/complete')
  async complete(
    @CurrentUser('sub') userId: string,
    @CurrentUser('role') role: UserRoles,
    @Param('id') id: string,
    @Body() dto: UpdateReservationStatusDto,
  ): Promise<Reservation> {
    if (role !== UserRoles.Admin) {
      throw new ForbiddenException(
        'Reservation transitions via Order lifecycle only',
      );
    }
    return this.reservationService.dataSource.transaction((manager) =>
      this.reservationService.complete(manager, userId, id, dto, role),
    );
  }

  /**
   * Cancels a reservation (RESERVED→CANCELLED). Idempotent CANCELLED→CANCELLED returns 200 with 0 delta.
   * @param userId - Requesting user id.
   * @param role - Requesting role.
   * @param id - Reservation id.
   * @returns Reservation with 200 idempotent or 409 for cross-transition.
   * @throws ForbiddenException if not admin.
   */
  @Patch(':id/cancel')
  @ApiBearerAuth('JWT-auth')
  @ApiOperation({ summary: 'Cancel reservation (RESERVED→CANCELLED)' })
  @ApiResponse({
    status: 200,
    description: 'Cancelled or already CANCELLED idempotent (0 delta)',
  })
  @ApiResponse({
    status: 409,
    description: 'Conflicting cross-transition (e.g. COMPLETED→CANCELLED)',
  })
  @ApiResponse({ status: 404, description: 'Reservation not found' })
  async cancel(
    @CurrentUser('sub') userId: string,
    @CurrentUser('role') role: UserRoles,
    @Param('id') id: string,
  ): Promise<Reservation> {
    if (role !== UserRoles.Admin) {
      throw new ForbiddenException(
        'Reservation transitions via Order lifecycle only',
      );
    }
    return this.reservationService.dataSource.transaction((manager) =>
      this.reservationService.cancel(manager, userId, id, role),
    );
  }

  /**
   * Expires a reservation (RESERVED→EXPIRED). Idempotent EXPIRED→EXPIRED returns 200 with 0 delta.
   * @param id - Reservation id.
   * @returns Reservation with 200 idempotent or 409 for cross-transition.
   */
  @Patch(':id/expire')
  @Auth(UserRoles.Admin)
  @ApiBearerAuth('JWT-auth')
  @ApiOperation({ summary: 'Expire reservation (RESERVED→EXPIRED)' })
  @ApiResponse({
    status: 200,
    description: 'Expired or already EXPIRED idempotent (0 delta)',
  })
  @ApiResponse({
    status: 409,
    description: 'Conflicting cross-transition (e.g. COMPLETED→EXPIRED)',
  })
  @ApiResponse({ status: 404, description: 'Reservation not found' })
  async expire(@Param('id') id: string): Promise<Reservation> {
    return this.reservationService.dataSource.transaction((manager) =>
      this.reservationService.expire(manager, id),
    );
  }
}
