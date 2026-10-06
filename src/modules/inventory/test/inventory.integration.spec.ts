import { DataSource } from 'typeorm';
import { Product } from '../../products/entities/product.entity';
import { Inventory } from '../entities/inventory.entity';
import User from '../../users/entity/user.entity';
import { RefreshToken } from '../../auth/entities/refresh-token.entity';
import { Cart } from '../../cart/entities/cart.entity';
import { CartItem } from '../../cart/entities/cart-items.entity';
import { Order } from '../../order/entities/order.entity';
import { OrderItem } from '../../order/entities/order-items.entity';
import * as dotenv from 'dotenv';

dotenv.config();

describe('Inventory Integration (real PostgreSQL)', () => {
  let dataSource: DataSource;
  let inventoryRepo: any;
  let productRepo: any;

  beforeAll(async () => {
    dataSource = new DataSource({
      type: 'postgres',
      host: process.env.POSTGRES_HOST || '127.0.0.1',
      port: process.env.POSTGRES_PORT
        ? parseInt(process.env.POSTGRES_PORT)
        : 5432,
      username: process.env.POSTGRES_USER || 'postgres',
      password: process.env.POSTGRES_PASSWORD || 'mysecretpassword',
      database: process.env.POSTGRES_DATABASE || 'ecommerce',
      synchronize: true,
      dropSchema: false,
      logging: false,
      entities: [
        User,
        RefreshToken,
        Product,
        Inventory,
        Cart,
        CartItem,
        Order,
        OrderItem,
      ],
    });

    if (!dataSource.isInitialized) {
      await dataSource.initialize();
    }

    inventoryRepo = dataSource.getRepository(Inventory);
    productRepo = dataSource.getRepository(Product);

    // Clean up inventory and products for isolation
    await inventoryRepo.query(`DELETE FROM "inventory"`);
    // Keep products but note stock column should be gone after sync
  });

  afterAll(async () => {
    await inventoryRepo.query(`DELETE FROM "inventory"`).catch(() => {});
    if (dataSource.isInitialized) {
      await dataSource.destroy();
    }
  });

  beforeEach(async () => {
    await inventoryRepo.query(`DELETE FROM "inventory"`);
  });

  it('Product table should have no stock column', async () => {
    const columns: { column_name: string }[] = await dataSource.query(
      `SELECT column_name FROM information_schema.columns WHERE table_name = 'product'`,
    );
    const names = columns.map((c) => c.column_name);
    expect(names).not.toContain('stock');
    // Product entity should not have stock property
    const product = new Product();
    expect((product as any).stock).toBeUndefined();
  });

  it('available is derived stock - reservedAmount', async () => {
    const product = await productRepo.save(
      productRepo.create({
        name: `prod-available-${Date.now()}`,
        slug: `prod-available-${Date.now()}`,
        description: 'test',
        price: 100,
      }),
    );

    const inv = await inventoryRepo.save(
      inventoryRepo.create({
        productId: product.id,
        stock: 10,
        reservedAmount: 3,
      }),
    );

    expect(inv.available).toBe(7);

    const fetched = await inventoryRepo.findOne({ where: { id: inv.id } });
    expect(fetched.available).toBe(7);

    await inventoryRepo.delete({ id: inv.id });
    await productRepo.delete({ id: product.id });
  });

  it('should enforce productId uniqueness (one inventory per product)', async () => {
    const product = await productRepo.save(
      productRepo.create({
        name: `prod-unique-${Date.now()}`,
        slug: `prod-unique-${Date.now()}`,
        description: 'test',
        price: 100,
      }),
    );

    await inventoryRepo.save(
      inventoryRepo.create({
        productId: product.id,
        stock: 5,
        reservedAmount: 0,
      }),
    );

    await expect(
      inventoryRepo.save(
        inventoryRepo.create({
          productId: product.id,
          stock: 5,
          reservedAmount: 0,
        }),
      ),
    ).rejects.toThrow();

    await inventoryRepo.delete({ productId: product.id });
    await productRepo.delete({ id: product.id });
  });

  it('should reject stock < 0', async () => {
    const product = await productRepo.save(
      productRepo.create({
        name: `prod-stockneg-${Date.now()}`,
        slug: `prod-stockneg-${Date.now()}`,
        description: 'test',
        price: 100,
      }),
    );

    await expect(
      inventoryRepo.save(
        inventoryRepo.create({
          productId: product.id,
          stock: -1,
          reservedAmount: 0,
        }),
      ),
    ).rejects.toThrow();

    await productRepo.delete({ id: product.id });
  });

  it('should reject reservedAmount < 0', async () => {
    const product = await productRepo.save(
      productRepo.create({
        name: `prod-resneg-${Date.now()}`,
        slug: `prod-resneg-${Date.now()}`,
        description: 'test',
        price: 100,
      }),
    );

    await expect(
      inventoryRepo.save(
        inventoryRepo.create({
          productId: product.id,
          stock: 10,
          reservedAmount: -1,
        }),
      ),
    ).rejects.toThrow();

    await productRepo.delete({ id: product.id });
  });

  it('should reject reservedAmount > stock', async () => {
    const product = await productRepo.save(
      productRepo.create({
        name: `prod-resgt-${Date.now()}`,
        slug: `prod-resgt-${Date.now()}`,
        description: 'test',
        price: 100,
      }),
    );

    await expect(
      inventoryRepo.save(
        inventoryRepo.create({
          productId: product.id,
          stock: 3,
          reservedAmount: 5,
        }),
      ),
    ).rejects.toThrow();

    await productRepo.delete({ id: product.id });
  });

  it('should enforce stock >=0 after update', async () => {
    const product = await productRepo.save(
      productRepo.create({
        name: `prod-update-${Date.now()}`,
        slug: `prod-update-${Date.now()}`,
        description: 'test',
        price: 100,
      }),
    );

    const inv = await inventoryRepo.save(
      inventoryRepo.create({
        productId: product.id,
        stock: 5,
        reservedAmount: 0,
      }),
    );

    inv.stock = -5;
    await expect(inventoryRepo.save(inv)).rejects.toThrow();

    await inventoryRepo.delete({ id: inv.id });
    await productRepo.delete({ id: product.id });
  });
});
