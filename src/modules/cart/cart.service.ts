import {
  BadRequestException,
  ConflictException,
  Injectable,
  InternalServerErrorException,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { EntityManager, In, Repository } from 'typeorm';

import { ProductsService } from '../products/products.service';
import { InventoryService } from '../inventory/inventory.service';
import { CartItem } from './entities/cart-items.entity';
import { Cart } from './entities/cart.entity';
import {
  AddCartItemProps,
  RemoveCartItemProps,
  UpdateCartItemQuantityProps,
} from './types';

@Injectable()
export class CartService {
  constructor(
    @InjectRepository(Cart)
    private readonly cartRepository: Repository<Cart>,

    @InjectRepository(CartItem)
    private readonly cartItemRepository: Repository<CartItem>,

    private readonly productsService: ProductsService,

    private readonly inventoryService: InventoryService,

    private readonly logger: Logger,
  ) {}

  /**
   * Find the user's cart.
   */
  private async findUserCart(userId: string) {
    return this.cartRepository.findOne({
      where: {
        user: { id: userId },
      },
      relations: {
        cart_items: true,
      },
    });
  }

  /**
   * Create a new cart for the user.
   */
  private async createUserCart(userId: string) {
    this.logger.debug(`Creating cart for user ${userId}`);

    const cart = this.cartRepository.create({
      user: { id: userId },
    });

    const savedCart = await this.cartRepository.save(cart);

    this.logger.log(`Cart ${savedCart.id} created for user ${userId}`);

    return savedCart;
  }

  /**
   * Find the user's existing cart or create one if it doesn't exist.
   */
  private async findOrCreateUserCart(userId: string) {
    const existingCart = await this.findUserCart(userId);

    if (existingCart) {
      return existingCart;
    }

    return this.createUserCart(userId);
  }

  /**
   * Add a product to the user's cart.
   */
  async addCartItem({ userId, productId, quantity = 1 }: AddCartItemProps) {
    this.logger.log(`Adding product ${productId} to cart for user ${userId}`);

    /**
     * Validate the quantity
     */

    if (!Number.isInteger(quantity) || quantity <= 0) {
      this.logger.warn(`Invalid cart quantity ${quantity} for user ${userId}`);

      throw new BadRequestException('Quantity must be a positive integer.');
    }

    const product = await this.productsService.findOne(productId);

    if (!product) {
      this.logger.warn(
        `Product ${productId} not found while adding to cart for user ${userId}`,
      );

      throw new NotFoundException('Product not found.');
    }

    const cart = await this.findOrCreateUserCart(userId);

    /**
     * Check if the product already exist in the db
     */
    const existingCartItem = await this.cartItemRepository.findOne({
      where: {
        product: { id: productId },
        cart: { id: cart.id },
      },
    });

    if (existingCartItem) {
      const newQuantity = existingCartItem.quantity + quantity;

      /**
       * Validate current stock availability via inventory.
       */
      const inventory = await this.inventoryService.getInventory(productId);
      if (newQuantity > inventory.available) {
        this.logger.warn(
          `Insufficient stock for product ${productId}. ` +
            `Requested quantity: ${newQuantity}, available: ${inventory.available}`,
        );

        throw new ConflictException(
          `There is not enough stock for quantity ${newQuantity}.`,
        );
      }

      existingCartItem.quantity = newQuantity;

      const updatedCartItem =
        await this.cartItemRepository.save(existingCartItem);

      this.logger.log(
        `Cart item ${updatedCartItem.id} quantity increased to ${newQuantity}`,
      );

      const cartItemIndex = cart.cart_items.findIndex(
        (ci) => ci.id === updatedCartItem.id,
      );

      cart.cart_items[cartItemIndex].quantity = newQuantity;

      return cart;
    }

    /**
     * Validate current stock availability via inventory.
     */
    const inventory = await this.inventoryService.getInventory(productId);
    if (quantity > inventory.available) {
      this.logger.warn(
        `Insufficient stock for product ${productId}. ` +
          `Requested quantity: ${quantity}, available: ${inventory.available}`,
      );

      throw new ConflictException(
        `There is not enough stock for quantity ${quantity}.`,
      );
    }

    const savedCartItem = await this.cartItemRepository.save({
      cart,
      product,
      quantity,
    });

    const responseCartItem = {
      ...savedCartItem,
      cart: {},
    };

    cart.cart_items.push(responseCartItem as CartItem);

    this.logger.log(`Cart item ${savedCartItem.id} added to cart ${cart.id}`);

    return cart;
  }

  /**
   * Remove a cart item belonging to the authenticated user's cart.
   */
  async removeCartItem({ userId, cartItemId }: RemoveCartItemProps) {
    this.logger.log(`Removing cart item ${cartItemId} for user ${userId}`);

    const cart = await this.findUserCart(userId);

    if (!cart) {
      this.logger.warn(`Cart not found for user ${userId}`);

      throw new NotFoundException('Cart not found.');
    }

    const deleteResult = await this.cartItemRepository.delete({
      id: cartItemId,
      cart: { id: cart.id },
    });

    if (!deleteResult.affected) {
      this.logger.warn(`Cart item ${cartItemId} not found in cart ${cart.id}`);

      throw new NotFoundException('Cart item not found in your cart.');
    }

    cart.cart_items = cart.cart_items.filter(({ id }) => id !== cartItemId);

    this.logger.log(`Cart item ${cartItemId} removed from cart ${cart.id}`);

    return cart;
  }

  /**
   * Find a specific cart item belonging to the user.
   */
  private async findUserCartItem(userId: string, productId: string) {
    const cart = await this.findOrCreateUserCart(userId);

    const cartItem = await this.cartItemRepository.findOne({
      where: {
        cart: { id: cart.id },
        product: { id: productId },
      },
      relations: {
        product: true,
      },
    });

    if (!cartItem) {
      this.logger.warn(`Product ${productId} is not in cart ${cart.id}`);

      throw new NotFoundException('Product is not in your cart.');
    }

    return {
      cart,
      cartItem,
    };
  }

  /**
   * Increase the quantity of a cart item.
   */
  async increaseCartItemQuantity({
    quantity = 1,
    productId,
    userId,
  }: UpdateCartItemQuantityProps) {
    this.logger.log(
      `Increasing quantity of product ${productId} ` +
        `by ${quantity} for user ${userId}`,
    );

    if (!Number.isInteger(quantity) || quantity <= 0) {
      throw new BadRequestException('Quantity must be a positive integer.');
    }

    const { cartItem } = await this.findUserCartItem(userId, productId);

    const newQuantity = cartItem.quantity + quantity;

    const inventory = await this.inventoryService.getInventory(productId);
    if (newQuantity > inventory.available) {
      this.logger.warn(
        `Insufficient stock for product ${productId}. ` +
          `Requested: ${newQuantity}, available: ${inventory.available}`,
      );

      throw new ConflictException(
        `There is not enough stock for quantity ${newQuantity}.`,
      );
    }

    cartItem.quantity = newQuantity;

    const updatedCartItem = await this.cartItemRepository.save(cartItem);

    this.logger.log(
      `Cart item ${updatedCartItem.id} quantity updated to ${newQuantity}`,
    );

    return updatedCartItem;
  }

  /**
   * Decrease the quantity of a cart item.
   */
  async decreaseCartItemQuantity({
    userId,
    productId,
    quantity = 1,
  }: UpdateCartItemQuantityProps) {
    this.logger.log(
      `Decreasing quantity of product ${productId} ` +
        `by ${quantity} for user ${userId}`,
    );

    if (!Number.isInteger(quantity) || quantity <= 0) {
      throw new BadRequestException('Quantity must be a positive integer.');
    }

    const { cartItem } = await this.findUserCartItem(userId, productId);

    const newQuantity = cartItem.quantity - quantity;

    if (newQuantity < 1) {
      this.logger.warn(
        `Invalid quantity ${newQuantity} for cart item ${cartItem.id}`,
      );

      throw new BadRequestException(
        'Cart item quantity cannot be less than 1.',
      );
    }

    cartItem.quantity = newQuantity;

    const updatedCartItem = await this.cartItemRepository.save(cartItem);

    this.logger.log(
      `Cart item ${updatedCartItem.id} quantity updated to ${newQuantity}`,
    );

    return updatedCartItem;
  }

  /**
   * Clear all items from the user's cart.
   *
   * Cart items are deleted asynchronously so the request
   * does not wait for the DELETE query to complete.
   */
  async clearCart(userId: string) {
    this.logger.log(`Clearing cart for user ${userId}`);

    const cart = await this.findUserCart(userId);

    if (!cart) {
      this.logger.warn(`Cart not found for user ${userId}`);

      throw new NotFoundException('Cart not found.');
    }

    const cartItems = cart.cart_items;

    if (cartItems.length === 0) {
      this.logger.debug(`Cart ${cart.id} is already empty`);

      return cart;
    }

    this.logger.debug(
      `Scheduling deletion of ${cartItems.length} cart items ` +
        `from cart ${cart.id}`,
    );

    void this.deleteCartItemsInBackground(cartItems);

    cart.cart_items = [];

    this.logger.log(`Cart ${cart.id} cleared for user ${userId}`);

    return cart;
  }

  /**
   * Delete cart items without blocking the request.
   *
   * Note: this is fire-and-forget work, not a durable background job.
   */
  private async deleteCartItemsInBackground(cartItems: CartItem[]) {
    const cartItemsIds = cartItems.map(({ id }) => id);

    return this.cartItemRepository
      .delete({ id: In(cartItemsIds) })
      .then((result) => {
        if (!result.affected || result.affected === 0)
          throw new InternalServerErrorException();
        this.logger.debug(
          `Background cart-item deletion completed. ` +
            `Deleted: ${result.affected ?? 0}`,
        );
      })
      .catch((error) => {
        this.logger.error(
          'Background cart-item deletion failed',
          error instanceof Error ? error.stack : String(error),
        );
      });
  }

  /**
   * Clears cart items atomically inside caller's transaction.
   * @param manager - EntityManager of enclosing transaction.
   * @param userId - Owner of cart.
   * @returns void
   * @throws NotFoundException if cart missing.
   */
  async clearCartForCheckout(
    manager: EntityManager,
    userId: string,
  ): Promise<void> {
    // Load cart via manager to stay in transaction
    const cart = await manager.findOne(Cart, {
      where: { user: { id: userId } },
      relations: { cart_items: true },
    });
    if (!cart) {
      this.logger.warn(
        `Cart not found for user ${userId} during checkout clear`,
      );
      throw new NotFoundException('Cart not found.');
    }
    if (cart.cart_items.length === 0) {
      this.logger.debug(`Cart ${cart.id} already empty for checkout clear`);
      return;
    }
    // Delete via manager to keep atomic with checkout transaction
    await manager.delete(CartItem, { cart: { id: cart.id } } as any);
    this.logger.log(
      `Cart ${cart.id} cleared for checkout user ${userId} (${cart.cart_items.length} items)`,
    );
  }

  /**
   * Get the user's cart.
   */
  async getUserCart(userId: string) {
    this.logger.debug(`Fetching cart for user ${userId}`);

    return this.findOrCreateUserCart(userId);
  }
}
