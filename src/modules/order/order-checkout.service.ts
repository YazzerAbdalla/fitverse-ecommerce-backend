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
import { CartService } from '../cart/cart.service';
import { OutboxService } from '../outbox/outbox.service';
import { randomUUID } from 'crypto';

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
   * Performs cart-only checkout for user.
   * @param userId - Authenticated user id from JWT sub.
   * @param correlationId - Optional correlationId for outbox tracing (generated if missing).
   * @returns Created order and reservation.
   * @throws BadRequestException if cart empty.
   * @throws NotFoundException if product/inventory missing.
   * @throws ConflictException if insufficient available.
   */
  async checkout(
    userId: string,
    correlationId?: string,
  ): Promise<{ order: Order; reservation: any; items: OrderItem[] }> {
    return this.dataSource.transaction(async (manager) => {
      // 1. Load cart with items + product via manager (stay in transaction)
      const cart = await manager.findOne(Cart, {
        where: { user: { id: userId } },
        relations: { cart_items: { product: true } },
      });

      if (!cart || !cart.cart_items || cart.cart_items.length === 0) {
        throw new BadRequestException('Cart is empty');
      }

      // Validate and collect productIds
      const seenProducts = new Set<string>();
      for (const ci of cart.cart_items) {
        if (!Number.isInteger(ci.quantity) || ci.quantity <= 0) {
          throw new BadRequestException('Quantity must be a positive integer');
        }
        if (seenProducts.has(ci.product.id)) {
          throw new BadRequestException(
            `Duplicate product in cart: ${ci.product.id}`,
          );
        }
        seenProducts.add(ci.product.id);
      }

      const productIds = cart.cart_items.map((ci) => ci.product.id);

      // 2. Snapshot product prices via manager (no lock needed, read-committed)
      const products = await manager.find(Product, {
        where: { id: In(productIds) },
      });
      if (products.length !== productIds.length) {
        const found = new Set(products.map((p) => p.id));
        const missing = productIds.find((id) => !found.has(id))!;
        throw new NotFoundException(`Product ${missing} not found`);
      }
      const productMap = new Map(products.map((p) => [p.id, p]));

      // 3. Map productId -> inventoryId (via Inventory lookup)
      const inventoriesByProduct = await manager.find(Inventory, {
        where: { productId: In(productIds) },
      });
      const invByProductId = new Map(
        inventoriesByProduct.map((inv) => [inv.productId, inv]),
      );
      // Check missing inventory
      for (const pid of productIds) {
        if (!invByProductId.has(pid)) {
          throw new NotFoundException(`Inventory for product ${pid} not found`);
        }
      }

      // Build items with inventoryId and price snapshot
      const checkoutItems = cart.cart_items.map((ci) => {
        const prod = productMap.get(ci.product.id)!;
        const inv = invByProductId.get(ci.product.id)!;
        // Validate product price >=0
        if (prod.price == null || prod.price < 0) {
          throw new BadRequestException(`Invalid product price for ${prod.id}`);
        }
        return {
          productId: ci.product.id,
          inventoryId: inv.id,
          quantity: ci.quantity,
          unit_price: prod.price,
          productName: prod.name,
        };
      });

      // 4. Deterministic lock ordering to prevent deadlock when carts have opposite item order
      const sortedIds = [
        ...new Set(checkoutItems.map((i) => i.inventoryId)),
      ].sort();

      // 5. Lock inventories FOR UPDATE
      const lockedInventories = await manager.find(Inventory, {
        where: { id: In(sortedIds) },
        lock: { mode: 'pessimistic_write' },
      });
      if (lockedInventories.length !== sortedIds.length) {
        const foundIds = new Set(lockedInventories.map((r) => r.id));
        const missing = sortedIds.find((id) => !foundIds.has(id))!;
        throw new NotFoundException(`Inventory ${missing} not found`);
      }
      const inventoryMap = new Map(
        lockedInventories.map((inv) => [inv.id, inv]),
      );

      // 6. Verify available excludes already-reserved units to prevent overselling
      for (const item of checkoutItems) {
        const inv = inventoryMap.get(item.inventoryId)!;
        // Available stock excludes already-reserved units to prevent overselling
        const available = inv.stock - inv.reservedAmount;
        if (available < item.quantity) {
          throw new ConflictException(
            `Insufficient available inventory for ${item.inventoryId}. Available: ${available}, requested: ${item.quantity}`,
          );
        }
      }

      // 7. Increment reservedAmount (sole producer after refactor)
      for (const item of checkoutItems) {
        const inv = inventoryMap.get(item.inventoryId)!;
        inv.reservedAmount += item.quantity;
        try {
          await manager.save(inv);
        } catch (e: any) {
          const msg = e?.message ?? '';
          if (
            e?.code === '23514' ||
            msg.includes('CHK_') ||
            msg.includes('check constraint')
          ) {
            throw new ConflictException(
              `Inventory invariant violation: ${msg}`,
            );
          }
          throw e;
        }
      }

      // 8. Compute total = Σ quantity * unit_price (cents, server-calculated)
      let total = 0;
      for (const item of checkoutItems) {
        // total formula: sum of qty * price
        total += item.quantity * item.unit_price;
      }
      if (total < 0) {
        throw new BadRequestException('Total must be non-negative');
      }

      // 9. Create Order PENDING
      const orderRepo = manager.getRepository(Order);
      const order = orderRepo.create({
        userId,
        status: OrderStatus.PENDING,
        total,
      });
      const savedOrder = await orderRepo.save(order);

      // 10. Create OrderItems (historical snapshot)
      const orderItemRepo = manager.getRepository(OrderItem);
      const orderItems = checkoutItems.map((i) =>
        orderItemRepo.create({
          orderId: savedOrder.id,
          productId: i.productId,
          quantity: i.quantity,
          unit_price: i.unit_price,
          productNameSnapshot: i.productName,
        }),
      );
      const savedItems = await orderItemRepo.save(orderItems);

      // 11. Create Reservation via internal helper (no re-lock, assumes caller holds locks)
      const reservation = await this.reservationService.createForCheckout(
        manager,
        userId,
        checkoutItems.map((i) => ({
          inventoryId: i.inventoryId,
          quantity: i.quantity,
        })),
        savedOrder.id,
      );

      // 12. Clear cart atomically via manager
      await this.cartService.clearCartForCheckout(manager, userId);

      // 13. OutboxEvent INSERT inside same transaction — no client.emit
      // Correlation ID resolved at request boundary (controller) and passed in
      const corrId = correlationId || randomUUID();
      if (this.outboxService) {
        try {
          await this.outboxService.createEvent(manager, {
            eventType: 'order.created',
            aggregateType: 'Order',
            aggregateId: savedOrder.id,
            correlationId: corrId,
            data: {
              orderId: savedOrder.id,
              userId,
              total,
              currency: 'usd',
              items: checkoutItems.map((i) => ({
                productId: i.productId,
                inventoryId: i.inventoryId,
                quantity: i.quantity,
                unit_price: i.unit_price,
              })),
              reservationId: reservation.id,
              expiresAt: reservation.expiresAt?.toISOString() ?? null,
              createdAt: savedOrder.created_at
                ? (savedOrder.created_at as Date).toISOString()
                : new Date().toISOString(),
            },
          });
        } catch (e: any) {
          // Best-effort outbox — if table missing (integration without migration) log and continue so business still commits
          this.logger.warn(
            `outbox order.created insert failed for ${savedOrder.id}: ${e?.message}`,
          );
        }
      }

      this.logger.log(
        `Checkout succeeded for user ${userId} order ${savedOrder.id} total ${total}`,
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
