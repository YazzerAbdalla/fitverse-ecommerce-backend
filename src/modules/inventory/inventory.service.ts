import {
  ConflictException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
  forwardRef,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { EntityManager, In, Repository } from 'typeorm';
import { Inventory } from './entities/inventory.entity';
import { ProductsService } from '../products/products.service';

/**
 * This service is responsible for the inventory domain.
 * It owns all mutations of Inventory.stock/reservedAmount
 * (available is derived as stock - reservedAmount, never stored)
 * and enforces the stock/reserved invariants.
 */
@Injectable()
export class InventoryService {
  private readonly logger = new Logger(InventoryService.name);

  constructor(
    @InjectRepository(Inventory)
    private readonly inventoryRepo: Repository<Inventory>,
    @Inject(forwardRef(() => ProductsService))
    private readonly productsService: ProductsService,
  ) {}

  async createForProduct(
    productId: string,
    initialStock = 0,
  ): Promise<Inventory> {
    if (initialStock < 0) {
      throw new ConflictException('Initial stock cannot be negative');
    }

    const existing = await this.inventoryRepo.findOne({
      where: { productId },
    });
    if (existing) {
      this.logger.debug(`Inventory already exists for product ${productId}`);
      return existing;
    }

    const inventory = this.inventoryRepo.create({
      productId,
      stock: initialStock,
      reservedAmount: 0,
    });

    const saved = await this.inventoryRepo.save(inventory);
    this.logger.log(
      `Created inventory for product ${productId} with stock ${initialStock}`,
    );
    return saved;
  }

  async getInventory(productId: string): Promise<Inventory> {
    const inventory = await this.inventoryRepo.findOne({
      where: { productId },
    });

    if (!inventory) {
      throw new NotFoundException(
        `Inventory for product ${productId} not found`,
      );
    }

    return inventory;
  }

  async checkProductAvailability(
    productId: string,
    neededQuantity: number,
  ): Promise<boolean> {
    if (!Number.isInteger(neededQuantity) || neededQuantity <= 0) {
      throw new ConflictException('Quantity must be a positive integer');
    }

    const inventory = await this.getInventory(productId);

    return inventory.available >= neededQuantity;
  }

  async increaseStock(productId: string, quantity: number): Promise<Inventory> {
    if (!Number.isInteger(quantity) || quantity <= 0) {
      throw new ConflictException('Quantity must be a positive integer');
    }

    const inventory = await this.getInventory(productId);
    inventory.stock += quantity;

    return this.inventoryRepo.save(inventory);
  }

  async decreaseStock(productId: string, quantity: number): Promise<Inventory> {
    if (!Number.isInteger(quantity) || quantity <= 0) {
      throw new ConflictException('Quantity must be a positive integer');
    }

    const inventory = await this.getInventory(productId);

    if (inventory.stock - quantity < 0) {
      throw new ConflictException(
        `Insufficient stock for product ${productId}. Available stock: ${inventory.stock}, requested: ${quantity}`,
      );
    }

    inventory.stock -= quantity;

    // Ensure invariant reservedAmount <= stock after decrease
    if (inventory.reservedAmount > inventory.stock) {
      throw new ConflictException(
        `Cannot decrease stock below reserved amount for product ${productId}`,
      );
    }

    return this.inventoryRepo.save(inventory);
  }

  async decreaseStockForOrderMany(
    manager: EntityManager,
    products: Array<Pick<Inventory, 'id' | 'stock'> & { soldQuantity: number }>,
  ): Promise<Inventory[]> {
    const inventoryRepo = manager.getRepository(Inventory);

    const updates = products.map((p) => {
      const newStock = p.stock - p.soldQuantity;
      if (newStock < 0) {
        throw new ConflictException(`Insufficient stock for inventory ${p.id}`);
      }
      return { id: p.id, stock: newStock };
    });

    return inventoryRepo.save(updates);
  }

  async restoreStockForOrderMany(
    manager: EntityManager,
    products: Array<Pick<Inventory, 'id' | 'stock'> & { soldQuantity: number }>,
  ): Promise<Inventory[]> {
    const inventoryRepo = manager.getRepository(Inventory);

    const updates = products.map((p) => ({
      id: p.id,
      stock: p.stock + p.soldQuantity,
    }));

    return inventoryRepo.save(updates);
  }

  async reserve(productId: string, quantity: number): Promise<Inventory> {
    if (!Number.isInteger(quantity) || quantity <= 0) {
      throw new ConflictException('Quantity must be a positive integer');
    }

    const inventory = await this.getInventory(productId);

    if (inventory.available < quantity) {
      throw new ConflictException(
        `Insufficient available inventory for product ${productId}. Available: ${inventory.available}, requested: ${quantity}`,
      );
    }

    inventory.reservedAmount += quantity;

    return this.inventoryRepo.save(inventory);
  }

  async releaseReservation(
    productId: string,
    quantity: number,
  ): Promise<Inventory> {
    if (!Number.isInteger(quantity) || quantity <= 0) {
      throw new ConflictException('Quantity must be a positive integer');
    }

    const inventory = await this.getInventory(productId);

    if (inventory.reservedAmount - quantity < 0) {
      throw new ConflictException(
        `Cannot release more than reserved for product ${productId}`,
      );
    }

    inventory.reservedAmount -= quantity;

    return this.inventoryRepo.save(inventory);
  }

  async completeSale(productId: string, quantity: number): Promise<Inventory> {
    if (!Number.isInteger(quantity) || quantity <= 0) {
      throw new ConflictException('Quantity must be a positive integer');
    }

    const inventory = await this.getInventory(productId);

    if (inventory.reservedAmount - quantity < 0) {
      throw new ConflictException(
        `Cannot complete sale: not enough reserved for product ${productId}`,
      );
    }

    if (inventory.stock - quantity < 0) {
      throw new ConflictException(
        `Insufficient stock to complete sale for product ${productId}`,
      );
    }

    inventory.stock -= quantity;
    inventory.reservedAmount -= quantity;

    return this.inventoryRepo.save(inventory);
  }

  /**
   * Adjusts on-hand stock by a signed delta for admin stock corrections.
   * Positive deltas restock, negative deltas draw stock down. Reserved
   * units are never touched here; only checkout/lifecycle flows mutate
   * reservedAmount, so held units survive admin edits by construction.
   *
   * @param productId - Product whose inventory row to adjust.
   * @param delta - Signed adjustment (must be non-zero; zero is rejected
   * upstream by the DTO, and rejected here as a backstop).
   * @returns The updated Inventory row.
   * @throws ConflictException if delta is zero, if the adjustment would
   * drop stock below zero, or below the currently reserved amount
   * (stock unchanged in all rejection cases).
   * @throws NotFoundException if no inventory row exists and delta is
   * negative (nothing to subtract); a positive delta auto-creates the
   * row at zero first so orphan products become fixable.
   */
  async adjustStockByDelta(
    productId: string,
    delta: number,
  ): Promise<Inventory> {
    // Sign dispatch: reuse the proven increase/decrease guards instead of
    // a third mutation path, so all invariants stay in one place.
    if (delta > 0) {
      try {
        return await this.increaseStock(productId, delta);
      } catch (error) {
        // Orphan repair (019 D3): products with no inventory row list as
        // out-of-stock; a restock creates the row at zero, then applies.
        if (error instanceof NotFoundException) {
          await this.createForProduct(productId, 0);
          return this.increaseStock(productId, delta);
        }
        throw error;
      }
    }
    if (delta < 0) {
      return this.decreaseStock(productId, -delta);
    }
    throw new ConflictException('Delta must not be zero');
  }

  // Deprecated compatibility alias
  checkProductAvailabilityMany(): never {
    throw new ConflictException('Not implemented');
  }

  increaseStockLegacy(): never {
    throw new ConflictException('Not implemented');
  }

  async checkManyAvailiablityOnCheckout(
    productsMap: Map<string, number>,
    productsIds: string[],
    manager: EntityManager,
  ): Promise<Inventory[]> {
    // 1. fetch the inventory rows using In() keyword
    const inventoryRows = await manager.find(Inventory, {
      where: { productId: In(productsIds) },
      lock: { mode: 'pessimistic_write' },
    });
    // create a map of productId to inventory row for easy lookup
    const inventoryMap = new Map(
      inventoryRows.map((row) => [row.productId, row]),
    );
    // 2. Check the inventory stock for those products
    for (const [productId, neededQuantity] of productsMap) {
      const inventoryRow = inventoryMap.get(productId);

      if (!inventoryRow) {
        throw new NotFoundException(
          `Inventory not found for product ${productId}`,
        );
      }

      if (neededQuantity > inventoryRow.available) {
        throw new ConflictException(
          `Insufficient stock for product ${productId}`,
        );
      }
    }
    // if all good return the inventory rows for further processing (reservation, etc.)

    return inventoryRows;
  }

  async reserveManyOnCheckout(
    inventoryRows: Inventory[],
    productsMap: Map<string, number>,
    manager: EntityManager,
  ): Promise<Inventory[]> {
    for (const inventoryRow of inventoryRows) {
      const neededQuantity = productsMap.get(inventoryRow.productId);

      if (neededQuantity) {
        inventoryRow.reservedAmount += neededQuantity;
      }
    }

    return manager.save(Inventory, inventoryRows);
  }

  async releaseManyReservations(
    productsMap: Map<string, number>,
    productsIds: string[],
    manager: EntityManager,
  ): Promise<Inventory[]> {
    const inventoryRows = await manager.find(Inventory, {
      where: { productId: In(productsIds) },
      lock: { mode: 'pessimistic_write' },
    });

    for (const inventoryRow of inventoryRows) {
      const reservedQuantity = productsMap.get(inventoryRow.productId);

      if (reservedQuantity) {
        if (inventoryRow.reservedAmount - reservedQuantity < 0) {
          throw new ConflictException(
            `Cannot release more than reserved for product ${inventoryRow.productId}`,
          );
        }
        inventoryRow.reservedAmount -= reservedQuantity;
      }
    }

    return manager.save(inventoryRows);
  }
}
