import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
  Post,
  UseGuards,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOperation,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';
import { Auth } from '../auth/decorators/auth.decorator';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { UserRoles } from '../users/enum/roles';
import { CartService } from './cart.service';
import { RateLimitGuard } from '../auth/guards/rate-limit.guard';
import { AddCartItemDto } from './dto/add-cart-item.dto';
import { UpdateCartItemQuantityDto } from './dto/update-cart-item-quantity.dto';
import { CartItem } from './entities/cart-items.entity';
import { Cart } from './entities/cart.entity';

@Controller('cart')
@ApiTags('Cart')
@Auth(UserRoles.User)
@ApiBearerAuth('JWT-auth')
export class CartController {
  constructor(private readonly cartService: CartService) {}

  @Get()
  @ApiOperation({ summary: "Get the authenticated user's cart." })
  @ApiResponse({
    status: 200,
    description: "The user's cart returned successfully.",
    type: Cart,
  })
  getCart(@CurrentUser('sub') userId: string): Promise<Cart> {
    return this.cartService.getUserCart(userId);
  }

  @Post()
  @UseGuards(RateLimitGuard)
  @ApiOperation({ summary: "Add a product to the authenticated user's cart." })
  @ApiResponse({
    status: 201,
    description: 'The cart item added successfully.',
    type: CartItem,
  })
  @ApiResponse({
    status: 400,
    description: 'Invalid quantity provided.',
  })
  @ApiResponse({
    status: 404,
    description: 'Product not found.',
  })
  @ApiResponse({
    status: 409,
    description: 'Insufficient stock for the requested quantity.',
  })
  @ApiResponse({
    status: 429,
    description: 'Too Many Requests — Retry-After: 3600',
  })
  addItem(
    @CurrentUser('sub') userId: string,
    @Body() addCartItemDto: AddCartItemDto,
  ): Promise<Cart> {
    return this.cartService.addCartItem({
      userId,
      productId: addCartItemDto.productId,
      quantity: addCartItemDto.quantity,
    });
  }

  @Patch('increase')
  @UseGuards(RateLimitGuard)
  @ApiOperation({
    summary: 'Increase the quantity of a product in the cart.',
  })
  @ApiResponse({
    status: 200,
    description: 'The cart item quantity increased successfully.',
    type: CartItem,
  })
  @ApiResponse({
    status: 400,
    description: 'Invalid quantity provided.',
  })
  @ApiResponse({
    status: 404,
    description: 'Product is not in the cart.',
  })
  @ApiResponse({
    status: 409,
    description: 'Insufficient stock for the requested quantity.',
  })
  @ApiResponse({
    status: 429,
    description: 'Too Many Requests — Retry-After: 3600',
  })
  increaseItem(
    @CurrentUser('sub') userId: string,
    @Body() updateCartItemQuantityDto: UpdateCartItemQuantityDto,
  ): Promise<CartItem> {
    return this.cartService.increaseCartItemQuantity({
      userId,
      productId: updateCartItemQuantityDto.productId,
      quantity: updateCartItemQuantityDto.quantity,
    });
  }

  @Patch('decrease')
  @UseGuards(RateLimitGuard)
  @ApiOperation({
    summary: 'Decrease the quantity of a product in the cart.',
  })
  @ApiResponse({
    status: 200,
    description: 'The cart item quantity decreased successfully.',
    type: CartItem,
  })
  @ApiResponse({
    status: 400,
    description: 'Invalid quantity provided or quantity cannot be less than 1.',
  })
  @ApiResponse({
    status: 404,
    description: 'Product is not in the cart.',
  })
  @ApiResponse({
    status: 429,
    description: 'Too Many Requests — Retry-After: 3600',
  })
  decreaseItem(
    @CurrentUser('sub') userId: string,
    @Body() updateCartItemQuantityDto: UpdateCartItemQuantityDto,
  ): Promise<CartItem> {
    return this.cartService.decreaseCartItemQuantity({
      userId,
      productId: updateCartItemQuantityDto.productId,
      quantity: updateCartItemQuantityDto.quantity,
    });
  }

  @Delete(':cartItemId')
  @UseGuards(RateLimitGuard)
  @ApiOperation({ summary: 'Remove an item from the cart.' })
  @ApiResponse({
    status: 200,
    description: 'The cart item removed successfully.',
    type: Cart,
  })
  @ApiResponse({
    status: 404,
    description: 'Cart or cart item not found.',
  })
  @ApiResponse({
    status: 429,
    description: 'Too Many Requests — Retry-After: 3600',
  })
  removeItem(
    @CurrentUser('sub') userId: string,
    @Param('cartItemId') cartItemId: string,
  ): Promise<Cart> {
    return this.cartService.removeCartItem({ userId, cartItemId });
  }

  @Delete()
  @UseGuards(RateLimitGuard)
  @ApiOperation({ summary: 'Clear all items from the cart.' })
  @ApiResponse({
    status: 200,
    description: 'The cart cleared successfully.',
    type: Cart,
  })
  @ApiResponse({
    status: 404,
    description: 'Cart not found.',
  })
  @ApiResponse({
    status: 429,
    description: 'Too Many Requests — Retry-After: 3600',
  })
  clearCart(@CurrentUser('sub') userId: string): Promise<Cart> {
    return this.cartService.clearCart(userId);
  }
}
