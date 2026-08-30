# Data Model: Transaction-Safe Reservation (Phase 3)

**Feature**: `003-transaction-safe-reservation` | **Date**: 2026-08-30 | **Spec**: [spec.md](./spec.md) | **Research**: [research.md](./research.md)

Phase 3 introduces **no new tables, columns, or migrations**. It makes the existing Phase 1/2 model concurrency-safe by adding row-level locking + atomic `reservedAmount` mutation to the reservation-creation path.

## 1. Entities (existing, behavior change only)

### 1.1 `Inventory` (`src/modules/inventory/entities/inventory.entity.ts`)

| Field | Type | Constraints | Notes |
|-------|------|-------------|-------|
| `id` | `uuid` PK | `PrimaryGeneratedColumn('uuid')` | |
| `productId` | `uuid` FK → `Product.id` ON DELETE CASCADE | `@Unique(['productId'])`, `@Index(['productId'])` | one-to-one |
| `stock` | `int` default 0 | `@Check("stock" >= 0)` | |
| `reservedAmount` | `int` default 0 | `@Check("reservedAmount" >= 0)`, `@Check("reservedAmount" <= "stock")` | incremented atomically in Phase 3 |
| `createdAt` / `updatedAt` | `timestamptz` | `@CreateDateColumn` / `@UpdateDateColumn` | |

- **Derived**: `get available(): number { return stock - reservedAmount; }` — never persisted, never accepted from client. Availability check MUST read `stock`/`reservedAmount` from the locked row and compute `available` in memory (spec FR-004, research D3).
- **Locking**: Every `Inventory` row referenced by a reservation request is acquired with `SELECT ... FOR UPDATE` (`pessimistic_write`) inside the creating transaction, in deterministic `inventoryId`-sorted order (FR-003/D2). Only requested rows are locked (FR-005).

**State transitions on creation (this phase)**:
```
before: stock=S, reserved=R, available=S-R
on reservation create (qty=q, available>=q): reserved = R + q
available' = S - (R+q) = (S-R) - q
```
`stock` unchanged; `reservedAmount` monotonically increases until Phase 4 release (`cancel`/`expire`/`complete`).

### 1.2 `Reservation` (`src/modules/reservation/entities/reservation.entity.ts`)

| Field | Type | Constraints | Notes |
|-------|------|-------------|-------|
| `id` | `uuid` PK | | |
| `userId` | `uuid` FK → `User.id` ON DELETE CASCADE | `@Index(['userId'])`, `@Index()` | owner |
| `orderId` | `uuid` nullable FK → `Order.id` ON DELETE SET NULL | `@Index(['orderId'])` | stays NULL in Phase 3 |
| `status` | `enum RESERVED|COMPLETED|EXPIRED|CANCELLED` | default `RESERVED` | Phase 3 only creates `RESERVED`; lifecycle transitions remain status-only until Phase 4 |
| `expiresAt` | `timestamptz` NOT NULL | | default `now+15m` if omitted; future check before tx |
| `createdAt` / `updatedAt` | `timestamptz` | | |

- **Indexes**: `@Index(['status'])`, `@Index(['expiresAt'])`, composite `@Index(['status','expiresAt'])` for Phase 5 cleanup — unchanged.
- **Creation**: Inserted only after all locks + availability checks + `reservedAmount` increments succeed, inside the same transaction. On any failure (insufficient `available`, unknown FK, duplicate, DB CHECK), transaction rolls back and no `Reservation` row persists (FR-001/SC-005).

### 1.3 `ReservationItem` (`src/modules/reservation/entities/reservation-item.entity.ts`)

| Field | Type | Constraints | Notes |
|-------|------|-------------|-------|
| `id` | `uuid` PK | | |
| `reservationId` | `uuid` FK → `Reservation.id` ON DELETE CASCADE | `@Index()`, part of `@Unique(['reservationId','inventoryId'])` | |
| `inventoryId` | `uuid` FK → `Inventory.id` ON DELETE CASCADE | `@Index()` | |
| `quantity` | `int` | `@Check('"quantity" > 0')` | `>0` validated by DTO `@Min(1)` and DB `CHECK` |
| `createdAt` / `updatedAt` | `timestamptz` | | |

- **Unique**: `@Unique(['reservationId','inventoryId'])` prevents duplicate inventory line within one reservation (duplicate payload rejected `400` before locking; DB constraint is the safety net).
- **Insert**: One row per `dto.items[i]` after increments, via `manager.getRepository(ReservationItem).save(...)` inside the transaction.

## 2. Relationships

```
Inventory 1 ── * ReservationItem * ── 1 Reservation * ── 1 User
                                    └─ 0..1 Order (nullable)
```

- `Reservation 1 — * ReservationItem — 1 Inventory` (spec FR-003 analogue, now with atomic creation).
- Fetch uses `relations: { items: true }` (or `leftJoinAndSelect`) to avoid N+1; no new relations.

## 3. Validation Rules (enforced before or inside the transaction)

| Rule | Where | Error | Phase |
|------|-------|-------|-------|
| `items` array `>=1`, each `inventoryId` valid UUID, `quantity` int `>=1` | DTO `CreateReservationDto` via global `ValidationPipe` | `400` | Phase 2 (unchanged) |
| No duplicate `inventoryId` within request | Service `seen` Set, before locking | `400` | Phase 2 (unchanged) |
| `expiresAt`, if supplied, is future timestamp; else default `now+15m` | Service, before locking | `400` | Phase 2 (unchanged) |
| `orderId`, if supplied, references existing `Order` | `manager.getRepository(Order).findOne` inside tx | `404` | Phase 2 (unchanged) |
| Each `inventoryId` references existing `Inventory` | `manager.findOne(Inventory)` after locking (or before) | `404` | Phase 2 (unchanged) |
| `available >= requested_quantity` per item (on locked row) | Service after `FOR UPDATE` | `409` | **Phase 3 new** |
| `reservedAmount <= stock` (DB CHECK) | DB, inside tx | `409` (mapped) | existing, now surfaces via tx |

## 4. Transaction Model

```
Controller:
  dataSource.transaction(async manager => service.create(manager, userId, dto))

Service.create(manager, ...):
  1. validate expiresAt / duplicate / orderId existence (fast fail)
  2. sortedIds = [...dto.items.map(i=>i.inventoryId)].sort()
  3. lockedRows = await manager.find(Inventory, {
       where: { id: In(sortedIds) },
       lock: { mode: 'pessimistic_write' }
     })
     // verify all requested ids were found; else 404
     // build Map<inventoryId, Inventory> from locked rows
  4. for each item in dto.items (order irrelevant — lock order already sorted):
       inv = map.get(item.inventoryId)
       if inv.available < item.quantity → throw ConflictException (rollback)
  5. for each item:
       inv.reservedAmount += item.quantity
       await manager.save(Inventory, inv)   // still inside tx, still locked
  6. reservation = manager.create(Reservation, { userId, orderId, status: RESERVED, expiresAt })
     saved = await manager.save(Reservation, reservation)
  7. items = dto.items.map(i => manager.create(ReservationItem, { reservationId: saved.id, inventoryId: i.inventoryId, quantity: i.quantity }))
     await manager.save(ReservationItem, items)
  8. return manager.findOne(Reservation, { where: { id: saved.id }, relations: { items: true } })
```

- On any thrown `BadRequest/NotFound/Conflict`, TypeORM rolls back the transaction; no partial `reservedAmount` or `Reservation` persists.
- No external I/O (Redis/RabbitMQ/BullMQ/email) inside steps 3-7.

## 5. Indexes & Constraints (no change)

Already present via Phase 1/2 migrations; reused:

- `Inventory`: `@Check stock>=0`, `@Check reservedAmount>=0`, `@Check reservedAmount<=stock`, `UQ_inventory_productId`, `IDX productId`
- `Reservation`: `IDX userId`, `IDX status`, `IDX expiresAt`, `IDX status+expiresAt`
- `ReservationItem`: `UQ (reservationId,inventoryId)`, `CHECK quantity>0`, `IDX reservationId`, `IDX inventoryId`, FKs `reservationId→Reservation CASCADE`, `inventoryId→Inventory CASCADE`

## 6. No New Migrations

`A8` in spec: Phase 3 uses existing `Inventory`/`Reservation`/`ReservationItem`; no DDL. `synchronize: false` remains; existing Phase 2 migration `1755850000000-CreateReservationAndReservationItem` is load-bearing.

## 7. Test Data Shape

- Seed inventories via `InventoryService.createForProduct` or direct `manager.save(Inventory, {productId, stock, reservedAmount})`.
- Use at least two inventories for deadlock-ordering test (opposite payload order).
- Concurrency fixture: `stock=10, reservedAmount=8, available=2` for the critical `qty=2 vs qty=2` test.
