import {
  ConflictException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { Order } from './entities/order.entity';
import { Reservation } from '../reservation/entities/reservation.entity';
import { UserRoles } from '../users/enum/roles';
import { OrderStatus } from './order-status.enum';

/**
 * Allowed Order status transitions (mirrors Reservation ALLOWED_TRANSITIONS).
 * Idempotent COMPLETED→COMPLETED is handled as a short-circuit before this map.
 */
const ALLOWED_ORDER_TRANSITIONS: Record<OrderStatus, OrderStatus[]> = {
  [OrderStatus.PENDING]: [
    OrderStatus.COMPLETED,
    OrderStatus.CANCELLED,
    OrderStatus.FAILED,
  ],
  [OrderStatus.COMPLETED]: [OrderStatus.COMPLETED],
  [OrderStatus.CANCELLED]: [],
  [OrderStatus.FAILED]: [],
};

/**
 * This service is responsible for order retrieval domain.
 * It handles pagination and ownership checks for orders.
 */
@Injectable()
export class OrderService {
  private readonly logger = new Logger(OrderService.name);

  constructor(@InjectDataSource() private readonly dataSource: DataSource) {}

  /**
   * Lists orders paginated and owner-scoped.
   * @param requestingUserId - Current user id.
   * @param pagination - Page and limit.
   * @param role - User role for admin bypass.
   * @param filter - Optional userId filter for Admin.
   * @returns Paginated data and meta.
   */
  async findAll(
    requestingUserId: string,
    pagination: { page?: number; limit?: number; status?: string },
    role?: UserRoles,
    filter?: { userId?: string },
  ): Promise<{ data: any[]; meta: any }> {
    const page = pagination.page ?? 1;
    const limit = Math.min(pagination.limit ?? 20, 100);
    const repo = this.dataSource.getRepository(Order);

    const where: any = {};
    // Owner-scoped unless Admin filters by userId
    if (role === UserRoles.Admin && filter?.userId) {
      where.userId = filter.userId;
    } else {
      where.userId = requestingUserId;
    }
    if (pagination.status) {
      where.status = pagination.status;
    }

    const [data, total] = await repo.findAndCount({
      where,
      relations: { orderItems: { product: true } },
      skip: (page - 1) * limit,
      take: limit,
      order: { created_at: 'DESC' },
    });

    // Enrich with reservationId via Reservation orderId FK (without eager join)
    const reservationRepo = this.dataSource.getRepository(Reservation);
    const enriched = await Promise.all(
      data.map(async (order) => {
        const res = await reservationRepo.findOne({
          where: { orderId: order.id },
        });
        return {
          ...order,
          reservationId: res?.id ?? null,
          expiresAt: res?.expiresAt ?? null,
        };
      }),
    );

    return {
      data: enriched,
      meta: {
        totalItems: total,
        itemCount: data.length,
        itemsPerPage: limit,
        totalPages: Math.ceil(total / limit) || 1,
        currentPage: page,
      },
    };
  }

  /**
   * Finds one order with ownership check.
   * @param requestingUserId - Current user id.
   * @param id - Order id.
   * @param role - User role.
   * @returns Order with items and reservationId.
   * @throws NotFoundException if missing.
   * @throws ForbiddenException if not owner and not admin.
   */
  async findOne(
    requestingUserId: string,
    id: string,
    role?: UserRoles,
  ): Promise<any> {
    const repo = this.dataSource.getRepository(Order);
    const order = await repo.findOne({
      where: { id },
      relations: { orderItems: { product: true } },
    });
    if (!order) throw new NotFoundException(`Order ${id} not found`);
    this.assertOwner(order, requestingUserId, role);

    const reservationRepo = this.dataSource.getRepository(Reservation);
    const res = await reservationRepo.findOne({ where: { orderId: order.id } });

    return {
      ...order,
      reservationId: res?.id ?? null,
      expiresAt: res?.expiresAt ?? null,
    };
  }

  /**
   * Validates an Order status transition.
   * @param from - Current Order status.
   * @param to - Target Order status.
   * @throws ConflictException if transition is not allowed.
   */
  validateOrderTransition(from: OrderStatus, to: OrderStatus): void {
    // Idempotent COMPLETED→COMPLETED is handled by caller as early return before this check
    if (from === OrderStatus.COMPLETED && to === OrderStatus.COMPLETED) {
      return;
    }
    const allowed = ALLOWED_ORDER_TRANSITIONS[from] ?? [];
    // No duplicate COMPLETED in allowed for COMPLETED (handled above), but keep map for docs
    if (!allowed.includes(to)) {
      throw new ConflictException(`Invalid order transition: ${from} -> ${to}`);
    }
  }

  /**
   * Asserts that requesting user owns the order or is Admin.
   * @param order - Order to check.
   * @param requestingUserId - Current user id from JWT sub.
   * @param role - Current user role.
   * @throws ForbiddenException if not owner and not Admin.
   */
  assertOwner(order: Order, requestingUserId: string, role?: UserRoles): void {
    if (order.userId !== requestingUserId && role !== UserRoles.Admin) {
      throw new ForbiddenException('You are not allowed to access this order');
    }
  }

  // Deprecated stubs kept for compatibility
  create(_dto: any) {
    throw new NotFoundException('Use POST /order/checkout');
  }
  update(_id: number, _dto: any) {
    throw new NotFoundException('Not implemented');
  }
  remove(_id: number) {
    throw new NotFoundException('Not implemented');
  }
}
