import { ConflictException, Injectable } from '@nestjs/common';
import { EntityManager } from 'typeorm';
import { Product } from '../products/entities/product.entity';
import { ProductsService } from '../products/products.service';

@Injectable()
export class InventoryService {
  // This service responsible for update the stock number for the products
  // This service will used inside the order service after check the products
  // to update one
  // or update many at once
  // to increment or decrement stock
  // and to integrate with the reservation service to reserve products shortly to prevent race condition

  constructor(private readonly productsService: ProductsService) {}

  async decreaseStockForOrderMany(
    manager: EntityManager,
    products: Array<Pick<Product, 'id' | 'stock'> & { soldQuantity: number }>,
  ) {
    // Take the products from those in the cart and passed from order service after
    // The order service responsible for check the products , find them , make pessimistic lock , and pass
    // Decrement the stock according to the soldQuantity that passed
    const updatedProducts = products.map((product) => ({
      id: product.id,
      stock: product.stock - product.soldQuantity,
    }));

    return manager.getRepository(Product).save(updatedProducts);
  }

  async restoreStockForOrderMany(
    manager: EntityManager,
    products: Array<Pick<Product, 'id' | 'stock'> & { soldQuantity: number }>,
  ) {
    // This method used in case the user decide to refunde the order or order canceled

    const productRepo = manager.getRepository(Product);

    const updatedProducts = products.map((p) => ({
      id: p.id,
      stock: p.stock + p.soldQuantity,
    }));

    return productRepo.save(updatedProducts);
  }

  async increaseStock() {}

  async checkAvailability(productId: string, neededQuantity: number) {
    const pickedProduct = await this.productsService.findOne(productId);

    const isQuantityAvailable = pickedProduct!.stock >= neededQuantity;

    if (!pickedProduct || isQuantityAvailable)
      throw new ConflictException(
        `Product's stock can not serve this needed quantity ${neededQuantity}`,
      );

    return true;
  }

  checkAvailabilityMany() {}
}
