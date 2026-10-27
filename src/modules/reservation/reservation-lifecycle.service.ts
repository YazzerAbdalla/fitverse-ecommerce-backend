import { Injectable, ConflictException } from '@nestjs/common';

import { ReservationStatus } from './entities/reservation-status.enum';
import { ReservationRefactoredService } from './reservation-refactored.service';
import { Reservation } from './entities/reservation.entity';

type TransitionHandler = (reservation: Reservation) => Promise<void>;

@Injectable()
export class ReservationLifecycleService {
  constructor(
    private readonly reservationRefactoredService: ReservationRefactoredService,
  ) {}

  private readonly reservationTransitionPlan: Record<
    ReservationStatus,
    Partial<Record<ReservationStatus, TransitionHandler>>
  > = {
    [ReservationStatus.RESERVED]: {
      [ReservationStatus.COMPLETED]: (reservation) =>
        this.transitionToCompleted(reservation),

      [ReservationStatus.EXPIRED]: (reservation) =>
        this.transitionToExpired(reservation),

      [ReservationStatus.CANCELLED]: (reservation) =>
        this.transitionToCancelled(reservation),
    },

    [ReservationStatus.COMPLETED]: {},
    [ReservationStatus.EXPIRED]: {},
    [ReservationStatus.CANCELLED]: {},
  };

  async resolveReservationStatusTransition(
    orderId: string,
    userId: string,
    nextStatus: ReservationStatus,
  ): Promise<void> {
    // Get the reservation my user and order idx
    const reservation =
      await this.reservationRefactoredService.getReservationByOrderId(
        orderId,
        userId,
      );

    const currentStatus = reservation.status;

    const handler = this.reservationTransitionPlan[currentStatus]?.[nextStatus];

    if (!handler) {
      throw new ConflictException(
        `Invalid reservation transition: ${currentStatus} -> ${nextStatus}`,
      );
    }

    await handler(reservation);
  }

  async transitionToCompleted(reservation: Reservation): Promise<void> {
    // Implement RESERVED -> COMPLETED business logic.
    reservation.status = ReservationStatus.COMPLETED;
    await this.reservationRefactoredService.saveUpdatedReservation(reservation);
  }

  async transitionToExpired(reservation: Reservation): Promise<void> {
    // Implement RESERVED -> EXPIRED business logic.
    reservation.status = ReservationStatus.EXPIRED;
    await this.reservationRefactoredService.saveUpdatedReservation(reservation);
  }

  async transitionToCancelled(reservation: Reservation): Promise<void> {
    // Implement RESERVED -> CANCELLED business logic.
    reservation.status = ReservationStatus.CANCELLED;
    await this.reservationRefactoredService.saveUpdatedReservation(reservation);
  }
}
