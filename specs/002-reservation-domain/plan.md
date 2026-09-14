# Implementation Plan: Reservation Domain (Phase 2) — Detailed / Step-by-Step

**Branch**: `002-reservation-domain` | **Date**: 2026-08-22 | **Spec**: [spec.md](./spec.md)
**Goal**: Make this plan detailed enough that a low-cost AI model (or junior dev) can implement Phase 2 without guessing. Every step is concrete: which file, which decorator, which line to add, which test to write.

---

## 0. TL;DR (read this first)

We are adding a **Reservation** feature. A reservation is a temporary hold on one
or more products' inventory for a specific user. In Phase 2 we ONLY build the
data model + service + REST API + state machine. We do **NOT** change inventory
stock yet (that is Phase 3-4), and we do **NOT** add an expiration worker yet
(Phase 5).

Concretely, after this plan you will have:
- Two new TypeORM entities: `Reservation` and `ReservationItem`
- A new `ReservationModule` with `ReservationService` and `ReservationController`
- A new REST API under `/reservations`
- DB: a new `Reservation` table, `ReservationItem` table, an enum `reservation_status`, indexes, foreign keys, a `CHECK` constraint, and a unique constraint
- A migration file (because `synchronize: false`)
- Unit tests + integration tests against real PostgreSQL
- The API enforces: auth, owner-or-admin access, 4-state machine, validation

Key decisions already made (from `/speckit.clarify`):
1. `expiresAt` is optional in the API; if missing, service sets it to `now + 15 minutes`. If supplied, it must be in the future.
2. Access is **owner or ADMIN only** (others get 403; unauthenticated gets 401).
3. `orderId` is nullable FK (`ON DELETE SET NULL`) now; becomes strict after Phase 6.
4. Duplicate `inventoryId` in one reservation → rejected (400/409).
5. All service write methods take an `EntityManager` parameter now (so Phase 3 can wrap them in a transaction without changing signatures).

---

## 1. Files to create / modify (master checklist)

Create:
- `src/modules/reservation/entities/reservation-status.enum.ts`
- `src/modules/reservation/entities/reservation.entity.ts`
- `src/modules/reservation/entities/reservation-item.entity.ts`
- `src/modules/reservation/dto/create-reservation.dto.ts`
- `src/modules/reservation/dto/reservation-response.dto.ts`
- `src/modules/reservation/dto/update-reservation-status.dto.ts`
- `src/modules/reservation/reservation.service.ts`
- `src/modules/reservation/reservation.controller.ts`
- `src/modules/reservation/reservation.module.ts`
- `src/modules/reservation/reservation.service.spec.ts`
- `src/modules/reservation/test/reservation.integration.spec.ts`
- `src/migration/<TIMESTAMP>-CreateReservationAndReservationItem.ts` (timestamp like `1755800000000`)

Modify:
- `src/data-source.ts` — add `Reservation`, `ReservationItem` to `entities` array
- `src/app.module.ts` — import `ReservationModule`
- `AGENTS.md` — already points to this plan (no change needed), but add a `reservation` line to the Module map if desired
- `tsconfig.json` — only if path aliases needed (usually not)

Do NOT touch: `Inventory` entity, `InventoryService` internals, `Product`, `Order` stub, Redis, RabbitMQ.

---

## 2. Entity definitions (copy-paste ready)

### 2.1 Enum — `src/modules/reservation/entities/reservation-status.enum.ts`

```ts
export enum ReservationStatus {
  RESERVED = 'RESERVED',
  COMPLETED = 'COMPLETED',
  EXPIRED = 'EXPIRED',
  CANCELLED = 'CANCELLED',
}
```

### 2.2 `Reservation` entity — `src/modules/reservation/entities/reservation.entity.ts`

```ts
import {
  Check,
  Column,
  CreateDateColumn,
  Entity,
  Index,
  ManyToOne,
  OneToMany,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';
import { User } from '../../users/entity/user.entity';
import { Order } from '../../order/entities/order.entity';
import { ReservationItem } from './reservation-item.entity';
import { ReservationStatus } from './reservation-status.enum';

@Entity()
@Index(['userId'])
@Index(['status'])
@Index(['expiresAt'])
@Index(['status', 'expiresAt']) // for Phase 5 cleanup query
export class Reservation {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ type: 'uuid' })
  @Index()
  userId!: string;

  @Column({ type: 'uuid', nullable: true })
  @Index()
  orderId!: string | null;

  @Column({
    type: 'enum',
    enum: ReservationStatus,
    default: ReservationStatus.RESERVED,
  })
  status!: ReservationStatus;

  @Column({ type: 'timestamptz' })
  expiresAt!: Date;

  @CreateDateColumn()
  createdAt!: Date;

  @UpdateDateColumn()
  updatedAt!: Date;

  @ManyToOne(() => User, { onDelete: 'CASCADE' })
  user!: User;

  @ManyToOne(() => Order, { nullable: true, onDelete: 'SET NULL' })
  order!: Order | null;

  @OneToMany(() => ReservationItem, (item) => item.reservation, {
    cascade: true,
  })
  items!: ReservationItem[];
}
```

Notes:
- `userId`/`orderId` columns are camelCase in DB (per AGENTS.md DB rules — no snake_case mapping configured).
- `expiresAt` is `NOT NULL`. The service always sets it (default 15m if missing).
- `status` defaults to `RESERVED`.
- Composite index `(status, expiresAt)` is for the future Phase 5 cleanup worker (`WHERE status='RESERVED' AND expiresAt <= NOW()`).

### 2.3 `ReservationItem` entity — `src/modules/reservation/entities/reservation-item.entity.ts`

```ts
import {
  Check,
  Column,
  CreateDateColumn,
  Entity,
  Index,
  ManyToOne,
  PrimaryGeneratedColumn,
  Unique,
  UpdateDateColumn,
} from 'typeorm';
import { Reservation } from './reservation.entity';
import { Inventory } from '../../inventory/entities/inventory.entity';

@Entity()
@Unique(['reservationId', 'inventoryId']) // no duplicate inventory per reservation
@Check('"quantity" > 0')
export class ReservationItem {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ type: 'uuid' })
  @Index()
  reservationId!: string;

  @Column({ type: 'uuid' })
  @Index()
  inventoryId!: string;

  @Column({ type: 'int' })
  quantity!: number;

  @CreateDateColumn()
  createdAt!: Date;

  @UpdateDateColumn()
  updatedAt!: Date;

  @ManyToOne(() => Reservation, (r) => r.items, { onDelete: 'CASCADE' })
  reservation!: Reservation;

  @ManyToOne(() => Inventory, { onDelete: 'CASCADE' })
  inventory!: Inventory;
}
```

Notes:
- `@Unique(['reservationId', 'inventoryId'])` → DB-level guarantee no duplicate inventory line.
- `@Check('"quantity" > 0')` → DB rejects quantity <= 0 (matches DTO `@Min(1)`).
- `inventoryId` references `Inventory.id` (NOT `Product.id`).

---

## 3. DTOs (copy-paste ready)

### 3.1 `CreateReservationDto` — `src/modules/reservation/dto/create-reservation.dto.ts`

```ts
import {
  ArrayMinSize,
  IsArray,
  IsDateString,
  IsInt,
  IsOptional,
  IsUUID,
  Min,
  ValidateNested,
} from 'class-validator';
import { Type } from 'class-transformer';

class ReservationItemDto {
  @IsUUID()
  inventoryId!: string;

  @IsInt()
  @Min(1)
  quantity!: number;
}

export class CreateReservationDto {
  @IsOptional()
  @IsDateString()
  // custom future check done in service; class-validator has no built-in "future"
  expiresAt?: string;

  @IsOptional()
  @IsUUID()
  orderId?: string;

  @IsArray()
  @ArrayMinSize(1)
  @ValidateNested({ each: true })
  @Type(() => ReservationItemDto)
  items!: ReservationItemDto[];
}
```

Important:
- The global `ValidationPipe` has `whitelist` + `forbidNonWhitelisted` + `transform` → only these fields are allowed; unknown fields are rejected.
- Duplicate `inventoryId` within `items` is checked in the service (DTO-level is optional; DB unique is the hard guarantee).
- `expiresAt` future check is done in `ReservationService`, not here.

### 3.2 `UpdateReservationStatusDto` (for complete/cancel) — `src/modules/reservation/dto/update-reservation-status.dto.ts`

Only used for `complete` to optionally attach an `orderId`.

```ts
import { IsOptional, IsUUID } from 'class-validator';

export class UpdateReservationStatusDto {
  @IsOptional()
  @IsUUID()
  orderId?: string;
}
```

### 3.3 `ReservationResponseDto` — `src/modules/reservation/dto/reservation-response.dto.ts`

Use a plain interface or class for the returned shape (no validation needed on output). Example:

```ts
import { ReservationStatus } from '../entities/reservation-status.enum';

export class ReservationResponseDto {
  id!: string;
  userId!: string;
  orderId!: string | null;
  status!: ReservationStatus;
  expiresAt!: Date;
  createdAt!: Date;
  updatedAt!: Date;
  items!: Array<{
    id: string;
    reservationId: string;
    inventoryId: string;
    quantity: number;
  }>;
}
```

(You can also just return the entity with `relations: ['items']`; a DTO class is cleaner for API contracts.)

---

## 4. Service — `src/modules/reservation/reservation.service.ts`

### 4.1 Signature convention (per clarification)

Write methods take `manager: EntityManager` as the FIRST parameter. The controller
will call them inside `dataSource.transaction((manager) => service.create(manager, ...))`.
Read methods (`findById`, `listByUser`) do NOT need a manager — use the repository.

Inject: `DataSource` (for `dataSource.transaction` and `manager.getRepository`) and `Logger`.

```ts
import { BadRequestException, ConflictException, ForbiddenException, NotFoundException, UnauthorizedException } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource, EntityManager } from 'typeorm';
import { Injectable, Logger } from '@nestjs/common';
import { Reservation } from './entities/reservation.entity';
import { ReservationItem } from './entities/reservation-item.entity';
import { ReservationStatus } from './entities/reservation-status.enum';
import { CreateReservationDto } from './dto/create-reservation.dto';
import { UserRoles } from '../users/enum/roles';

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

const DEFAULT_TTL_MS = 15 * 60 * 1000; // 15 minutes

@Injectable()
export class ReservationService {
  private readonly logger = new Logger(ReservationService.name);

  constructor(@InjectDataSource() private readonly dataSource: DataSource) {}

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
    // 1. expiresAt: default or future check
    let expiresAt: Date;
    if (dto.expiresAt) {
      expiresAt = new Date(dto.expiresAt);
      if (isNaN(expiresAt.getTime()) || expiresAt.getTime() <= Date.now()) {
        throw new BadRequestException('expiresAt must be a future timestamp');
      }
    } else {
      expiresAt = new Date(Date.now() + DEFAULT_TTL_MS);
    }

    // 2. orderId optional existence check (404 if not found)
    if (dto.orderId) {
      const orderRepo = manager.getRepository('Order'); // string or Order entity
      const order = await orderRepo.findOne({ where: { id: dto.orderId } });
      if (!order) {
        throw new NotFoundException(`Order ${dto.orderId} not found`);
      }
    }

    // 3. duplicate inventoryId within request
    const seen = new Set<string>();
    for (const item of dto.items) {
      if (seen.has(item.inventoryId)) {
        throw new BadRequestException(
          `Duplicate inventoryId in request: ${item.inventoryId}`,
        );
      }
      seen.add(item.inventoryId);
    }

    // 4. each inventoryId must exist
    const inventoryRepo = manager.getRepository('Inventory'); // or Inventory entity
    for (const item of dto.items) {
      const inv = await inventoryRepo.findOne({ where: { id: item.inventoryId } });
      if (!inv) {
        throw new NotFoundException(`Inventory ${item.inventoryId} not found`);
      }
    }

    // 5. create reservation + items (status RESERVED)
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

    this.logger.log(`Created reservation ${saved.id} for user ${requestingUserId}`);
    return this.findByIdInternal(manager, saved.id);
  }

  private async findByIdInternal(
    manager: EntityManager,
    id: string,
  ): Promise<Reservation> {
    const repo = manager.getRepository(Reservation);
    const reservation = await repo.findOne({
      where: { id },
      relations: ['items'],
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
    const reservation = await repo.findOne({ where: { id }, relations: ['items'] });
    if (!reservation) throw new NotFoundException(`Reservation ${id} not found`);
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

    // admin can filter by userId; non-admin forced to own id
    const where: any = {};
    if (role === UserRoles.Admin && filter?.userId) {
      where.userId = filter.userId;
    } else {
      where.userId = requestingUserId;
    }

    const [data, total] = await repo.findAndCount({
      where,
      relations: ['items'],
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

  async expire(
    manager: EntityManager,
    id: string,
  ): Promise<Reservation> {
    // internal/worker: no owner check
    const repo = manager.getRepository(Reservation);
    const reservation = await repo.findOne({ where: { id } });
    if (!reservation) throw new NotFoundException(`Reservation ${id} not found`);
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
      relations: ['items'],
    });
    if (!reservation) throw new NotFoundException(`Reservation ${id} not found`);
    this.assertOwner(reservation, requestingUserId, role);

    this.validateTransition(reservation.status, to);

    if (orderId) {
      const orderRepo = manager.getRepository('Order');
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
```

Edge cases handled above:
- `expiresAt` past → 400
- duplicate `inventoryId` → 400
- unknown `inventoryId` → 404
- unknown `orderId` → 404
- invalid state transition → 409
- not owner and not admin → 403
- missing reservation → 404

Phase 2 does NOT touch `Inventory.reservedAmount`. That is Phase 3-4.

---

## 5. Controller — `src/modules/reservation/reservation.controller.ts`

Thin: parse → call service inside a transaction (for writes) → return result.

```ts
import { Body, Controller, Get, Param, Patch, Post, Query } from '@nestjs/common';
import { Auth } from '../auth/decorators/auth.decorator';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { UserRoles } from '../users/enum/roles';
import { ReservationService } from './reservation.service';
import { CreateReservationDto } from './dto/create-reservation.dto';
import { UpdateReservationStatusDto } from './dto/update-reservation-status.dto';

@Controller('reservations')
@Auth(UserRoles.User, UserRoles.Admin)
export class ReservationController {
  constructor(private readonly reservationService: ReservationService) {}

  @Post()
  async create(
    @CurrentUser('sub') userId: string,
    @Body() dto: CreateReservationDto,
  ): Promise<Reservation> {
    return this.reservationService.dataSource.transaction((manager) =>
      this.reservationService.create(manager, userId, dto),
    );
  }

  @Get(':id')
  async getOne(
    @CurrentUser('sub') userId: string,
    @CurrentUser('role') role: UserRoles,
    @Param('id') id: string,
  ): Promise<Reservation> {
    return this.reservationService.findById(userId, id, role);
  }

  @Get()
  async list(
    @CurrentUser('sub') userId: string,
    @CurrentUser('role') role: UserRoles,
    @Query('page') page?: string,
    @Query('limit') limit?: string,
    @Query('userId') filterUserId?: string,
  ) {
    return this.reservationService.listByUser(
      userId,
      { page: page ? +page : 1, limit: limit ? +limit : 20 },
      filterUserId ? { userId: filterUserId } : undefined,
      role,
    );
  }

  @Patch(':id/complete')
  async complete(
    @CurrentUser('sub') userId: string,
    @CurrentUser('role') role: UserRoles,
    @Param('id') id: string,
    @Body() dto: UpdateReservationStatusDto,
  ): Promise<Reservation> {
    return this.reservationService.dataSource.transaction((manager) =>
      this.reservationService.complete(manager, userId, id, dto, role),
    );
  }

  @Patch(':id/cancel')
  async cancel(
    @CurrentUser('sub') userId: string,
    @CurrentUser('role') role: UserRoles,
    @Param('id') id: string,
  ): Promise<Reservation> {
    return this.reservationService.dataSource.transaction((manager) =>
      this.reservationService.cancel(manager, userId, id, role),
    );
  }

  @Patch(':id/expire')
  @Auth(UserRoles.Admin)
  async expire(@Param('id') id: string): Promise<Reservation> {
    return this.reservationService.dataSource.transaction((manager) =>
      this.reservationService.expire(manager, id),
    );
  }
}
```

Notes:
- Use the project's real auth wiring: `@Auth(UserRoles.User, UserRoles.Admin)` at class level (open routes) and `@Auth(UserRoles.Admin)` on `expire`; imports `Auth` from `../auth/decorators/auth.decorator` and `CurrentUser` from `../auth/decorators/current-user.decorator`. For `requestingUserId` use `@CurrentUser('sub')` and for role use `@CurrentUser('role')` (matches `cart.controller.ts`). The `User`/`Order`/etc. import paths are relative to `src/modules/reservation/`.
- `expire` is admin-only (`@Auth(UserRoles.Admin)`), matching contracts/reservation-api.md §6. Real periodic expiration is the Phase 5 worker (DB `expiresAt <= NOW()` is authoritative).
- All responses should be the reservation object with `items` (the service already returns `relations: ['items']`).

---

## 6. Module — `src/modules/reservation/reservation.module.ts`

```ts
import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Reservation } from './entities/reservation.entity';
import { ReservationItem } from './entities/reservation-item.entity';
import { ReservationService } from './reservation.service';
import { ReservationController } from './reservation.controller';
import { UsersModule } from '../users/users.module';
import { InventoryModule } from '../inventory/inventory.module';
import { OrderModule } from '../order/order.module';

@Module({
  imports: [
    TypeOrmModule.forFeature([Reservation, ReservationItem]),
    UsersModule,
    InventoryModule,
    OrderModule,
  ],
  controllers: [ReservationController],
  providers: [ReservationService],
  exports: [ReservationService],
})
export class ReservationModule {}
```

Notes:
- If `UsersModule`/`InventoryModule`/`OrderModule` are not needed for TypeORM FK
  metadata, you can drop their imports. But `forwardRef` is NOT needed here because
  those modules are not importing `ReservationModule` back. Keep imports minimal; if
  circular import errors appear, add `forwardRef(() => XModule)` on both sides.
- `exports: [ReservationService]` so Phase 6 Order module can inject it.

---

## 7. Wire into app + data-source

### 7.1 `src/app.module.ts`
Add `ReservationModule` to the `imports: [ ... ]` array (after `InventoryModule`).

### 7.2 `src/data-source.ts`
Add `Reservation` and `ReservationItem` to the `entities: [ ... ]` array so the
migration runner and `synchronize:false` know about them:
```ts
import { Reservation } from './modules/reservation/entities/reservation.entity';
import { ReservationItem } from './modules/reservation/entities/reservation-item.entity';
// ...
entities: [User, Product, Cart, CartItem, Order, OrderItem, Reservation, ReservationItem],
```

---

## 8. Migration — `src/migration/<TIMESTAMP>-CreateReservationAndReservationItem.ts`

Because `synchronize: false`, you MUST write a migration (do not rely on auto-sync).
You can generate it with `npx typeorm migration:create -n CreateReservationAndReservationItem`
then fill `up`/`down`. Minimal `up()`:

```ts
import { MigrationInterface, QueryRunner, Table, TableIndex, TableUnique, TableCheck, TableForeignKey } from 'typeorm';

export class CreateReservationAndReservationItem1755800000000 implements MigrationInterface {
  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`CREATE TYPE "reservation_status" AS ENUM ('RESERVED','COMPLETED','EXPIRED','CANCELLED')`);

    await queryRunner.createTable(new Table({
      name: 'Reservation',
      columns: [
        { name: 'id', type: 'uuid', isPrimary: true, default: 'gen_random_uuid()' },
        { name: 'userId', type: 'uuid', isNullable: false },
        { name: 'orderId', type: 'uuid', isNullable: true },
        { name: 'status', type: 'reservation_status', default: "'RESERVED'" },
        { name: 'expiresAt', type: 'timestamptz', isNullable: false },
        { name: 'createdAt', type: 'timestamptz', default: 'now()' },
        { name: 'updatedAt', type: 'timestamptz', default: 'now()' },
      ],
    }));

    await queryRunner.createTable(new Table({
      name: 'ReservationItem',
      columns: [
        { name: 'id', type: 'uuid', isPrimary: true, default: 'gen_random_uuid()' },
        { name: 'reservationId', type: 'uuid', isNullable: false },
        { name: 'inventoryId', type: 'uuid', isNullable: false },
        { name: 'quantity', type: 'int', isNullable: false },
        { name: 'createdAt', type: 'timestamptz', default: 'now()' },
        { name: 'updatedAt', type: 'timestamptz', default: 'now()' },
      ],
    }));

    // indexes
    await queryRunner.createIndex('Reservation', new TableIndex({ name: 'IDX_reservation_userId', columnNames: ['userId'] }));
    await queryRunner.createIndex('Reservation', new TableIndex({ name: 'IDX_reservation_status', columnNames: ['status'] }));
    await queryRunner.createIndex('Reservation', new TableIndex({ name: 'IDX_reservation_expiresAt', columnNames: ['expiresAt'] }));
    await queryRunner.createIndex('Reservation', new TableIndex({ name: 'IDX_reservation_status_expiresAt', columnNames: ['status','expiresAt'] }));
    await queryRunner.createIndex('ReservationItem', new TableIndex({ name: 'IDX_reservation_item_reservationId', columnNames: ['reservationId'] }));
    await queryRunner.createIndex('ReservationItem', new TableIndex({ name: 'IDX_reservation_item_inventoryId', columnNames: ['inventoryId'] }));

    // unique (reservationId, inventoryId)
    await queryRunner.createUniqueConstraint('ReservationItem', new TableUnique({
      name: 'UQ_reservation_item_reservation_inventory',
      columnNames: ['reservationId', 'inventoryId'],
    }));

    // checks
    await queryRunner.createCheckConstraint('ReservationItem', new TableCheck({
      name: 'CHK_reservation_item_quantity_positive',
      expression: '"quantity" > 0',
    }));

    // FKs
    await queryRunner.createForeignKey('Reservation', new TableForeignKey({
      name: 'FK_reservation_userId', columnNames: ['userId'], referencedTableName: 'User',
      referencedColumnNames: ['id'], onDelete: 'CASCADE',
    }));
    await queryRunner.createForeignKey('Reservation', new TableForeignKey({
      name: 'FK_reservation_orderId', columnNames: ['orderId'], referencedTableName: 'Order',
      referencedColumnNames: ['id'], onDelete: 'SET NULL',
    }));
    await queryRunner.createForeignKey('ReservationItem', new TableForeignKey({
      name: 'FK_reservation_item_reservationId', columnNames: ['reservationId'], referencedTableName: 'Reservation',
      referencedColumnNames: ['id'], onDelete: 'CASCADE',
    }));
    await queryRunner.createForeignKey('ReservationItem', new TableForeignKey({
      name: 'FK_reservation_item_inventoryId', columnNames: ['inventoryId'], referencedTableName: 'Inventory',
      referencedColumnNames: ['id'], onDelete: 'CASCADE',
    }));
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.dropTable('ReservationItem', true);
    await queryRunner.dropTable('Reservation', true);
    await queryRunner.query(`DROP TYPE "reservation_status"`);
  }
}
```

Run: `npm run migration:run` (or `npx typeorm migration:run -d src/data-source.ts`).
Verify: `psql` `\d Reservation` and `\d ReservationItem`.

---

## 9. Tests

### 9.1 Unit — `src/modules/reservation/reservation.service.spec.ts`
Use `Test.createTestingModule` with a mocked `DataSource` whose `transaction` calls
the callback with a fake `manager` that has `getRepository` returning a stub repo.
Test:
- `create` returns RESERVED with items, default expiresAt = now+15m
- `create` rejects past `expiresAt` (400)
- `create` rejects duplicate `inventoryId` (400)
- `create` rejects unknown `inventoryId` (404)
- `transition` (e.g. complete) from RESERVED → COMPLETED succeeds
- `transition` from COMPLETED → CANCELLED throws 409
- `findById` throws 403 when non-owner non-admin
- `validateTransition` throws on invalid

Match the existing spec style (`describe(ReservationService)`, `it('should ...')`).

### 9.2 Integration — `src/modules/reservation/test/reservation.integration.spec.ts`
Use the real `DataSource` / `AppModule` against a real PostgreSQL (docker).
- Insert an Inventory row (use `InventoryService.createForProduct` or direct repo).
- Create a reservation via service inside `dataSource.transaction` → assert DB row + items.
- Assert `quantity = 0` INSERT violates `CHECK` (catch error).
- Assert duplicate `(reservationId, inventoryId)` violates unique (catch error).
- Assert enum rejects invalid status (if tested directly).
- Assert indexes exist (optional: query `pg_indexes`).

Do NOT mock the DB for these (constitution VII). Mock Redis/RabbitMQ only if needed.

---

## 10. Manual verification (quickstart)

After implementation + migration run:
1. `docker-compose up -d` (postgres up)
2. `npm run migration:run`
3. `npm run build`
4. `npm run test`
5. `npm run lint`
6. Start app, register/login, then:
   - `POST /reservations` with `{"items":[{"inventoryId":"<id>","quantity":2}]}` → 201, status RESERVED, expiresAt ~15m ahead
   - `GET /reservations/:id` → 200 with items
   - `GET /reservations` → 200 paginated
   - `PATCH /reservations/:id/complete` → 200 status COMPLETED
   - `PATCH /reservations/:id/cancel` → 409 (already COMPLETED)
   - `POST /reservations` with quantity 0 → 400
   - `POST /reservations` with `expiresAt` in past → 400

---

## 11. Constitution check (must stay PASS)

- I. PostgreSQL source of truth → reservation state in PG, no Redis. ✅
- II. Modular monolith → single `reservation` module, no microservices. ✅
- III. Separate domains + explicit lifecycle → 4 states, transition rules enforced. ✅
- IV. DB-level concurrency → atomic `FOR UPDATE` locking is the Transaction-Safe Reservation milestone (Phase 3); Phase 2 models only, as explicitly permitted by the constitution's milestone order (current target is Phase 1 / representation). No violation; locking is deferred, not a conflict.
- V. Module boundaries → only `ReservationService` mutates; controller thin. ✅
- VI. Spec-driven → spec + clarify done before this plan. ✅
- VII. DB-backed tests → integration tests use real PG. ✅
- VIII. No invented APIs → only fields/routes from spec. ✅
- IX. Docs → AGENTS.md + this plan updated. ✅

---

## 12. Done criteria (Phase 2 exit)

- [ ] `Reservation` + `ReservationItem` entities exist with constraints/indexes
- [ ] Migration created + applied; `data-source.ts` lists both entities
- [ ] `ReservationModule` imported in `app.module.ts`
- [ ] `ReservationService` implements create/findById/listByUser/complete/cancel/expire/validateTransition with `EntityManager` param
- [ ] `ReservationController` exposes POST /reservations, GET /:id, GET /, PATCH /:id/complete, PATCH /:id/cancel, PATCH /:id/expire
- [ ] Auth: owner-or-admin enforced (401/403)
- [ ] State machine enforced (409 on invalid)
- [ ] Validation: quantity>0, expiresAt future, duplicate inventoryId rejected
- [ ] Unit + integration tests pass against real PostgreSQL
- [ ] `npm run lint`, `npm run build`, `npm run test` green

Do NOT implement inventory `reservedAmount` mutation, locking, or expiration worker here.
Those are Phase 3, 4, 5 respectively.
