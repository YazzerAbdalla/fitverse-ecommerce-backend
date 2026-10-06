import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource, FindOptionsWhere } from 'typeorm';
import { Order } from './entities/order.entity';
import { Reservation } from '../reservation/entities/reservation.entity';
import { UserRoles } from '../users/enum/roles';
import { OrderStatus } from './order-status.enum';
import {
  assertOrderOwner,
  validateOrderTransition as validateSharedOrderTransition,
} from './order-transitions';

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
    const orderRepository = this.dataSource.getRepository(Order);

    const whereClause: FindOptionsWhere<Order> = {};
    // Owner-scoped unless Admin filters by userId
    if (role === UserRoles.Admin && filter?.userId) {
      whereClause.userId = filter.userId;
    } else {
      whereClause.userId = requestingUserId;
    }
    if (pagination.status) {
      whereClause.status = pagination.status as OrderStatus;
    }

    const [orderRows, total] = await orderRepository.findAndCount({
      where: whereClause,
      relations: { orderItems: { product: true } },
      // Offset pagination: skip the rows of previous pages.
      skip: (page - 1) * limit,
      take: limit,
      order: { created_at: 'DESC' },
    });

    // Enrich with reservationId via Reservation orderId FK (without eager join)
    const reservationRepository = this.dataSource.getRepository(Reservation);
    const enrichedOrders = await Promise.all(
      orderRows.map(async (orderRow) => {
        const linkedReservation = await reservationRepository.findOne({
          where: { orderId: orderRow.id },
        });
        return {
          ...orderRow,
          reservationId: linkedReservation?.id ?? null,
          expiresAt: linkedReservation?.expiresAt ?? null,
        };
      }),
    );

    return {
      data: enrichedOrders,
      meta: {
        totalItems: total,
        itemCount: orderRows.length,
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
  ): Promise<Order & { reservationId: string | null; expiresAt: Date | null }> {
    const orderRepository = this.dataSource.getRepository(Order);
    const order = await orderRepository.findOne({
      where: { id },
      relations: { orderItems: { product: true } },
    });
    if (!order) throw new NotFoundException(`Order ${id} not found`);
    this.assertOrderOwner(order, requestingUserId, role);

    const reservationRepository = this.dataSource.getRepository(Reservation);
    const linkedReservation = await reservationRepository.findOne({
      where: { orderId: order.id },
    });

    return {
      ...order,
      reservationId: linkedReservation?.id ?? null,
      expiresAt: linkedReservation?.expiresAt ?? null,
    };
  }

  /**
   * Validates an Order status transition (delegates to the shared table).
   * @param from - Current Order status.
   * @param to - Target Order status.
   * @throws ConflictException if transition is not allowed.
   */
  validateOrderTransition(from: OrderStatus, to: OrderStatus): void {
    validateSharedOrderTransition(from, to);
  }

  /**
   * Asserts that requesting user owns the order or is Admin.
   * @param order - Order to check.
   * @param requestingUserId - Current user id from JWT sub.
   * @param role - Current user role.
   * @throws ForbiddenException if not owner and not Admin.
   */
  assertOrderOwner(
    order: Order,
    requestingUserId: string,
    role?: UserRoles,
  ): void {
    assertOrderOwner(order, requestingUserId, role);
  }
}
