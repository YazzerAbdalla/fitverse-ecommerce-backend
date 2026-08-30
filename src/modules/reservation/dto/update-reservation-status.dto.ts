import { IsOptional, IsUUID } from 'class-validator';

export class UpdateReservationStatusDto {
  @IsOptional()
  @IsUUID()
  orderId?: string;
}
