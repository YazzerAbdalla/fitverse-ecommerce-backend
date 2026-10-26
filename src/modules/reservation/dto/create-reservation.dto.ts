import {
  ArrayMinSize,
  IsArray,
  IsDateString,
  IsInt,
  IsOptional,
  IsUUID,
  Min,
  ValidateNested,
} from 'class-validator';
import { Type } from 'class-transformer';
import { EntityManager } from 'typeorm';
import { Inventory } from 'src/modules/inventory/entities/inventory.entity';

export class ReservationItemDto {
  @IsUUID()
  inventoryId!: string;

  @IsInt()
  @Min(1)
  quantity!: number;
}

export class CreateReservationDto {
  @IsOptional()
  @IsDateString()
  expiresAt?: string;

  @IsOptional()
  @IsUUID()
  orderId?: string;

  @IsArray()
  @ArrayMinSize(1)
  @ValidateNested({ each: true })
  @Type(() => ReservationItemDto)
  items!: ReservationItemDto[];
}

export class CreateReservationRefactored {
  manager!: EntityManager;

  productsMap!: Map<string, number>;

  @IsOptional()
  @IsUUID()
  orderId?: string;

  @IsOptional()
  @IsInt()
  @Min(5)
  reservationDurationInMinutes?: number;

  @IsUUID()
  userId!: string;

  inventoryRows!: Inventory[];
}
