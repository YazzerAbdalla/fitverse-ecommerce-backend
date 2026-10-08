import { ConflictException } from '@nestjs/common';
import { validate } from 'class-validator';
import { plainToInstance } from 'class-transformer';
import { Inventory } from '../inventory/entities/inventory.entity';
import { InventoryService } from '../inventory/inventory.service';
import { AdminProductsController } from './admin-products.controller';
import { AdminProductsService } from './admin-products.service';
import { AdjustStockDto } from './dto/adjust-stock.dto';

/**
 * Unit tests for admin stock adjustment (019 US3, T016).
 * The controller is thin: DTO validation + delegation to
 * InventoryService.adjustStockByDelta (guards proven in T004)
 * + inventory-view mapping. Real-PG proof (409 unchanged,
 * concurrent guards-intact) lives in the integration spec (T017).
 */

describe('AdjustStockDto validation', () => {
  async function validateAdjust(
    input: Record<string, unknown>,
  ): Promise<string[]> {
    const dto = plainToInstance(AdjustStockDto, input);
    const errors = await validate(dto);
    return errors.flatMap((error) => Object.values(error.constraints ?? {}));
  }

  it('accepts non-zero integer deltas', async () => {
    expect(await validateAdjust({ delta: 10 })).toEqual([]);
    expect(await validateAdjust({ delta: -3 })).toEqual([]);
  });

  it('rejects zero, non-integer, and missing deltas', async () => {
    expect(await validateAdjust({ delta: 0 })).not.toEqual([]);
    expect(await validateAdjust({ delta: 1.5 })).not.toEqual([]);
    expect(await validateAdjust({})).not.toEqual([]);
  });
});

describe('AdminProductsController.adjustProductStock (019 US3)', () => {
  let controller: AdminProductsController;
  let inventoryService: { adjustStockByDelta: jest.Mock };

  beforeEach(() => {
    inventoryService = { adjustStockByDelta: jest.fn() };
    controller = new AdminProductsController(
      {} as AdminProductsService,
      {} as never,
      inventoryService as unknown as InventoryService,
    );
  });

  const adjustedRow = {
    id: 'inv-1',
    productId: 'prod-1',
    stock: 15,
    reservedAmount: 2,
    available: 13,
  } as Inventory;

  it('delegates positive deltas and returns the inventory view', async () => {
    inventoryService.adjustStockByDelta.mockResolvedValue(adjustedRow);

    const result = await controller.adjustProductStock('prod-1', { delta: 5 });

    expect(inventoryService.adjustStockByDelta).toHaveBeenCalledWith(
      'prod-1',
      5,
    );
    expect(result).toMatchObject({
      id: 'inv-1',
      productId: 'prod-1',
      stock: 15,
      reservedAmount: 2,
      available: 13,
      status: 'in-stock',
    });
  });

  it('delegates negative deltas with recalculated status', async () => {
    inventoryService.adjustStockByDelta.mockResolvedValue({
      ...adjustedRow,
      stock: 4,
      reservedAmount: 2,
      available: 2,
    });

    const result = await controller.adjustProductStock('prod-1', {
      delta: -11,
    });

    expect(inventoryService.adjustStockByDelta).toHaveBeenCalledWith(
      'prod-1',
      -11,
    );
    expect(result).toMatchObject({ available: 2, status: 'low-stock' });
  });

  it('lets below-reserved 409 propagate with no view returned', async () => {
    inventoryService.adjustStockByDelta.mockRejectedValue(
      new ConflictException('Cannot decrease stock below reserved amount'),
    );

    await expect(
      controller.adjustProductStock('prod-1', { delta: -999 }),
    ).rejects.toThrow(ConflictException);
  });
});
