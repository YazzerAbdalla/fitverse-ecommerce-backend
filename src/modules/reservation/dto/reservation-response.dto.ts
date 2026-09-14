import { ReservationStatus } from '../entities/reservation-status.enum';

export class ReservationResponseDto {
  id!: string;
  userId!: string;
  orderId!: string | null;
  status!: ReservationStatus;
  expiresAt!: Date;
  createdAt!: Date;
  updatedAt!: Date;
  items!: Array<{
    id: string;
    reservationId: string;
    inventoryId: string;
    quantity: number;
  }>;
}
