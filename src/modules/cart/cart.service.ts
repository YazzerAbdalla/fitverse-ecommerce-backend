import {
  BadRequestException,
  ConflictException,
  Injectable,
  InternalServerErrorException,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { ProductsService } from '../products/products.service';
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
    private readonly cartRepo: Repository<Cart>,
    @InjectRepository(CartItem)
    private readonly cartItemRepo: Repository<CartItem>,
    private readonly productService: ProductsService,
  ) {}
  private async findUserCart(userId: string) {
    return this.cartRepo.findOne({
      where: { user: { id: userId } },
      relations: { cart_items: true },
    });
  }
  private async createNewCart(userId: string) {
    const newCart = this.cartRepo.create({ user: { id: userId } });
    return this.cartRepo.save(newCart);
  }

  private async checkAndFindUserCart(userId: string) {
    const userCart = await this.findUserCart(userId);
    return userCart ? userCart : this.createNewCart(userId);
  }

  async addCartItem({ userId, productId, quantity = 1 }: AddCartItemProps) {
    const userCart = await this.checkAndFindUserCart(userId);
    const pickedProduct = await this.productService.findOne(productId);
    const isItemAlreadyExist = await this.cartItemRepo.findOne({
      where: { product: { id: productId }, cart: { id: userCart.id } },
    });
    if (!pickedProduct || !userCart) throw new InternalServerErrorException();

    if (isItemAlreadyExist) {
      isItemAlreadyExist.quantity += 1;
      userCart.cart_items.push(isItemAlreadyExist);
      return this.cartRepo.save(userCart);
    }

    const newCartItem = await this.cartItemRepo.save({
      cart: userCart,
      product: pickedProduct,
      quantity,
    });

    userCart.cart_items.push(newCartItem);

    return this.cartRepo.save(userCart);
  }

  async removeCartItem({ userId, cartItemId }: RemoveCartItemProps) {
    // User can't remove item from onther user's cart
    // Can't remove cart item it is not exist already
    const userCart = await this.cartRepo.findOne({
      where: {
        user: { id: userId },
      },
      relations: { cart_items: true },
    });

    if (!userCart) {
      throw new NotFoundException('Cart not found.');
    }

    const cartItem = await this.cartItemRepo.delete({
      id: cartItemId,
      cart: { id: userCart.id },
    });

    if (!cartItem.affected || cartItem.affected === 0) {
      throw new NotFoundException(
        `You are trying to remove not available cart item.'`,
      );
    }

    const filteredCartItems = userCart.cart_items.filter(
      ({ id }) => id !== cartItemId,
    );

    userCart.cart_items = filteredCartItems;

    return userCart;
  }

  async validateCartItemUpdate({
    userId,
    productId,
  }: UpdateCartItemQuantityProps) {
    // Validate user's cart , and this product there already
    // Validate the needed quantity exist or not,
    // Update the quanity
    const userCart = await this.checkAndFindUserCart(userId);
    const cartItem = await this.cartItemRepo.findOne({
      where: { cart: { id: userCart.id }, product: { id: productId } },
      relations: { product: true },
    });

    if (!cartItem) throw new NotFoundException('Product is not in your cart.');

    return { userCart, cartItem };
  }

  async increaseCartItemQuantity({
    quantity = 1,
    productId,
    userId,
  }: UpdateCartItemQuantityProps) {
    // Validate user's cart , and this product is there already
    // Validate the needed quantity exist or not,
    // Update the quanity
    const { cartItem } = await this.validateCartItemUpdate({
      userId,
      productId,
    });

    if (!Number.isInteger(quantity) || quantity <= 0) {
      throw new BadRequestException('Quantity must be a positive integer.');
    }

    const newQuantity = cartItem.quantity + quantity;
    const hasEnoughStock = cartItem.product.stock >= newQuantity;

    if (!hasEnoughStock)
      throw new ConflictException(
        `There is no enough stock for this new quantity ${newQuantity}`,
      );

    cartItem.quantity = newQuantity;

    return await this.cartItemRepo.save(cartItem);
  }

  async decreaseCartItemQuantity({
    userId,
    productId,
    quantity = 1,
  }: UpdateCartItemQuantityProps) {
    if (!Number.isInteger(quantity) || quantity <= 0) {
      throw new BadRequestException('Quantity must be a positive integer.');
    }
    const { cartItem } = await this.validateCartItemUpdate({
      userId,
      productId,
    });

    const newQuantity = cartItem.quantity - quantity;
    if (newQuantity < 1)
      throw new BadRequestException(
        'Cart item quantity cannot be less than 1.',
      );

    cartItem.quantity = newQuantity;

    return this.cartItemRepo.save(cartItem);
  }

  async getUserCar(userId: string) {
    return this.checkAndFindUserCart(userId);
  }
}
