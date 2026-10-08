import { ConflictException } from '@nestjs/common';
import { validate } from 'class-validator';
import { plainToInstance } from 'class-transformer';
import { Inventory } from '../inventory/entities/inventory.entity';
import { InventoryService } from '../inventory/inventory.service';
import { Product } from '../products/entities/product.entity';
import { ProductsService } from '../products/products.service';
import { AdminProductsController } from './admin-products.controller';
import { AdminProductsService } from './admin-products.service';
import { AdminCreateProductDto } from './dto/admin-create-product.dto';

/**
 * Unit tests for admin product creation (019 US2, T012).
 * The controller is thin: DTO validation + explicit field mapping +
 * delegation to ProductsService.create. Real duplicate/conflict
 * semantics live in ProductsService (already tested); here we prove
 * the dashboard maps fields 1:1, defaults missing stock to zero, and
 * lets 409s propagate with nothing else created.
 */

describe('AdminCreateProductDto validation', () => {
  async function validateCreate(
    input: Record<string, unknown>,
  ): Promise<string[]> {
    const dto = plainToInstance(AdminCreateProductDto, input);
    const errors = await validate(dto);
    return errors.flatMap((error) => Object.values(error.constraints ?? {}));
  }

  it('accepts a valid body with and without stock', async () => {
    expect(
      await validateCreate({
        name: 'W',
        description: 'D',
        price: 150,
        stock: 4,
      }),
    ).toEqual([]);
    expect(
      await validateCreate({ name: 'W', description: 'D', price: 150 }),
    ).toEqual([]);
  });

  it('rejects negative price and negative stock', async () => {
    expect(
      await validateCreate({ name: 'W', description: 'D', price: -1 }),
    ).not.toEqual([]);
    expect(
      await validateCreate({
        name: 'W',
        description: 'D',
        price: 1,
        stock: -2,
      }),
    ).not.toEqual([]);
  });

  it('rejects blank name/description and non-integer price', async () => {
    expect(
      await validateCreate({ name: '', description: 'D', price: 1 }),
    ).not.toEqual([]);
    expect(
      await validateCreate({ name: 'W', description: 'D', price: 1.5 }),
    ).not.toEqual([]);
  });
});

describe('AdminProductsController.createAdminProduct (019 US2)', () => {
  let controller: AdminProductsController;
  let productsService: { create: jest.Mock };
  let inventoryService: { getInventory: jest.Mock };

  beforeEach(() => {
    productsService = { create: jest.fn() };
    inventoryService = { getInventory: jest.fn() };
    controller = new AdminProductsController(
      {} as AdminProductsService,
      productsService as unknown as ProductsService,
      inventoryService as unknown as InventoryService,
    );
  });

  const savedProduct = {
    id: 'prod-1',
    name: 'Demo Widget',
    slug: 'demo-widget',
    description: 'Demo product',
    price: 150,
  } as Product;

  it('maps REST fields 1:1 onto CreateProductInput with explicit stock', async () => {
    productsService.create.mockResolvedValue(savedProduct);
    inventoryService.getInventory.mockResolvedValue({
      stock: 4,
      reservedAmount: 0,
      available: 4,
    });

    const dto: AdminCreateProductDto = {
      name: 'Demo Widget',
      description: 'Demo product',
      price: 150,
      stock: 4,
    };
    const result = await controller.createAdminProduct(dto);

    expect(productsService.create).toHaveBeenCalledWith({
      name: 'Demo Widget',
      description: 'Demo product',
      price: 150,
      stock: 4,
    });
    expect(result).toMatchObject({
      id: 'prod-1',
      stock: 4,
      available: 4,
      status: 'low-stock',
    });
  });

  it('defaults omitted stock to zero (out-of-stock)', async () => {
    productsService.create.mockResolvedValue(savedProduct);
    inventoryService.getInventory.mockResolvedValue({
      stock: 0,
      reservedAmount: 0,
      available: 0,
    });

    const dto: AdminCreateProductDto = {
      name: 'Demo Widget',
      description: 'Demo product',
      price: 150,
    };
    const result = await controller.createAdminProduct(dto);

    expect(productsService.create).toHaveBeenCalledWith(
      expect.objectContaining({ stock: 0 }),
    );
    expect(result).toMatchObject({ available: 0, status: 'out-of-stock' });
  });

  it('lets duplicate-name 409 propagate without follow-up reads', async () => {
    productsService.create.mockRejectedValue(
      new ConflictException('Product with same name or slug already exist'),
    );

    const dto: AdminCreateProductDto = {
      name: 'Demo Widget',
      description: 'dup',
      price: 150,
    };
    await expect(controller.createAdminProduct(dto)).rejects.toThrow(
      ConflictException,
    );
    expect(inventoryService.getInventory).not.toHaveBeenCalled();
  });
});
