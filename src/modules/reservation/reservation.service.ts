import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
  Optional,
} from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource, EntityManager, In } from 'typeorm';
import { CACHE_MANAGER } from '@nestjs/cache-manager';
import type { Cache } from 'cache-manager';
import { Reservation } from './entities/reservation.entity';
import { ReservationItem } from './entities/reservation-item.entity';
import { ReservationStatus } from './entities/reservation-status.enum';
import { CreateReservationDto } from './dto/create-reservation.dto';
import { UserRoles } from '../users/enum/roles';
import { Inventory } from '../inventory/entities/inventory.entity';
import { Order } from '../order/entities/order.entity';
import { OrderStatus } from '../order/order-status.enum';
import { ReservationTransitionBuilder } from './reservation-transition.builder';

const ALLOWED_TRANSITIONS: Record<ReservationStatus, ReservationStatus[]> = {
  [ReservationStatus.RESERVED]: [
    ReservationStatus.COMPLETED,
    ReservationStatus.EXPIRED,
    ReservationStatus.CANCELLED,
  ],
  [ReservationStatus.COMPLETED]: [],
  [ReservationStatus.EXPIRED]: [],
  [ReservationStatus.CANCELLED]: [],
};

const DEFAULT_TTL_MS = 15 * 60 * 1000;

/**
 * This service is responsible for reservation lifecycle domain.
 * It handles creation, transitions (complete/cancel/expire) and enforces inventory reservation invariants.
 * It enforces idempotent same-transition (200 with 0 delta) and single-winner FOR UPDATE ordering.
 */
@Injectable()
export class ReservationService {
  private readonly logger = new Logger(ReservationService.name);

  constructor(
    @InjectDataSource() public readonly dataSource: DataSource,
    @Optional()
    @Inject(CACHE_MANAGER)
    private readonly cache?: Cache,
  ) {}

  /**
   * Maps ReservationStatus transition target to idempotency counter type.
   * @param to - Target reservation status.
   * @returns Counter type key suffix (expiration|complete|cancel).
   */
  private getIdempotencyType(to: ReservationStatus): string {
    switch (to) {
      case ReservationStatus.EXPIRED:
        return 'expiration';
      case ReservationStatus.CANCELLED:
        return 'cancel';
      case ReservationStatus.COMPLETED:
        return 'complete';
      default:
        return to.toLowerCase();
    }
  }

  /**
   * Increments idempotency duplicate skipped counter via CACHE_MANAGER (fail-open).
   * @param to - Target status to derive counter key idempotency:duplicate:skipped:<type>.
   */
  private async incrementIdempotencyCounter(
    to: ReservationStatus,
  ): Promise<void> {
    const type = this.getIdempotencyType(to);
    const key = `idempotency:duplicate:skipped:${type}`;
    try {
      if (!this.cache) return;
      // Try direct redis INCR via Keyv store client (ioredis)
      const anyCache: any = this.cache as any;
      const store: any = anyCache.store ?? anyCache.stores?.[0];
      const client =
        store?.client ?? store?.store?.client ?? anyCache.client ?? null;
      if (client && typeof client.incr === 'function') {
        await client.incr(key);
        // ensure 24h expiry (86400s)
        if (typeof client.expire === 'function') {
          await client.expire(key, 86400);
        } else if (typeof client.pexpire === 'function') {
          await client.pexpire(key, 86400000);
        }
        return;
      }
      // Fallback to cache-manager get/set (fail-open)
      const current = (await this.cache.get<number>(key)) ?? 0;
      // cache-manager ttl in ms
      await this.cache.set(key, current + 1, 86400000);
    } catch (e: any) {
      // Fail-open: log warn but do not throw on counter failure
      this.logger.warn(
        `Redis fail-open for idempotency counter ${key}: ${e?.message}`,
      );
    }
  }

  /**
   * Validates allowed reservation status transition.
   * @param from - Current reservation status.
   * @param to - Target reservation status.
   * @throws ConflictException if transition is not allowed.
   */
  validateTransition(from: ReservationStatus, to: ReservationStatus): void {
    // Guard allowed transitions map; same-status is handled idempotently before this call
    if (!ALLOWED_TRANSITIONS[from].includes(to)) {
      throw new ConflictException(
        `Invalid reservation transition: ${from} -> ${to}`,
      );
    }
  }

  /**
   * Creates a reservation for checkout inside the caller's transaction.
   * Assumes caller already holds FOR UPDATE on inventories; does not re-lock.
   * @param manager - EntityManager of the enclosing transaction (caller owns commit/rollback).
   * @param requestingUserId - User creating the reservation.
   * @param items - Inventory items with quantity (must be >0, no duplicates).
   * @param orderId - Linked Order id.
   * @returns The created Reservation with items.
   * @throws BadRequestException if quantity invalid or duplicate.
   */
  async createForCheckout(
    manager: EntityManager,
    requestingUserId: string,
    items: { inventoryId: string; quantity: number }[],
    orderId: string,
  ): Promise<Reservation> {
    if (!items || items.length === 0) {
      throw new BadRequestException('Reservation items must not be empty');
    }
    const seen = new Set<string>();
    for (const item of items) {
      if (!Number.isInteger(item.quantity) || item.quantity <= 0) {
        throw new BadRequestException(
          `Quantity must be a positive integer for ${item.inventoryId}`,
        );
      }
      if (seen.has(item.inventoryId)) {
        throw new BadRequestException(
          `Duplicate inventoryId in request: ${item.inventoryId}`,
        );
      }
      seen.add(item.inventoryId);
    }

    // No re-lock: caller already holds FOR UPDATE on inventories
    const reservationRepo = manager.getRepository(Reservation);
    const itemRepo = manager.getRepository(ReservationItem);

    const expiresAt = new Date(Date.now() + DEFAULT_TTL_MS);

    const reservation = reservationRepo.create({
      userId: requestingUserId,
      orderId,
      status: ReservationStatus.RESERVED,
      expiresAt,
    });
    const saved = await reservationRepo.save(reservation);

    const reservationItems = items.map((i) =>
      itemRepo.create({
        reservationId: saved.id,
        inventoryId: i.inventoryId,
        quantity: i.quantity,
      }),
    );
    await itemRepo.save(reservationItems);

    this.logger.log(
      `Created checkout reservation ${saved.id} for user ${requestingUserId} order ${orderId}`,
    );
    return this.findByIdInternal(manager, saved.id);
  }

  async create(
    manager: EntityManager,
    requestingUserId: string,
    dto: CreateReservationDto,
  ): Promise<Reservation> {
    let expiresAt: Date;
    if (dto.expiresAt) {
      expiresAt = new Date(dto.expiresAt);
      if (isNaN(expiresAt.getTime()) || expiresAt.getTime() <= Date.now()) {
        throw new BadRequestException('expiresAt must be a future timestamp');
      }
    } else {
      expiresAt = new Date(Date.now() + DEFAULT_TTL_MS);
    }

    if (dto.orderId) {
      const orderRepo = manager.getRepository(Order);
      const order = await orderRepo.findOne({ where: { id: dto.orderId } });
      if (!order) {
        throw new NotFoundException(`Order ${dto.orderId} not found`);
      }
    }

    const seen = new Set<string>();
    for (const item of dto.items) {
      if (seen.has(item.inventoryId)) {
        throw new BadRequestException(
          `Duplicate inventoryId in request: ${item.inventoryId}`,
        );
      }
      seen.add(item.inventoryId);
    }

    // deterministic lock ordering to prevent deadlocks (FR-003/D2)
    const sortedIds = [...new Set(dto.items.map((i) => i.inventoryId))].sort();
    const lockedInventories = await manager.find(Inventory, {
      where: { id: In(sortedIds) },
      lock: { mode: 'pessimistic_write' },
    });
    if (lockedInventories.length !== sortedIds.length) {
      const foundIds = new Set(lockedInventories.map((r) => r.id));
      const missing = sortedIds.find((id) => !foundIds.has(id))!;
      throw new NotFoundException(`Inventory ${missing} not found`);
    }
    const inventoryMap = new Map(lockedInventories.map((inv) => [inv.id, inv]));

    for (const item of dto.items) {
      const inv = inventoryMap.get(item.inventoryId)!;
      if (inv.available < item.quantity) {
        throw new ConflictException(
          `Insufficient available inventory for ${item.inventoryId}. Available: ${inv.available}, requested: ${item.quantity}`,
        );
      }
    }

    const inventoryRepo = manager.getRepository(Inventory);
    for (const item of dto.items) {
      const inv = inventoryMap.get(item.inventoryId)!;
      inv.reservedAmount += item.quantity;
      await inventoryRepo.save(inv);
    }

    const reservationRepo = manager.getRepository(Reservation);
    const itemRepo = manager.getRepository(ReservationItem);

    const reservation = reservationRepo.create({
      userId: requestingUserId,
      orderId: dto.orderId ?? null,
      status: ReservationStatus.RESERVED,
      expiresAt,
    });
    const saved = await reservationRepo.save(reservation);

    const items = dto.items.map((i) =>
      itemRepo.create({
        reservationId: saved.id,
        inventoryId: i.inventoryId,
        quantity: i.quantity,
      }),
    );
    await itemRepo.save(items);

    this.logger.log(
      `Created reservation ${saved.id} for user ${requestingUserId}`,
    );
    return this.findByIdInternal(manager, saved.id);
  }

  private async findByIdInternal(
    manager: EntityManager,
    id: string,
  ): Promise<Reservation> {
    const repo = manager.getRepository(Reservation);
    const reservation = await repo.findOne({
      where: { id },
      relations: { items: true },
    });
    if (!reservation) {
      throw new NotFoundException(`Reservation ${id} not found`);
    }
    return reservation;
  }

  /**
   * Finds a reservation by id with owner check.
   * @param requestingUserId - Requesting user id.
   * @param id - Reservation id.
   * @param role - Requesting role for admin bypass.
   * @returns Reservation with items.
   * @throws NotFoundException if not found.
   * @throws ForbiddenException if not owner.
   */
  async findById(
    requestingUserId: string,
    id: string,
    role?: UserRoles,
  ): Promise<Reservation> {
    const repo = this.dataSource.getRepository(Reservation);
    const reservation = await repo.findOne({
      where: { id },
      relations: { items: true },
    });
    if (!reservation)
      throw new NotFoundException(`Reservation ${id} not found`);
    this.assertOwner(reservation, requestingUserId, role);
    return reservation;
  }

  /**
   * Lists reservations for a user with pagination.
   * @param requestingUserId - Requesting user id.
   * @param pagination - Pagination params page/limit.
   * @param filter - Optional admin userId filter.
   * @param role - Requesting role.
   * @returns Paginated reservations.
   */
  async listByUser(
    requestingUserId: string,
    pagination: { page?: number; limit?: number },
    filter?: { userId?: string },
    role?: UserRoles,
  ): Promise<{ data: Reservation[]; meta: any }> {
    const page = pagination.page ?? 1;
    const limit = Math.min(pagination.limit ?? 20, 100);
    const repo = this.dataSource.getRepository(Reservation);

    const where: any = {};
    if (role === UserRoles.Admin && filter?.userId) {
      where.userId = filter.userId;
    } else {
      where.userId = requestingUserId;
    }

    const [data, total] = await repo.findAndCount({
      where,
      relations: { items: true },
      skip: (page - 1) * limit,
      take: limit,
      order: { createdAt: 'DESC' },
    });

    return {
      data,
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
   * Completes a reservation (RESERVED→COMPLETED) inside caller's transaction.
   * @param manager - EntityManager of the enclosing transaction.
   * @param requestingUserId - Requesting user id.
   * @param id - Reservation id.
   * @param dto - Optional orderId payload.
   * @param role - Requesting role.
   * @returns Updated reservation (or idempotent 200 if already COMPLETED).
   * @throws NotFoundException if not found.
   * @throws ConflictException if invalid transition.
   */
  async complete(
    manager: EntityManager,
    requestingUserId: string,
    id: string,
    dto?: { orderId?: string },
    role?: UserRoles,
  ): Promise<Reservation> {
    return this.transitionWithInventory(
      manager,
      requestingUserId,
      id,
      ReservationStatus.COMPLETED,
      dto?.orderId,
      role,
    );
  }

  /**
   * Cancels a reservation (RESERVED→CANCELLED) inside caller's transaction.
   * Idempotent CANCELLED→CANCELLED returns 200 with 0 delta before Inventory FOR UPDATE.
   * @param manager - EntityManager of the enclosing transaction.
   * @param requestingUserId - Requesting user id.
   * @param id - Reservation id.
   * @param role - Requesting role.
   * @returns Updated reservation (or idempotent 200 if already CANCELLED).
   * @throws NotFoundException if not found.
   * @throws ConflictException if invalid transition.
   */
  async cancel(
    manager: EntityManager,
    requestingUserId: string,
    id: string,
    role?: UserRoles,
  ): Promise<Reservation> {
    return this.transitionWithInventory(
      manager,
      requestingUserId,
      id,
      ReservationStatus.CANCELLED,
      undefined,
      role,
    );
  }

  /**
   * Expires a reservation (RESERVED→EXPIRED) inside caller's transaction.
   * Idempotent EXPIRED→EXPIRED returns 200 with 0 delta before Inventory FOR UPDATE.
   * @param manager - EntityManager of the enclosing transaction.
   * @param id - Reservation id.
   * @returns Updated reservation (or idempotent 200 if already EXPIRED).
   * @throws NotFoundException if not found.
   * @throws ConflictException if invalid transition.
   */
  async expire(manager: EntityManager, id: string): Promise<Reservation> {
    // Admin-only at controller; service does not enforce role, but still transactional with inventory
    // Q1: immediate override — no expiresAt check
    return this.transitionWithInventoryExpire(manager, id);
  }

  /**
   * Builds an EXPIRED transition without owner check via builder (admin/worker bypass).
   * Replaces positional boolean args with fluent builder per TODO.
   */
  private async transitionWithInventoryExpire(
    manager: EntityManager,
    id: string,
  ): Promise<Reservation> {
    return new ReservationTransitionBuilder(this, manager, id)
      .to(ReservationStatus.EXPIRED)
      .withoutOwnerCheck()
      .execute();
  }

  private async transition(
    manager: EntityManager,
    requestingUserId: string,
    id: string,
    to: ReservationStatus,
    orderId?: string,
    role?: UserRoles,
  ): Promise<Reservation> {
    return this.transitionWithInventory(
      manager,
      requestingUserId,
      id,
      to,
      orderId,
      role,
    );
  }

  private async transitionWithInventory(
    manager: EntityManager,
    requestingUserId: string,
    id: string,
    to: ReservationStatus,
    orderId?: string,
    role?: UserRoles,
  ): Promise<Reservation> {
    return this.transitionWithInventoryInternal(
      manager,
      requestingUserId,
      id,
      to,
      orderId,
      role,
      true,
    );
  }

  /**
   * Executes a reservation status transition inside the caller's transaction.
   * Enforces idempotent same-transition (200 with 0 delta) BEFORE any Inventory FOR UPDATE and BEFORE validateTransition.
   * Only RESERVED→* mutates inventory (reservedAmount/stock); same-transition returns 200 without mutation and increments idempotency counter.
   * @param manager - EntityManager of the enclosing transaction (caller owns commit/rollback).
   * @param requestingUserId - Requesting user id or null for worker bypass.
   * @param id - Reservation id.
   * @param to - Target status (EXPIRED|CANCELLED|COMPLETED).
   * @param orderId - Optional orderId to attach (COMPLETED overwrite).
   * @param role - Requesting role for owner check.
   * @param checkOwner - Whether to enforce owner assertion.
   * @returns Updated or idempotently returned Reservation.
   * @throws NotFoundException if reservation/inventory/order missing.
   * @throws ConflictException if invalid cross-transition or DB CHECK violation.
   * @throws ForbiddenException if not owner.
   */
  private async transitionWithInventoryInternal(
    manager: EntityManager,
    requestingUserId: string | null,
    id: string,
    to: ReservationStatus,
    orderId?: string,
    role?: UserRoles,
    checkOwner = true,
  ): Promise<Reservation> {
    const reservationRepo = manager.getRepository(Reservation);
    // Lock Reservation FOR UPDATE (D1) — avoid FOR UPDATE with outer join (cannot lock nullable side)
    // First lock the row without relations, then load with relations (lock held for tx duration)
    const lockedRow = await reservationRepo.findOne({
      where: { id },
      lock: { mode: 'pessimistic_write' },
    } as any);
    if (!lockedRow) throw new NotFoundException(`Reservation ${id} not found`);
    const reservation = await reservationRepo.findOne({
      where: { id },
      relations: { items: true },
    });
    if (!reservation)
      throw new NotFoundException(`Reservation ${id} not found`);

    if (checkOwner && requestingUserId !== null) {
      this.assertOwner(reservation, requestingUserId, role);
    }

    // Idempotent guard: same-transition -> 200 with 0 delta (must be BEFORE any Inventory FOR UPDATE and BEFORE validateTransition)
    // This ensures second expire/cancel/complete on already terminal does not double-subtract reservedAmount/stock
    // Do not treat 200 idempotent as poison — expiration worker excludes 200/404 from poison count (D2)
    if (reservation.status === to) {
      // Handle orderId overwrite for COMPLETED->COMPLETED if supplied and different (per Q3)
      if (
        to === ReservationStatus.COMPLETED &&
        orderId &&
        reservation.orderId !== orderId
      ) {
        const orderRepo = manager.getRepository(Order);
        const order = await orderRepo.findOne({ where: { id: orderId } });
        if (!order) throw new NotFoundException(`Order ${orderId} not found`);
        reservation.orderId = orderId;
        const saved = await reservationRepo.save(reservation);
        this.logger.log(
          `reservation idempotent skip id=${id} status=${reservation.status} -> ${to} (with orderId overwrite)`,
        );
        await this.incrementIdempotencyCounter(to);
        return (await reservationRepo.findOne({
          where: { id: saved.id },
          relations: { items: true },
        })) as Reservation;
      }
      this.logger.log(
        `reservation idempotent skip id=${id} status=${reservation.status} -> ${to}`,
      );
      await this.incrementIdempotencyCounter(to);
      return reservation;
    }

    const fromStatus = reservation.status;
    // Validate cross-transition; same-transition already returned 200 above, cross-transition COMPLETED->EXPIRED etc stays 409
    this.validateTransition(fromStatus, to);

    if (orderId) {
      const orderRepo = manager.getRepository(Order);
      const order = await orderRepo.findOne({ where: { id: orderId } });
      if (!order) throw new NotFoundException(`Order ${orderId} not found`);
      reservation.orderId = orderId;
    }

    // No items? Still allow status change but no inventory mutation (edge)
    if (!reservation.items || reservation.items.length === 0) {
      reservation.status = to;
      const savedNoItems = await reservationRepo.save(reservation);
      if (
        to === ReservationStatus.EXPIRED &&
        reservation.orderId &&
        fromStatus === ReservationStatus.RESERVED
      ) {
        const orderRepo = manager.getRepository(Order);
        const lockedOrder = await orderRepo.findOne({
          where: { id: reservation.orderId },
          lock: { mode: 'pessimistic_write' },
        } as any);
        if (lockedOrder && lockedOrder.status === OrderStatus.PENDING) {
          lockedOrder.status = OrderStatus.CANCELLED;
          await orderRepo.save(lockedOrder);
          this.logger.log(
            `Order ${lockedOrder.id} PENDING -> CANCELLED due to reservation ${id} expiry (no items)`,
          );
        }
      }
      return savedNoItems;
    }

    // Deterministic lock ordering (D2)
    const sortedIds = [
      ...new Set(reservation.items.map((i) => i.inventoryId)),
    ].sort();
    let lockedInventories: Inventory[] = [];
    if (sortedIds.length > 0) {
      lockedInventories = await manager.find(Inventory, {
        where: { id: In(sortedIds) },
        lock: { mode: 'pessimistic_write' },
      });
      if (lockedInventories.length !== sortedIds.length) {
        const foundIds = new Set(lockedInventories.map((r) => r.id));
        const missing = sortedIds.find((mid) => !foundIds.has(mid))!;
        throw new NotFoundException(`Inventory ${missing} not found`);
      }
    }
    const inventoryMap = new Map(lockedInventories.map((inv) => [inv.id, inv]));

    // Mutate inventory per FR-002/FR-003
    const inventoryRepo = manager.getRepository(Inventory);
    try {
      for (const item of reservation.items) {
        const inv = inventoryMap.get(item.inventoryId)!;
        if (to === ReservationStatus.COMPLETED) {
          // Q2: no explicit stock>=qty check, rely on DB CHECK
          inv.stock -= item.quantity;
          inv.reservedAmount -= item.quantity;
        } else if (
          to === ReservationStatus.CANCELLED ||
          to === ReservationStatus.EXPIRED
        ) {
          inv.reservedAmount -= item.quantity;
        }
        await inventoryRepo.save(inv);
      }
    } catch (e: any) {
      // Map DB CHECK violation to 409 per FR-007
      const msg = e?.message ?? '';
      if (
        msg.includes('CHK_') ||
        msg.includes('check constraint') ||
        msg.includes('violates check') ||
        e?.code === '23514'
      ) {
        throw new ConflictException(
          `Inventory invariant violation on transition ${reservation.status} -> ${to}: ${msg}`,
        );
      }
      throw e;
    }

    reservation.status = to;
    const saved = await reservationRepo.save(reservation);

    // Auto-cancel Order PENDING -> CANCELLED atomically when Reservation expires (Q8 B)
    if (
      to === ReservationStatus.EXPIRED &&
      reservation.orderId &&
      fromStatus === ReservationStatus.RESERVED
    ) {
      try {
        const orderRepo = manager.getRepository(Order);
        const lockedOrder = await orderRepo.findOne({
          where: { id: reservation.orderId },
          lock: { mode: 'pessimistic_write' },
        } as any);
        if (lockedOrder && lockedOrder.status === OrderStatus.PENDING) {
          lockedOrder.status = OrderStatus.CANCELLED;
          await orderRepo.save(lockedOrder);
          this.logger.log(
            `Order ${lockedOrder.id} PENDING -> CANCELLED due to reservation ${id} expiry`,
          );
        }
      } catch (e: any) {
        // Log but don't fail reservation expiry; order cancel is best-effort within same tx - rollback if error is severe
        // If lock fails, let transaction rollback to retry
        if (e?.code === '23514' || e?.message?.includes('CHK_')) {
          throw e;
        }
        this.logger.warn(
          `Failed to auto-cancel order ${reservation.orderId} on reservation expiry ${id}: ${e?.message}`,
        );
      }
    }

    this.logger.log(
      `Reservation ${id} ${fromStatus} -> ${to} (inventory updated)`,
    );
    // Return with items
    return (await reservationRepo.findOne({
      where: { id: saved.id },
      relations: { items: true },
    })) as Reservation;
  }

  /**
   * Asserts reservation owner or admin.
   * @param reservation - Reservation to check.
   * @param requestingUserId - Requesting user id.
   * @param role - Requesting role.
   * @throws ForbiddenException if not owner and not admin.
   */
  private assertOwner(
    reservation: Reservation,
    requestingUserId: string,
    role?: UserRoles,
  ): void {
    if (reservation.userId !== requestingUserId && role !== UserRoles.Admin) {
      throw new ForbiddenException(
        'You are not allowed to access this reservation',
      );
    }
  }
}
