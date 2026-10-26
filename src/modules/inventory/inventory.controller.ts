import {
  Body,
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
} from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { Auth } from '../auth/decorators/auth.decorator';
import { UserRoles } from '../users/enum/roles';
import { InventoryService } from './inventory.service';
import { IncreaseStockDto } from './dto/increase-stock.dto';
import { DecreaseStockDto } from './dto/decrease-stock.dto';
import { IsInt, Min } from 'class-validator';
import { Type } from 'class-transformer';

class AvailabilityQueryDto {
  @Type(() => Number)
  @IsInt()
  @Min(1)
  quantity!: number;
}

@ApiTags('inventory')
@ApiBearerAuth()
@Controller('inventory')
export class InventoryController {
  constructor(private readonly inventoryService: InventoryService) {}

  @Auth()
  @Get(':productId')
  async getInventory(@Param('productId', ParseUUIDPipe) productId: string) {
    const inventory = await this.inventoryService.getInventory(productId);
    return {
      id: inventory.id,
      productId: inventory.productId,
      stock: inventory.stock,
      reservedAmount: inventory.reservedAmount,
      available: inventory.available,
      createdAt: inventory.createdAt,
      updatedAt: inventory.updatedAt,
    };
  }

  @Auth()
  @Get(':productId/availability')
  async checkProductAvailability(
    @Param('productId', ParseUUIDPipe) productId: string,
    @Query() query: AvailabilityQueryDto,
  ) {
    // Manual validation fallback if ValidationPipe not applied to query
    const quantity = Number(query.quantity);
    const inventory = await this.inventoryService.getInventory(productId);
    const sufficient = inventory.available >= quantity;
    return {
      available: inventory.available,
      requested: quantity,
      sufficient,
    };
  }

  // Admin-only (019 T002b): any-role stock writes would bypass the
  // dashboard's admin-only + throttled path (FR-009). Reads stay any-role.
  @Auth(UserRoles.Admin)
  @Post(':productId/increase')
  async increaseStock(
    @Param('productId', ParseUUIDPipe) productId: string,
    @Body() dto: IncreaseStockDto,
  ) {
    const inventory = await this.inventoryService.increaseStock(
      productId,
      dto.quantity,
    );
    return {
      id: inventory.id,
      productId: inventory.productId,
      stock: inventory.stock,
      reservedAmount: inventory.reservedAmount,
      available: inventory.available,
      createdAt: inventory.createdAt,
      updatedAt: inventory.updatedAt,
    };
  }

  // Admin-only (019 T002b): see increaseStock above. Reads stay any-role.
  @Auth(UserRoles.Admin)
  @Post(':productId/decrease')
  async decreaseStock(
    @Param('productId', ParseUUIDPipe) productId: string,
    @Body() dto: DecreaseStockDto,
  ) {
    const inventory = await this.inventoryService.decreaseStock(
      productId,
      dto.quantity,
    );
    return {
      id: inventory.id,
      productId: inventory.productId,
      stock: inventory.stock,
      reservedAmount: inventory.reservedAmount,
      available: inventory.available,
      createdAt: inventory.createdAt,
      updatedAt: inventory.updatedAt,
    };
  }
}
