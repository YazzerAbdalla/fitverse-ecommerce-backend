import { BadRequestException } from '@nestjs/common';
import { EntityManager } from 'typeorm';
import { Reservation } from './entities/reservation.entity';
import { ReservationStatus } from './entities/reservation-status.enum';
import { UserRoles } from '../users/enum/roles';
import type { ReservationService } from './reservation.service';

/**
 * Builder for reservation status transitions.
 * Encapsulates the many optional positional args of `transitionWithInventoryInternal`
 * (userId, orderId, role, checkOwner) into a fluent API.
 * Usage: `new ReservationTransitionBuilder(service, manager, id).to(EXPIRED).withoutOwnerCheck().execute()`
 */
export class ReservationTransitionBuilder {
  private requestingUserId: string | null = null;
  private toStatus!: ReservationStatus;
  private orderId?: string;
  private role?: UserRoles;
  private checkOwner = true;

  constructor(
    private readonly service: ReservationService,
    private readonly manager: EntityManager,
    private readonly id: string,
  ) {}

  /** Sets target status. */
  to(status: ReservationStatus): this {
    this.toStatus = status;
    return this;
  }

  /** Sets requesting user + role for owner check. */
  forUser(userId: string | null, role?: UserRoles): this {
    this.requestingUserId = userId;
    if (role !== undefined) this.role = role;
    return this;
  }

  /** Sets orderId for COMPLETED transitions (Q3 overwrite). */
  withOrderId(orderId?: string): this {
    this.orderId = orderId;
    return this;
  }

  /** Sets role explicitly. */
  withRole(role?: UserRoles): this {
    this.role = role;
    return this;
  }

  /** Disables owner assertion (admin/worker bypass). */
  withoutOwnerCheck(): this {
    this.checkOwner = false;
    return this;
  }

  /** Enables/disables owner check explicitly. */
  withOwnerCheck(check: boolean): this {
    this.checkOwner = check;
    return this;
  }

  /** Executes the transition via the service's internal method. */
  async execute(): Promise<Reservation> {
    if (!this.toStatus) {
      throw new BadRequestException('Target status is required');
    }
    // Access private internal via bracket to keep encapsulation while reusing single tx path
    return await (this.service as any).transitionWithInventoryInternal(
      this.manager,
      this.requestingUserId,
      this.id,
      this.toStatus,
      this.orderId,
      this.role,
      this.checkOwner,
    );
  }
}
