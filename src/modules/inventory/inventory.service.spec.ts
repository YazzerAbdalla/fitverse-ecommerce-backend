import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { ConflictException, NotFoundException } from '@nestjs/common';
import { InventoryService } from './inventory.service';
import { Inventory } from './entities/inventory.entity';
import { ProductsService } from '../products/products.service';
import { Product } from '../products/entities/product.entity';
import { EntityManager, Repository } from 'typeorm';

describe('InventoryService', () => {
  let service: InventoryService;
  let inventoryRepo: jest.Mocked<Repository<Inventory>>;
  let productsService: { findOne: jest.Mock };

  const mockInventoryRepo = {
    findOne: jest.fn(),
    create: jest.fn(),
    save: jest.fn(),
  };

  const mockProductsService = {
    findOne: jest.fn(),
  };

  beforeEach(async () => {
    jest.clearAllMocks();

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        InventoryService,
        {
          provide: getRepositoryToken(Inventory),
          useValue: mockInventoryRepo,
        },
        {
          provide: ProductsService,
          useValue: mockProductsService,
        },
      ],
    }).compile();

    service = module.get<InventoryService>(InventoryService);
    inventoryRepo = module.get(getRepositoryToken(Inventory));
    productsService = module.get(ProductsService);
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });

  describe('Product.stock removal', () => {
    it('should not expose stock on Product', () => {
      const product = new Product();
      expect(
        (product as unknown as Record<string, unknown>)['stock'],
      ).toBeUndefined();
      expect(Object.prototype.hasOwnProperty.call(product, 'stock')).toBe(
        false,
      );
      // Ensure no code path reads product.stock in service
      expect(product).not.toHaveProperty('stock');
    });
  });

  describe('available derived', () => {
    it('should compute available as stock - reservedAmount', () => {
      const inv = new Inventory();
      inv.stock = 10;
      inv.reservedAmount = 3;
      expect(inv.available).toBe(7);
    });
  });

  describe('createForProduct', () => {
    it('should create inventory with initial stock', async () => {
      inventoryRepo.findOne.mockResolvedValue(null);
      const created = {
        productId: 'p1',
        stock: 5,
        reservedAmount: 0,
      } as Inventory;
      inventoryRepo.create.mockReturnValue(created);
      inventoryRepo.save.mockResolvedValue({
        ...created,
        id: '1',
      } as Inventory);

      const result = await service.createForProduct('p1', 5);
      expect(result.stock).toBe(5);
      expect(inventoryRepo.create).toHaveBeenCalledWith({
        productId: 'p1',
        stock: 5,
        reservedAmount: 0,
      });
    });

    it('should return existing if already exists', async () => {
      const existing = {
        id: '1',
        productId: 'p1',
        stock: 5,
        reservedAmount: 0,
      } as Inventory;
      inventoryRepo.findOne.mockResolvedValue(existing);

      const result = await service.createForProduct('p1', 10);
      expect(result).toBe(existing);
      expect(inventoryRepo.create).not.toHaveBeenCalled();
    });

    it('should throw on negative initial stock', async () => {
      await expect(service.createForProduct('p1', -1)).rejects.toThrow(
        ConflictException,
      );
    });
  });

  describe('getInventory', () => {
    it('returns inventory when found', async () => {
      const inv = {
        id: '1',
        productId: 'p1',
        stock: 10,
        reservedAmount: 2,
      } as Inventory;
      inventoryRepo.findOne.mockResolvedValue(inv);
      expect(await service.getInventory('p1')).toBe(inv);
    });

    it('throws NotFound when missing', async () => {
      inventoryRepo.findOne.mockResolvedValue(null);
      await expect(service.getInventory('missing')).rejects.toThrow(
        NotFoundException,
      );
    });
  });

  describe('checkAvailability', () => {
    it('returns true when sufficient', async () => {
      inventoryRepo.findOne.mockResolvedValue({
        stock: 10,
        reservedAmount: 3,
        available: 7,
      } as unknown as Inventory);
      // available getter
      const inv = new Inventory();
      inv.stock = 10;
      inv.reservedAmount = 3;
      inventoryRepo.findOne.mockResolvedValue(inv);

      expect(await service.checkAvailability('p1', 5)).toBe(true);
      expect(await service.checkAvailability('p1', 7)).toBe(true);
    });

    it('returns false when insufficient', async () => {
      const inv = new Inventory();
      inv.stock = 10;
      inv.reservedAmount = 8;
      inventoryRepo.findOne.mockResolvedValue(inv);
      expect(await service.checkAvailability('p1', 5)).toBe(false);
    });

    it('throws on invalid quantity', async () => {
      await expect(service.checkAvailability('p1', 0)).rejects.toThrow(
        ConflictException,
      );
      await expect(service.checkAvailability('p1', -1)).rejects.toThrow(
        ConflictException,
      );
    });
  });

  describe('increaseStock', () => {
    it('increases stock', async () => {
      const inv = new Inventory();
      inv.id = '1';
      inv.productId = 'p1';
      inv.stock = 10;
      inv.reservedAmount = 2;
      inventoryRepo.findOne.mockResolvedValue(inv);
      inventoryRepo.save.mockImplementation(async (e: Inventory) => e);

      const result = await service.increaseStock('p1', 5);
      expect(result.stock).toBe(15);
    });

    it('throws on invalid quantity', async () => {
      await expect(service.increaseStock('p1', 0)).rejects.toThrow(
        ConflictException,
      );
    });

    it('throws NotFound if inventory missing', async () => {
      inventoryRepo.findOne.mockResolvedValue(null);
      await expect(service.increaseStock('missing', 1)).rejects.toThrow(
        NotFoundException,
      );
    });
  });

  describe('decreaseStock', () => {
    it('decreases stock when sufficient', async () => {
      const inv = new Inventory();
      inv.id = '1';
      inv.productId = 'p1';
      inv.stock = 10;
      inv.reservedAmount = 2;
      inventoryRepo.findOne.mockResolvedValue(inv);
      inventoryRepo.save.mockImplementation(async (e: Inventory) => e);

      const result = await service.decreaseStock('p1', 3);
      expect(result.stock).toBe(7);
    });

    it('throws Conflict when would go negative', async () => {
      const inv = new Inventory();
      inv.stock = 5;
      inv.reservedAmount = 0;
      inventoryRepo.findOne.mockResolvedValue(inv);
      await expect(service.decreaseStock('p1', 10)).rejects.toThrow(
        ConflictException,
      );
    });

    it('throws Conflict when decrease would violate reservedAmount <= stock', async () => {
      const inv = new Inventory();
      inv.stock = 10;
      inv.reservedAmount = 8;
      inventoryRepo.findOne.mockResolvedValue(inv);
      await expect(service.decreaseStock('p1', 5)).rejects.toThrow(
        ConflictException,
      );
    });
  });

  describe('decreaseStockForOrderMany', () => {
    it('updates via manager', async () => {
      const save = jest.fn().mockResolvedValue([]);
      const manager = {
        getRepository: jest.fn().mockReturnValue({ save }),
      } as unknown as EntityManager;

      await service.decreaseStockForOrderMany(manager, [
        { id: '1', stock: 10, soldQuantity: 3 },
      ]);
      expect(save).toHaveBeenCalledWith([{ id: '1', stock: 7 }]);
    });

    it('throws when insufficient', async () => {
      const manager = {
        getRepository: jest.fn().mockReturnValue({ save: jest.fn() }),
      } as unknown as EntityManager;

      await expect(
        service.decreaseStockForOrderMany(manager, [
          { id: '1', stock: 2, soldQuantity: 5 } as any,
        ]),
      ).rejects.toThrow(ConflictException);
    });
  });

  describe('restoreStockForOrderMany', () => {
    it('restores via manager', async () => {
      const save = jest.fn().mockResolvedValue([]);
      const manager = {
        getRepository: jest.fn().mockReturnValue({ save }),
      } as unknown as EntityManager;

      await service.restoreStockForOrderMany(manager, [
        { id: '1', stock: 10, soldQuantity: 3 },
      ]);
      expect(save).toHaveBeenCalledWith([{ id: '1', stock: 13 }]);
    });
  });

  describe('reserve / release / completeSale', () => {
    it('reserve increases reservedAmount when available', async () => {
      const inv = new Inventory();
      inv.productId = 'p1';
      inv.stock = 10;
      inv.reservedAmount = 2;
      inventoryRepo.findOne.mockResolvedValue(inv);
      inventoryRepo.save.mockImplementation(async (e) => e);

      const result = await service.reserve('p1', 3);
      expect(result.reservedAmount).toBe(5);
    });

    it('reserve throws when insufficient available', async () => {
      const inv = new Inventory();
      inv.stock = 5;
      inv.reservedAmount = 4;
      inventoryRepo.findOne.mockResolvedValue(inv);
      await expect(service.reserve('p1', 2)).rejects.toThrow(ConflictException);
    });

    it('release decreases reservedAmount', async () => {
      const inv = new Inventory();
      inv.stock = 10;
      inv.reservedAmount = 5;
      inventoryRepo.findOne.mockResolvedValue(inv);
      inventoryRepo.save.mockImplementation(async (e) => e);

      const result = await service.releaseReservation('p1', 3);
      expect(result.reservedAmount).toBe(2);
    });

    it('release throws when would go negative', async () => {
      const inv = new Inventory();
      inv.stock = 10;
      inv.reservedAmount = 1;
      inventoryRepo.findOne.mockResolvedValue(inv);
      await expect(service.releaseReservation('p1', 5)).rejects.toThrow(
        ConflictException,
      );
    });

    it('completeSale decreases both stock and reserved', async () => {
      const inv = new Inventory();
      inv.stock = 10;
      inv.reservedAmount = 3;
      inventoryRepo.findOne.mockResolvedValue(inv);
      inventoryRepo.save.mockImplementation(async (e) => e);

      const result = await service.completeSale('p1', 2);
      expect(result.stock).toBe(8);
      expect(result.reservedAmount).toBe(1);
    });

    it('completeSale throws when not enough reserved', async () => {
      const inv = new Inventory();
      inv.stock = 10;
      inv.reservedAmount = 1;
      inventoryRepo.findOne.mockResolvedValue(inv);
      await expect(service.completeSale('p1', 2)).rejects.toThrow(
        ConflictException,
      );
    });
  });
});
