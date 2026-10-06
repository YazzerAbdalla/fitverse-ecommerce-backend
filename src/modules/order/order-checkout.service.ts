import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
  Optional,
} from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource, In } from 'typeorm';
import { Cart } from '../cart/entities/cart.entity';
import { CartItem } from '../cart/entities/cart-items.entity';
import { Inventory } from '../inventory/entities/inventory.entity';
import { Product } from '../products/entities/product.entity';
import { Order } from './entities/order.entity';
import { OrderItem } from './entities/order-items.entity';
import { OrderStatus } from './order-status.enum';
import { ReservationService } from '../reservation/reservation.service';
import { Reservation } from '../reservation/entities/reservation.entity';
import { CartService } from '../cart/cart.service';
import { OutboxService } from '../outbox/outbox.service';
import { randomUUID } from 'crypto';
import { mapInventoryCheckViolation } from './order-transitions';

/** Currency recorded on checkout outbox events (single-currency demo). */
export const ORDER_CURRENCY = 'usd';

/**
 * This service is responsible for checkout domain.
 * It handles atomic checkout creating Order + OrderItems + Reservation + Inventory reservation.
 */
@Injectable()
export class OrderCheckoutService {
  private readonly logger = new Logger(OrderCheckoutService.name);

  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    private readonly reservationService: ReservationService,
    private readonly cartService: CartService,
    @Optional()
    @Inject(OutboxService)
    private readonly outboxService?: OutboxService,
  ) {}

  /**
   * Performs cart-only checkout for user, owning the transaction boundary.
   * @param userId - Authenticated user id from JWT sub.
   * @param correlationId - Optional correlationId for outbox tracing (generated if missing).
   * @returns Created order and reservation.
   * @throws BadRequestException if cart empty.
   * @throws NotFoundException if product/inventory missing.
   * @throws ConflictException if insufficient available.
   */
  async checkoutUserCart(
    userId: string,
    correlationId?: string,
  ): Promise<{ order: Order; reservation: Reservation; items: OrderItem[] }> {
    return this.dataSource.transaction(async (manager) => {
      // 1. Load cart with items + product via manager (stay in transaction)
      const cart = await manager.findOne(Cart, {
        where: { user: { id: userId } },
        relations: { cart_items: { product: true } },
      });

      if (!cart || !cart.cart_items || cart.cart_items.length === 0) {
        throw new BadRequestException('Cart is empty');
      }

      // Validate lines and collect productIds; a line whose product row is
      // gone (deleted product) is a 404, never a TypeError 500.
      const seenProductIds = new Set<string>();
      for (const cartItem of cart.cart_items) {
        if (!cartItem.product) {
          throw new NotFoundException(
            'Product for a cart line no longer exists',
          );
        }
        if (!Number.isInteger(cartItem.quantity) || cartItem.quantity <= 0) {
          throw new BadRequestException('Quantity must be a positive integer');
        }
        if (seenProductIds.has(cartItem.product.id)) {
          throw new BadRequestException(
            `Duplicate product in cart: ${cartItem.product.id}`,
          );
        }
        seenProductIds.add(cartItem.product.id);
      }

      const productIds = cart.cart_items.map((cartItem) => cartItem.product.id);

      // 2. Snapshot product prices via manager (no lock needed, read-committed)
      const products = await manager.find(Product, {
        where: { id: In(productIds) },
      });
      if (products.length !== productIds.length) {
        const found = new Set(products.map((p) => p.id));
        const missing = productIds.find((id) => !found.has(id))!;
        throw new NotFoundException(`Product ${missing} not found`);
      }
      const productMap = new Map(
        products.map((productRow) => [productRow.id, productRow]),
      );

      // 3. Map productId -> inventoryId (via Inventory lookup). Missing rows
      // surface as 404 while building checkout items below.
      const inventoriesByProduct = await manager.find(Inventory, {
        where: { productId: In(productIds) },
      });
      const invByProductId = new Map(
        inventoriesByProduct.map((inventoryRow) => [
          inventoryRow.productId,
          inventoryRow,
        ]),
      );

      // Build items with inventoryId and price snapshot. Prices are read
      // without locks by design: the order snapshots the price observed at
      // this read (historical-price isolation), it does not track later edits.
      const checkoutItems = cart.cart_items.map((cartItem) => {
        const productRow = productMap.get(cartItem.product.id);
        if (!productRow) {
          throw new NotFoundException(
            `Product ${cartItem.product.id} not found`,
          );
        }
        const inventoryRow = invByProductId.get(cartItem.product.id);
        if (!inventoryRow) {
          throw new NotFoundException(
            `Inventory for product ${cartItem.product.id} not found`,
          );
        }
        // Client prices are never trusted: the snapshot comes from the
        // product row and must be a non-negative integer.
        if (productRow.price == null || productRow.price < 0) {
          throw new BadRequestException(
            `Invalid product price for ${productRow.id}`,
          );
        }
        return {
          productId: cartItem.product.id,
          inventoryId: inventoryRow.id,
          quantity: cartItem.quantity,
          unit_price: productRow.price,
          productName: productRow.name,
        };
      });

      // 4. Deterministic lock ordering to prevent deadlock when carts have opposite item order
      const sortedInventoryIds = [
        ...new Set(
          checkoutItems.map((checkoutItem) => checkoutItem.inventoryId),
        ),
      ].sort();

      // 5. Lock inventories FOR UPDATE
      const lockedInventories = await manager.find(Inventory, {
        where: { id: In(sortedInventoryIds) },
        lock: { mode: 'pessimistic_write' },
      });
      if (lockedInventories.length !== sortedInventoryIds.length) {
        const foundInventoryIds = new Set(
          lockedInventories.map((inventoryRow) => inventoryRow.id),
        );
        const missingInventoryId = sortedInventoryIds.find(
          (inventoryId) => !foundInventoryIds.has(inventoryId),
        );
        throw new NotFoundException(
          `Inventory ${missingInventoryId} not found`,
        );
      }
      const inventoryById = new Map(
        lockedInventories.map((inventoryRow) => [
          inventoryRow.id,
          inventoryRow,
        ]),
      );

      // 6. Verify available excludes already-reserved units to prevent overselling
      for (const checkoutItem of checkoutItems) {
        const lockedInventory = inventoryById.get(checkoutItem.inventoryId);
        if (!lockedInventory) {
          throw new NotFoundException(
            `Inventory ${checkoutItem.inventoryId} not found`,
          );
        }
        // Available stock excludes already-reserved units to prevent overselling
        const availableUnits =
          lockedInventory.stock - lockedInventory.reservedAmount;
        if (availableUnits < checkoutItem.quantity) {
          throw new ConflictException(
            `Insufficient available inventory for ${checkoutItem.inventoryId}. Available: ${availableUnits}, requested: ${checkoutItem.quantity}`,
          );
        }
      }

      // 7. Increment reservedAmount (sole producer after refactor)
      for (const checkoutItem of checkoutItems) {
        const lockedInventory = inventoryById.get(checkoutItem.inventoryId);
        if (!lockedInventory) {
          throw new NotFoundException(
            `Inventory ${checkoutItem.inventoryId} not found`,
          );
        }
        lockedInventory.reservedAmount += checkoutItem.quantity;
        try {
          await manager.save(lockedInventory);
        } catch (saveError: unknown) {
          mapInventoryCheckViolation(
            saveError,
            'Inventory invariant violation',
          );
        }
      }

      // 8. Order total is server-calculated: sum of quantity * snapshot
      // unit_price. Quantities are positive integers and prices are
      // non-negative by the guards above, so the total cannot be negative
      // (no separate guard needed).
      let orderTotal = 0;
      for (const checkoutItem of checkoutItems) {
        orderTotal += checkoutItem.quantity * checkoutItem.unit_price;
      }

      // 9. Create Order PENDING
      const orderRepository = manager.getRepository(Order);
      const pendingOrder = orderRepository.create({
        userId,
        status: OrderStatus.PENDING,
        total: orderTotal,
      });
      const savedOrder = await orderRepository.save(pendingOrder);

      // 10. Create OrderItems (historical snapshot)
      const orderItemRepository = manager.getRepository(OrderItem);
      const orderItems = checkoutItems.map((checkoutItem) =>
        orderItemRepository.create({
          orderId: savedOrder.id,
          productId: checkoutItem.productId,
          quantity: checkoutItem.quantity,
          unit_price: checkoutItem.unit_price,
          productNameSnapshot: checkoutItem.productName,
        }),
      );
      const savedItems = await orderItemRepository.save(orderItems);

      // 11. Create Reservation via internal helper (no re-lock, assumes caller holds locks)
      const reservation = await this.reservationService.createForCheckout(
        manager,
        userId,
        checkoutItems.map((checkoutItem) => ({
          inventoryId: checkoutItem.inventoryId,
          quantity: checkoutItem.quantity,
        })),
        savedOrder.id,
      );

      // 12. Clear cart atomically via manager
      await this.cartService.clearCartForCheckout(manager, userId);

      // 13. OutboxEvent INSERT inside same transaction — no client.emit
      // Correlation ID resolved at request boundary (controller) and passed in
      const effectiveCorrelationId = correlationId || randomUUID();
      if (this.outboxService) {
        try {
          await this.outboxService.createEvent(manager, {
            eventType: 'order.created',
            aggregateType: 'Order',
            aggregateId: savedOrder.id,
            correlationId: effectiveCorrelationId,
            data: {
              orderId: savedOrder.id,
              userId,
              total: orderTotal,
              currency: ORDER_CURRENCY,
              items: checkoutItems.map((checkoutItem) => ({
                productId: checkoutItem.productId,
                inventoryId: checkoutItem.inventoryId,
                quantity: checkoutItem.quantity,
                unit_price: checkoutItem.unit_price,
              })),
              reservationId: reservation.id,
              expiresAt: reservation.expiresAt?.toISOString() ?? null,
              createdAt: savedOrder.created_at
                ? savedOrder.created_at.toISOString()
                : new Date().toISOString(),
            },
          });
        } catch (outboxError: unknown) {
          // Best-effort outbox — if table missing (integration without migration) log and continue so business still commits
          const errorMessage =
            outboxError instanceof Error
              ? outboxError.message
              : String(outboxError);
          this.logger.warn(
            `outbox order.created insert failed for ${savedOrder.id}: ${errorMessage}`,
          );
        }
      }

      this.logger.log(
        `Checkout succeeded for user ${userId} order ${savedOrder.id} total ${orderTotal}`,
      );

      // Reload order with items for response
      const fullOrder = await manager.findOne(Order, {
        where: { id: savedOrder.id },
        relations: { orderItems: { product: true } },
      });

      return {
        order: fullOrder ?? savedOrder,
        items: savedItems,
        reservation,
      };
    });
  }
}
