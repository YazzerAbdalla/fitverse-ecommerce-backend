import {
  ConflictException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
  forwardRef,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { EntityManager, Repository } from 'typeorm';
import { Inventory } from './entities/inventory.entity';
import { ProductsService } from '../products/products.service';

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

  async checkAvailability(
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

  // Deprecated compatibility alias
  checkAvailabilityMany(): never {
    throw new ConflictException('Not implemented');
  }

  increaseStockLegacy(): never {
    throw new ConflictException('Not implemented');
  }
}
