import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource, EntityManager, In } from 'typeorm';
import { Reservation } from './entities/reservation.entity';
import { ReservationItem } from './entities/reservation-item.entity';
import { ReservationStatus } from './entities/reservation-status.enum';
import { CreateReservationDto } from './dto/create-reservation.dto';
import { UserRoles } from '../users/enum/roles';
import { Inventory } from '../inventory/entities/inventory.entity';
import { Order } from '../order/entities/order.entity';
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

@Injectable()
export class ReservationService {
  private readonly logger = new Logger(ReservationService.name);

  constructor(@InjectDataSource() public readonly dataSource: DataSource) {}

  validateTransition(from: ReservationStatus, to: ReservationStatus): void {
    if (!ALLOWED_TRANSITIONS[from].includes(to)) {
      throw new ConflictException(
        `Invalid reservation transition: ${from} -> ${to}`,
      );
    }
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

    // Idempotent COMPLETED -> COMPLETED (Q4 B) — return 200 without inventory re-mutation
    if (
      reservation.status === ReservationStatus.COMPLETED &&
      to === ReservationStatus.COMPLETED
    ) {
      // Still handle orderId overwrite per Q3 if supplied and different
      if (orderId) {
        const orderRepo = manager.getRepository(Order);
        const order = await orderRepo.findOne({ where: { id: orderId } });
        if (!order) throw new NotFoundException(`Order ${orderId} not found`);
        if (reservation.orderId !== orderId) {
          reservation.orderId = orderId;
          const saved = await reservationRepo.save(reservation);
          this.logger.log(
            `Idempotent complete (with orderId overwrite) for ${id} -> ${to}, orderId ${orderId}`,
          );
          return reservationRepo.findOne({
            where: { id: saved.id },
            relations: { items: true },
          }) as Promise<Reservation>;
        }
      }
      this.logger.log(
        `Idempotent complete for ${id} already COMPLETED — no inventory change`,
      );
      return reservation;
    }

    const fromStatus = reservation.status;
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
      return reservationRepo.save(reservation);
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
    this.logger.log(
      `Reservation ${id} ${fromStatus} -> ${to} (inventory updated)`,
    );
    // Return with items
    return (await reservationRepo.findOne({
      where: { id: saved.id },
      relations: { items: true },
    })) as Reservation;
  }

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
