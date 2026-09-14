# Data Model — Reservation Lifecycle (Phase 4)

**Branch**: `004-reservation-lifecycle` | **Date**: 2026-09-14 | **Spec**: [spec.md](./spec.md) | **Plan**: [plan.md](./plan.md)

No new tables/columns/indexes in Phase 4. Model reuses Phase 1-3 entities; this document defines the lifecycle transaction shape, validation, and Q&A integration points.

---

## 1. Entities (existing, unchanged schema)

### Inventory (`src/modules/inventory/entities/inventory.entity.ts`)

```text
Inventory {
  id: uuid PK
  productId: uuid FK Product.id ON DELETE CASCADE, UNIQUE, INDEX
  stock: int default 0, CHECK stock>=0
  reservedAmount: int default 0, CHECK reservedAmount>=0, CHECK reservedAmount<=stock
  createdAt: timestamptz, updatedAt: timestamptz
  derived: available = stock - reservedAmount
}
```

- Mutations in this phase:
  - `COMPLETED`: `stock -= qty; reservedAmount -= qty` per item (FR-002)
  - `CANCELLED` / `EXPIRED`: `reservedAmount -= qty` per item, `stock` unchanged (FR-003)
- Locks: `FOR UPDATE` on each referenced `Inventory` row in `sortedIds` order (D2), inside `EntityManager` transaction.
- Backstop: DB `CHECK`s; violation → rollback `409` per Q2 (D4).

### Reservation (`src/modules/reservation/entities/reservation.entity.ts`)

```text
Reservation {
  id: uuid PK
  userId: uuid FK User.id ON DELETE CASCADE, INDEX
  orderId: uuid nullable FK Order.id ON DELETE SET NULL, INDEX nullable
  status: enum RESERVED|COMPLETED|EXPIRED|CANCELLED default RESERVED, INDEX
  expiresAt: timestamptz, INDEX + composite INDEX (status, expiresAt)
  createdAt, updatedAt
  items: ReservationItem[] OneToMany cascade
}
```

- Status lifecycle in this phase: `RESERVED -> COMPLETED|CANCELLED|EXPIRED` only (FR-004). Idempotent exception: `COMPLETED -> COMPLETED` returns `200` (Q4), others `409`. Service also supports `COMPLETED` idempotent detection after `FOR UPDATE` lock.
- Locks: `FOR UPDATE` on `Reservation` row before status check (FR-001, D1) to serialize concurrent `complete/cancel/expire`.

### ReservationItem (`src/modules/reservation/entities/reservation-item.entity.ts`)

```text
ReservationItem {
  id: uuid PK
  reservationId: uuid FK Reservation.id ON DELETE CASCADE, INDEX
  inventoryId: uuid FK Inventory.id, INDEX
  quantity: int, CHECK quantity>0, UNIQUE (reservationId, inventoryId)
}
```

- `quantity` is the source of truth for inventory delta; lifecycle reads items from locked `Reservation` (`relations:{items:true}`), not client payload (FR-009).

### Order (read-only in this phase)

```text
Order { id: uuid PK, userId: uuid, status, total, ... } // existing src/modules/order/entities/order.entity.ts
```

- Only `manager.getRepository(Order).findOne({where:{id:orderId}})` existence check on `complete` (FR-002, Q3). Overwrite semantics: supplied `orderId` always overwrites `Reservation.orderId` (Q3 A). `404` if order not found → rollback.

---

## 2. Transaction Model (per FR-001)

```
BEGIN                      // dataSource.transaction(manager => service.*(manager,...))
  lock Reservation FOR UPDATE by id
  assertOwner(reservation, requestingUserId, role) → 403 if fail
  validateTransition(from -> to) → 409 if invalid
    exception: if from==COMPLETED && to==COMPLETED → return 200 idempotent (no mutation, no locks on inventories)
  if to==COMPLETED && dto.orderId → verify Order exists → 404 if not
  load items = reservation.items (already with lock context) or re-load with relations
  sortedIds = [...new Set(items.map(i=>i.inventoryId))].sort()  // D2
  lock Inventories FOR UPDATE where id IN (sortedIds)
    if missing → 404
  for each item:
    to==COMPLETED: inv.stock -= qty; inv.reservedAmount -= qty
    to==CANCELLED|EXPIRED: inv.reservedAmount -= qty   // stock unchanged
    manager.getRepository(Inventory).save(inv)  // still inside lock
  reservation.status = to
  if to==COMPLETED && dto.orderId: reservation.orderId = dto.orderId // Q3 overwrite
  manager.getRepository(Reservation).save(reservation)
COMMIT // or ROLLBACK on any throw, no partial state
```

- Controller wraps in `dataSource.transaction` already (`reservation.controller.ts:65,76,84`); service uses `manager.getRepository(...)` per D7.
- Manual `expire` in this phase bypasses `expiresAt <= NOW()` (Q1 A → D3); worker Phase 5 will query `status='RESERVED' AND expiresAt<=NOW()` then reuse same service method.
- Keep transaction D8-short, no Redis/RabbitMQ/Email.

## 3. Validation & Error Table

| Condition | Check Location | Error | Inventory Effect | Status Effect |
|-----------|---------------|-------|------------------|---------------|
| `validateTransition(from!=RESERVED)` except idempotent `COMPLETED→COMPLETED` | inside `FOR UPDATE` Reservation lock | `409 ConflictException("Invalid reservation transition: RESERVED -> X")` | none | none |
| `COMPLETED→COMPLETED` retry | before or after lock on status==COMPLETED && to==COMPLETED | `200` idempotent success, return entity | none | none (stay COMPLETED) |
| `assertOwner` fails (non-owner non-admin) | after lock Reservation | `403 ForbiddenException` | none | none |
| `orderId` supplied not found | before inventory locks | `404 NotFoundException("Order ...")` | none | none |
| `Inventory` missing (deleted) | after `FOR UPDATE` Inventory lock, `length != sortedIds.length` | `404 Inventory <id> not found` | none (rollback) | none |
| `reservedAmount - qty < 0` or `stock - qty < 0` hits `@Check` | `manager.save(Inventory)` inside tx | caught `QueryFailedError` → rethrow `409 Conflict` | rollback | rollback |
| `COMPLETED→CANCELLED` / other invalid terminal | `validateTransition` | `409` | none | none |
| Non-admin `PATCH /:id/expire` | `Auth(User,Admin)` guard on controller | `403` | none | none |

## 4. Indexes / Constraints (existing, no new DDL)

- `Reservation`: `@Index(['userId'])`, `@Index(['status'])`, `@Index(['expiresAt'])`, `@Index(['status','expiresAt'])` — used by Phase 5 scanner, unchanged.
- `ReservationItem`: `@Index(['reservationId'])`, `@Index(['inventoryId'])`, `@Unique(['reservationId','inventoryId'])`, `@Check quantity>0`.
- `Inventory`: `@Index(['productId'])`, `@Unique(['productId'])`, `@Check stock>=0`, `@Check reservedAmount>=0`, `@Check reservedAmount<=stock`.
- No new migration expected (D10); if a needed index/lock is proven missing, add via `src/migration/` and set `synchronize:false`.

## 5. Clarification Integration Points (Q1-Q5)

| Q | Spec Clarification | Data-Model Impact |
|---|-------------------|-------------------|
| Q1 | Manual expire immediate override | `expire` method does **not** read or compare `expiresAt`; time gate is worker's query, not service's |
| Q2 | No `stock>=qty` service check | No pre-check branching; rely on `@Check stock>=0` — error mapped to `409` |
| Q3 | `orderId` always overwrites | `transition` overwrites `reservation.orderId = dto.orderId` after existence check even if prior not null |
| Q4 | `COMPLETED→COMPLETED` idempotent `200` | Branch before `validateTransition` or special-case after lock; no inventory Save path |
| Q5 | `CANCELLED→CANCELLED` / `EXPIRED→EXPIRED` remain `409` | No idempotent branch for those; `validateTransition` rejects |

## 6. Invariants Preserved

- `stock >=0` & `reservedAmount >=0` & `reservedAmount <= stock` at commit (DB `CHECK`).
- `available = stock - reservedAmount` derived.
- `quantity >0` per `ReservationItem`.
- Only one terminal transition per reservation mutates inventory (single-winner `FOR UPDATE` + SC-005 guarantee).
