# Data Model: Order Completion / Sale (Phase 7)

**Branch**: `008-order-completion-sale` | **Date**: 2026-09-22 | **Spec**: [spec.md](./spec.md) | **Plan**: [plan.md](./plan.md)

No new PostgreSQL tables or migrations in Phase 7. All entities reuse Phase 6 schema; Phase 7 adds a transactional state transition `CompleteOrderTransaction` (not a table) and a DTO/state helper.

---

## 1. Existing Entities (unchanged schema, new behavior)

### 1.1 `Order` (`src/modules/order/entities/order.entity.ts`)

```text
Order
-----
id              uuid PK @PrimaryGeneratedColumn('uuid')
userId          uuid FK → User.id ON DELETE CASCADE @Index(['userId']) @Column({ type: 'uuid' })
status          enum OrderStatus { PENDING, COMPLETED, CANCELLED, FAILED } default PENDING @Index(['status']) @Column({ type:'enum', enum:OrderStatus })
total           int CHECK "total" >= 0 @Column({ type:'int', default:0 })
created_at      timestamptz @CreateDateColumn
updated_at      timestamptz @UpdateDateColumn

relations: ManyToOne User (JoinColumn userId), OneToMany OrderItem (cascade:true)
indexes: @Index(['userId']), @Index(['status'])
constraints: @Check("total" >= 0)
```

**Phase 7 lifecycle delta** (no column change):

- Allowed transitions: `PENDING→COMPLETED` (new sale path), `PENDING→CANCELLED` (existing worker), `PENDING→FAILED` (defined guard, not exercised), `COMPLETED→COMPLETED` idempotent `200`.
- Invalid: `COMPLETED→*` (except idempotent), `CANCELLED→COMPLETED`, `FAILED→COMPLETED` → `409 Conflict`.
- Helper: `validateOrderTransition(from: OrderStatus, to: OrderStatus): void` in `OrderService` or `OrderCompletionService` (mirrors `ReservationService.validateTransition`/`ALLOWED_TRANSITIONS`), throws `ConflictException` on invalid.

### 1.2 `OrderItem` (`src/modules/order/entities/order-items.entity.ts`)

```text
OrderItem
---------
id                  uuid PK
orderId             uuid FK → Order.id ON DELETE CASCADE @Index @Column
productId           uuid FK → Product.id ON DELETE RESTRICT @Index @Column
quantity            int CHECK "quantity" > 0 @Column
unit_price          int CHECK "unit_price" >= 0 @Column({ name:'unit_price' }) — snapshot of Product.price at checkout, never mutated
productNameSnapshot varchar nullable
subtotal            int STORED GENERATED AS (quantity * unit_price) nullable — DB computed, not client-supplied

relations: ManyToOne Order (JoinColumn orderId), ManyToOne Product (JoinColumn productId, RESTRICT)
constraints: @Unique(['orderId','productId']), @Check("quantity">0), @Check("unit_price">=0), @Index(['orderId']), @Index(['productId'])
```

**Phase 7 delta**: **Not mutated** on completion (historical isolation, FR-007). Completion uses `ReservationItem.inventoryId/quantity` for inventory math, not `OrderItem.productId` indirection.

### 1.3 `Inventory` (`src/modules/inventory/entities/inventory.entity.ts`)

```text
Inventory
---------
id              uuid PK
productId       uuid FK → Product.id ON DELETE CASCADE @Unique @Index
stock           int CHECK "stock" >= 0
reservedAmount  int CHECK "reservedAmount" >= 0, CHECK "reservedAmount" <= "stock"
available       derived getter `stock - reservedAmount` (not stored mutably)

constraints: @Unique(['productId']), @Check stock>=0, reserved>=0, reserved<=stock
```

**Phase 7 arithmetic** (FR-003):

- On completion per `ReservationItem { inventoryId, quantity }`:

  ```text
  inventory.stock -= quantity
  inventory.reservedAmount -= quantity
  // so available = (stock - qty) - (reserved - qty) = stock - reserved = unchanged
  // example: stock10 reserved3 avail7 → stock7 reserved0 avail7 (Phase 4 §4.2)
  ```

- Applied **once** per successful `PENDING→COMPLETED`; idempotent retry skips mutation.
- Backstop: DB `CHECK`s; violation `23514`/`CHK_inventory_*` → `409`.

### 1.4 `Reservation` + `ReservationItem` (`src/modules/reservation/entities/`)

```text
Reservation
-----------
id          uuid PK
userId      uuid FK → User ON DELETE CASCADE @Index(['userId'])
orderId     uuid nullable FK → Order ON DELETE SET NULL @Index
status      enum ReservationStatus { RESERVED, COMPLETED, EXPIRED, CANCELLED } default RESERVED @Index(['status']), composite @Index(['status','expiresAt'])
expiresAt   timestamptz
createdAt / updatedAt timestamptz

ReservationItem
---------------
id              uuid PK
reservationId   uuid FK → Reservation ON DELETE CASCADE @Index
inventoryId     uuid FK → Inventory ON DELETE CASCADE @Index
quantity        int CHECK >0
constraints: @Unique(['reservationId','inventoryId']), @Check quantity>0
```

**Phase 7 delta**:

- Transition `RESERVED→COMPLETED` via Order completion (same inventory math as §1.3), co-committed with `Order COMPLETED`.
- `COMPLETED→COMPLETED` idempotent `200` already exists (`reservation.service.ts:386`); Order path reuses `validateTransition(RESERVED,COMPLETED)`.
- Lookup for completion: `SELECT Reservation WHERE orderId=:orderId FOR UPDATE` (not outer join); missing → `404`.

### 1.5 `Product` (unchanged, price snapshot source)

```text
Product { id uuid PK, name @Unique, slug, description, price int CHECK >=0 }
```

No `stock` field (removed Phase 1). `Product.price` is snapshot source at checkout only; completion never reads it.

---

## 2. New/Refined Models (not tables)

### 2.1 `CompleteOrderDto` (`src/modules/order/dto/complete-order.dto.ts`)

```text
CompleteOrderDto
----------------
(no fields)
validation: global ValidationPipe whitelist + forbidNonWhitelisted + transform
→ any extra field (paymentId, amount, items[], reservationId) → 400
```

Empty DTO like `CheckoutDto` (Phase 6) — keeps controller thin and prevents `paymentId` invention.

### 2.2 `CompleteOrderTransaction` (ephemeral, DataSource.transaction scope)

Not a table. Pseudocode contract (`OrderCompletionService.complete`):

```text
Input: manager: EntityManager (caller's tx), requestingUserId: string, orderId: string, role: UserRoles

1. Lock Order FOR UPDATE: manager.findOne(Order, { where:{id:orderId}, lock:{mode:'pessimistic_write'} })
   → 404 if missing; assertOwner(order, requestingUserId, role) → 403

2. Idempotent: if order.status === COMPLETED && to === COMPLETED → return enriched Order (no inventory change)

3. validateOrderTransition(order.status, COMPLETED) → 409 if invalid (COMPLETED→*, CANCELLED→COMPLETED, FAILED→COMPLETED)

4. Lock Reservation FOR UPDATE: manager.findOne(Reservation, { where:{orderId}, lock:{mode:'pessimistic_write'} })
   → 404 if missing; validateTransition(RESERVED, COMPLETED) via ReservationService → 409

5. If reservation.items empty → save Order COMPLETED + Reservation COMPLETED (edge, log)

6. sortedIds = [...new Set(reservation.items.map(i=>inventoryId))].sort()

7. Lock Inventories FOR UPDATE: manager.find(Inventory, { where:{ id: In(sortedIds)}, lock:{mode:'pessimistic_write'} })
   → 404 if any missing; inventoryMap

8. For each item: inventory.stock -= qty; inventory.reservedAmount -= qty; manager.save(inventory) (catch 23514/CHK → 409)

9. reservation.status = COMPLETED; order.status = COMPLETED; manager.save both

10. Commit (caller owns); rollback on any 403/404/409/500 → no partial stock/reserved/order
```

Invariants enforced: `stock>=0`, `reservedAmount>=0`, `reservedAmount<=stock`, `Order.total>=0` unchanged, `OrderItem.unit_price` unchanged, `available` unchanged by pair.

### 2.3 `ALLOWED_ORDER_TRANSITIONS` (constant)

```text
ALLOWED_ORDER_TRANSITIONS = {
  PENDING:   [COMPLETED, CANCELLED, FAILED],
  COMPLETED: [COMPLETED], // idempotent only
  CANCELLED: [],
  FAILED:    [],
}
COMPLETED→COMPLETED is short-circuited as idempotent 200 before validate; others in map enforce 409.
```

---

## 3. Relationships & Indexes (Phase 7 reuse, no new index unless EXPLAIN proves needed)

```text
User 1──∞ Order (FK userId CASCADE, Index userId) 1──∞ OrderItem (Unique orderId+productId, Index orderId)
Order 1──1 Reservation (FK orderId SET NULL, Index orderId) 1──∞ ReservationItem (Unique reservationId+inventoryId)
Product 1──1 Inventory (Unique productId) ; ReservationItem ∞──1 Inventory (FK inventoryId)
Reservation composite @Index(['status','expiresAt']) for worker; Inventory PK for lock.
```

If `EXPLAIN` for `SELECT Reservation WHERE orderId=:orderId FOR UPDATE` shows seq scan, add `@Index(['orderId'])` already present (`reservation.entity.ts:29`).

---

## 4. Validation Rules (from FRs)

- DTO `CompleteOrderDto`: empty, `forbidNonWhitelisted` → extra fields `400`.
- Service: `quantity` is `Number.isInteger && >0` already enforced by `ReservationItem` CHECK; no new quantity input.
- `Order.total >=0` CHECK unchanged; completion never mutates total.
- `Inventory.stock/reservedAmount` CHECKs remain authoritative; service maps `23514` to `409`.
- `OrderStatus` enum via `validateOrderTransition`; `ReservationStatus` via existing `validateTransition`.

---

## 5. State Diagrams

```text
Order:     PENDING ──complete──▶ COMPLETED  (idempotent COMPLETED→COMPLETED 200)
           PENDING ──expire───▶ CANCELLED  (worker RESERVED→EXPIRED, existing)
           PENDING ──fail────▶ FAILED     (guard defined, not exercised)
           CANCELLED/FAILED/COMPLETED ──complete──▶ 409 (invalid)

Reservation (checkout-linked): RESERVED ──complete──▶ COMPLETED
                              RESERVED ──expire───▶ EXPIRED (→Order CANCELLED)
                              COMPLETED→COMPLETED idempotent (existing)
```

---

## 6. No Migration

Phase 7 requires **0 migrations**. If a future `FAILED` endpoint needs `FAILED` enum already present (it is since Phase 6 migration `17xxxxx-OrderIntegrationCheckoutOnly`), no ALTER needed. Keep `synchronize:false`.
