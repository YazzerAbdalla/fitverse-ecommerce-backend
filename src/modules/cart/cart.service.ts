import {
  Injectable,
  InternalServerErrorException,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { ProductsService } from '../products/products.service';
import { CartItem } from './entities/cart-items.entity';
import { Cart } from './entities/cart.entity';
import { AddCartItemProps, RemoveCartItemProps } from './types';

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
    return this.cartRepo.findOneBy({ user: { id: userId } });
  }
  private async createNewCart(userId: string) {
    const newCart = this.cartRepo.create({ user: { id: userId } });
    return this.cartRepo.save(newCart);
  }

  private async checkAndFindUserCart(userId: string) {
    let userCart = await this.findUserCart(userId);
    if (!userCart) {
      userCart = await this.createNewCart(userId);
    }
    return userCart;
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

  async removeCartItem({ userId, productId }: RemoveCartItemProps) {
    // User can't remove item from onther user's cart
    // Can't remove cart item it is not exist already
    const userCart = await this.cartRepo.findOne({
      where: {
        user: { id: userId },
      },
    });

    if (!userCart) {
      throw new NotFoundException('Cart not found.');
    }
  }
  async getUserCar(userId: string) {
    return this.checkAndFindUserCart(userId);
  }
}
