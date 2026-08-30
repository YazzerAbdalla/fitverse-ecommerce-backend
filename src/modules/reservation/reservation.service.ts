import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource, EntityManager } from 'typeorm';
import { Reservation } from './entities/reservation.entity';
import { ReservationItem } from './entities/reservation-item.entity';
import { ReservationStatus } from './entities/reservation-status.enum';
import { CreateReservationDto } from './dto/create-reservation.dto';
import { UserRoles } from '../users/enum/roles';
import { Inventory } from '../inventory/entities/inventory.entity';
import { Order } from '../order/entities/order.entity';

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

    const inventoryRepo = manager.getRepository(Inventory);
    for (const item of dto.items) {
      const inv = await inventoryRepo.findOne({
        where: { id: item.inventoryId },
      });
      if (!inv) {
        throw new NotFoundException(`Inventory ${item.inventoryId} not found`);
      }
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
    return this.transition(
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
    return this.transition(
      manager,
      requestingUserId,
      id,
      ReservationStatus.CANCELLED,
      undefined,
      role,
    );
  }

  async expire(manager: EntityManager, id: string): Promise<Reservation> {
    const repo = manager.getRepository(Reservation);
    const reservation = await repo.findOne({ where: { id } });
    if (!reservation)
      throw new NotFoundException(`Reservation ${id} not found`);
    this.validateTransition(reservation.status, ReservationStatus.EXPIRED);
    reservation.status = ReservationStatus.EXPIRED;
    return repo.save(reservation);
  }

  private async transition(
    manager: EntityManager,
    requestingUserId: string,
    id: string,
    to: ReservationStatus,
    orderId?: string,
    role?: UserRoles,
  ): Promise<Reservation> {
    const repo = manager.getRepository(Reservation);
    const reservation = await repo.findOne({
      where: { id },
      relations: { items: true },
    });
    if (!reservation)
      throw new NotFoundException(`Reservation ${id} not found`);
    this.assertOwner(reservation, requestingUserId, role);

    this.validateTransition(reservation.status, to);

    if (orderId) {
      const orderRepo = manager.getRepository(Order);
      const order = await orderRepo.findOne({ where: { id: orderId } });
      if (!order) throw new NotFoundException(`Order ${orderId} not found`);
      reservation.orderId = orderId;
    }

    reservation.status = to;
    return repo.save(reservation);
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
