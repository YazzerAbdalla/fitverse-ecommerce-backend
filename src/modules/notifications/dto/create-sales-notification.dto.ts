import { ApiProperty } from '@nestjs/swagger';
import {
  IsNotEmpty,
  IsOptional,
  IsString,
  IsUUID,
  Length,
} from 'class-validator';

/**
 * This DTO validates admin sales broadcast creation.
 * It handles title/body plus optional product scope for new_product fan-out.
 */
export class CreateSalesNotificationDto {
  @ApiProperty({ example: 'Winter Sale -20%' })
  @IsString()
  @IsNotEmpty()
  @Length(1, 200)
  title!: string;

  @ApiProperty({ example: 'Up to 20% off selected products this week.' })
  @IsString()
  @IsNotEmpty()
  body!: string;

  @ApiProperty({ required: false, example: [] })
  @IsOptional()
  @IsUUID('4', { each: true })
  productIds?: string[];
}
