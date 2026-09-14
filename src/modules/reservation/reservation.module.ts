import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Reservation } from './entities/reservation.entity';
import { ReservationItem } from './entities/reservation-item.entity';
import { ReservationService } from './reservation.service';
import { ReservationController } from './reservation.controller';

@Module({
  imports: [TypeOrmModule.forFeature([Reservation, ReservationItem])],
  controllers: [ReservationController],
  providers: [ReservationService],
  exports: [ReservationService],
})
export class ReservationModule {}
