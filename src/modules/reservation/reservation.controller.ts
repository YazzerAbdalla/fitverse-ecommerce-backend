import {
  Body,
  Controller,
  Get,
  Param,
  Patch,
  Post,
  Query,
} from '@nestjs/common';
import { Auth } from '../auth/decorators/auth.decorator';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { UserRoles } from '../users/enum/roles';
import { ReservationService } from './reservation.service';
import { CreateReservationDto } from './dto/create-reservation.dto';
import { UpdateReservationStatusDto } from './dto/update-reservation-status.dto';
import { Reservation } from './entities/reservation.entity';

@Controller('reservations')
@Auth(UserRoles.User, UserRoles.Admin)
export class ReservationController {
  constructor(private readonly reservationService: ReservationService) {}

  @Post()
  async create(
    @CurrentUser('sub') userId: string,
    @Body() dto: CreateReservationDto,
  ): Promise<Reservation> {
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
    return this.reservationService.dataSource.transaction((manager) =>
      this.reservationService.complete(manager, userId, id, dto, role),
    );
  }

  @Patch(':id/cancel')
  async cancel(
    @CurrentUser('sub') userId: string,
    @CurrentUser('role') role: UserRoles,
    @Param('id') id: string,
  ): Promise<Reservation> {
    return this.reservationService.dataSource.transaction((manager) =>
      this.reservationService.cancel(manager, userId, id, role),
    );
  }

  @Patch(':id/expire')
  @Auth(UserRoles.Admin)
  async expire(@Param('id') id: string): Promise<Reservation> {
    return this.reservationService.dataSource.transaction((manager) =>
      this.reservationService.expire(manager, id),
    );
  }
}
