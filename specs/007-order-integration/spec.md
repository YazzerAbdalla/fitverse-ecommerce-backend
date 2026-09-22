# Feature Specification: Order Integration

**Feature Branch**: `007-order-integration`  
**Created**: 2026-09-21  
**Status**: Draft  
**Input**: User description: "start phase 6"  
**Source**: `docs/plan.md` Phase 6 — Order Integration (§§6.1-6.4), `docs/architecture/inventory-reservation.md`, constitution I/III/IV/V, existing `src/modules/order` stub + `src/modules/cart` + `src/modules/inventory` + `src/modules/reservation` + `src/modules/products`

---

## 1. Overview

Phases 1-5 established inventory as a first-class domain (`stock`, `reservedAmount`, `available = stock - reservedAmount`, DB CHECKs), product/inventory separation, reservation domain (`Reservation` + `ReservationItem`, `RESERVED|COMPLETED|EXPIRED|CANCELLED`, `validateTransition`), transaction-safe creation (`FOR UPDATE` sorted inventories, `available` check) and lifecycle (`RESERVED→COMPLETED` `stock-=qty` `reserved-=qty`, `RESERVED→CANCELLED/EXPIRED` `reserved-=qty` only, single-winner races, idempotent `COMPLETED→COMPLETED`, and automated expiration worker `status=RESERVED AND expiresAt<=NOW()` with BullMQ repeat 30s and `EXPIRATION_MAX_RETRIES=3`).

The cart module validates `inventory.available` optimistically when adding items but **never mutates inventory** — per `docs/plan.md` the cart is not authoritative for reservation (constitution I). The order module is a **stub** (`OrderService` returns placeholder strings, `CreateOrderDto` empty, `GET /order` only checks auth, no `POST /order/checkout`, relations `Order.order_items` are `ManyToMany` with `@JoinTable` which is incorrect).

This feature connects cart → reservation → order atomically. It answers the unresolved requirement `docs/plan.md` §6.4 `When does inventory become reserved?` — the decision for Phase 6 V1 is **C. When order is created (inside the checkout transaction)**. Adding items to cart (A) does not reserve; checkout starting (B) is the same transaction as order creation but the authoritative moment is the single `DataSource.transaction` that locks inventories → reserves → creates order + items → creates reservation → clears cart. The transaction boundary is the Phase 6 spec decision.

Historical price is frozen at checkout: `OrderItem.unit_price = Product.price` read inside the transaction; later `Product.price` changes do not affect existing orders.

The goal is the Phase 6 exit criterion: a successful checkout produces a consistent `Order` + `OrderItems` + `Reservation` + `Inventory` state that is observable via the new REST contract.

### Goal

A successful checkout produces a consistent Order + OrderItems + Reservation + Inventory state. — `docs/plan.md` Phase 6 Exit Criteria.

---

## 2. User Scenarios & Testing

### User Story 1 — Checkout creates Order + OrderItems + Reservation atomically (Priority: P1)

An authenticated shopper has a cart with 2 products (`P-A price 100` qty 2, `P-B price 50` qty 1, backed by `Inventory A stock=10 reserved=0`, `B stock=5 reserved=0`). The shopper calls `POST /order/checkout` (or `POST /order` with checkout semantics). The system validates the cart is non-empty, re-checks `available` authoritatively inside a transaction, snapshots `unit_price` from `Product.price`, creates an `Order` (`PENDING`, `total = 2*100 + 1*50 = 250`), creates 2 `OrderItems` (`qty`/`unit_price`/`productId`), creates a `Reservation` (`RESERVED`, `expiresAt=now+15m`, items linking same inventories, `orderId` set), increments `Inventory.reservedAmount` (`A +2`, `B +1`), and clears the cart — all in one commit. On success the shopper receives the order with items and reservation id.

**Why this priority**: This is the Phase 6 exit criterion. Without it there is no durable order and no reservation linkage; downstream phases 7-8 (completion/cancellation) have nothing to act on.

**Independent Test**: Seed 2 products + inventories, create user, `POST /cart/items` for both products, `GET /cart` shows 2 items, `POST /order/checkout` → `201` with `{ order: { id, status: PENDING, total:250, items:[{productId,quantity:2,unitPrice:100},{quantity:1,unitPrice:50}], reservationId } }`, `GET /order/:id` returns same `total` and items, `GET /reservations/:id` shows `RESERVED` with `orderId = order.id`, inventories show `reservedAmount` incremented, `GET /cart` now empty. Change `Product.price` to 999 and assert the order's `unit_price` remains 100/50.

**Acceptance Scenarios**:

1. **Given** cart `[{A qty2},{B qty1}]` with `A stock10 reserved0 price100`, `B stock5 reserved0 price50`, **When** shopper `POST /order/checkout`, **Then** `Order.status=PENDING`, `Order.total=250`, 2 `OrderItems` with `unit_price` 100/50, `Reservation.status=RESERVED` with `orderId=Order.id` and `qty` matching OrderItems, `A.reservedAmount=2` `B.reservedAmount=1`, cart emptied, all persisted in one transaction.
2. **Given** same cart, **When** `Product A price` is updated from 100 to 999 after creation but before checkout read, **Then** `OrderItem.unit_price=999` (new price is snapshotted); if updated **after** checkout commit, existing `OrderItem.unit_price` stays 100 (historical).
3. **Given** empty cart, **When** shopper `POST /order/checkout`, **Then** `400 Bad Request "Cart is empty"` and no `Order`/`Reservation`/`Inventory` mutation.
4. **Given** cart `A qty3` but `A stock10 reserved9 available1`, **When** checkout, **Then** `409 Conflict "Insufficient available inventory"` and no side effects (rollback).

---

### User Story 2 — Concurrent checkout race: single winner on last unit (Priority: P1)

Two shoppers (or two sessions of same user with separate carts) race to checkout the last available unit. Inventory correctness relies on `FOR UPDATE` locking.

**Why this priority**: Constitution IV (no overselling). Phase 3 proved single-winner for reservation creation; checkout must preserve the same guarantee when `Order`+`Reservation` are created together. Double success would oversell.

**Independent Test**: `A stock10 reserved9 available1`, User1 cart `A qty1`, User2 cart `A qty1`, fire `Promise.all([checkout(user1), checkout(user2)])` via `dataSource.transaction` with real PostgreSQL `--runInBand`, assert exactly one `201` and one `409`, after settlement exactly one `Order`+`Reservation` exists, `A.reservedAmount=10`, `A.stock=10`, the loser has empty or still-filled cart but no order.

**Acceptance Scenarios**:

1. **Given** `A available=1` and two carts requesting `A qty1`, **When** both `POST /order/checkout` concurrently, **Then** one succeeds `201` (order + reservation, `reservedAmount 9→10`) and the other fails `409`, `reservedAmount` incremented exactly once and never exceeds `stock`.
2. **Given** `A available=2` and two checkout requests `A qty2` vs `A qty1` racing, **When** `qty2` wins commit first, **Then** second fails `409` (1 remaining < 1? actually 0 remaining); if `qty1` wins first then `qty2` fails — ordering is deterministic via inventory lock order, not random.
3. **Given** checkout with items `A qty1 + B qty2` where `A` is contended but `B` is not, **When** races happen, **Then** contention on `A` alone determines winner; `B` is locked in sorted order `[...ids].sort()` to avoid deadlock when requests arrive in opposite item order.
4. **Given** a checkout retry after `409`, **When** shopper removes unavailable quantity and retries with `A qty1` where `available` is now 0, **Then** second retry still `409` until inventory released via cancellation/expiration.

---

### User Story 3 — Order retrieval, pagination, and ownership (Priority: P2)

A shopper can list and fetch their orders; admin can inspect any order. Orders are always read with items and computed total.

**Why this priority**: P2 because viewing is secondary to creating correctly, but production checkout is incomplete without read-back and admin audit. Uses existing pagination shape `{ data, meta:{ totalItems, itemCount, itemsPerPage, totalPages, currentPage } }`.

**Independent Test**: Create 3 orders via checkout for user U1, `GET /order?page=1&limit=2` as U1 returns 2 with meta, `GET /order/:id` as owner returns full items, as other user U2 returns `403`, as admin `Auth(UserRoles.Admin)` returns any user's order.

**Acceptance Scenarios**:

1. **Given** U1 has 3 orders, **When** `GET /order` with `page=1 limit=2` as U1, **Then** `data.length=2`, `meta.totalItems=3`, `meta.totalPages=2`, ordered `created_at DESC`.
2. **Given** order O belongs to U1, **When** U1 `GET /order/:id` or admin, **Then** `200` with `Order` + `order_items` (productId, quantity, unit_price) and `reservationId`; when U2 (non-admin, non-owner) requests same id, **Then** `403 Forbidden` (or `404` if policy is to hide existence — clarify in plan, default 403).
3. **Given** `Product A price` changed after orders created, **When** fetching old orders, **Then** each `OrderItem.unit_price` still reflects snapshot price, not current product price.
4. **Given** no orders exist, **When** `GET /order`, **Then** `data=[]` empty pagination.

---

### Edge Cases

- What happens when cart is empty at checkout? → `400 Cart is empty`, no DB write.
- What happens when cart contains a product whose `Inventory` row was deleted concurrently? → Inside transaction `SELECT … FOR UPDATE` fails to find row → `404 Inventory <id> not found`, whole checkout rolls back.
- What happens when one `OrderItem.quantity` is 0 or negative? → DTO `@IsInt() @Min(1)` rejects with `400` before transaction; service also validates `Number.isInteger` + `>0`.
- What happens when `Product` not found for a cart item? → `404 Product not found`, rollback.
- What happens when `available < quantity` for any single item? → `409 Conflict Insufficient available inventory`, entire checkout rolls back — no partial order/reservation.
- What happens when two checkouts arrive with items in opposite order `[A,B]` vs `[B,A]`? → Deterministic `sortedIds = [...ids].sort()` lock ordering prevents deadlock; both lock `A` then `B` or `B` then `A` consistently.
- What happens when `Product.price` is updated mid-transaction (read committed)? → Each checkout reads `Product.price` inside the same `EntityManager` (or `SELECT product FOR SHARE` if plan chooses) — first committer snapshots old price, second sees new price; no dirty read across committed orders. No pessimistic lock on `Product` is required unless research proves price races are business-critical.
- What happens when `Order.total` arithmetic overflows or `quantity * unit_price` exceeds int? → `total` stored as `int` (cents) or `decimal`; DTO enforces max, service validates `total >=0` and sums with `number` safe range; integration test covers large values.
- What happens when transaction takes > statement timeout or DB CHECK violation (`reservedAmount>stock`, `quantity<=0`, `stock>=0`)? → Mapped to `409` per FR-007, rolled back, no partial state.
- What happens when `Reservation` created for checkout already has `expiresAt` past (clock skew)? → `REFRESH`: checkout always uses `now + 15m DEFAULT_TTL`, never accepts client `expiresAt`; if DB `expiresAt<=NOW()` the cleanup worker may expire immediately — acceptable, but checkout sets future TTL.
- What happens when checkout repeats due to client retry (idempotency)? → Phase 6 V1 does **not** provide idempotency key; duplicate `POST /order/checkout` with same cart after first success will see empty cart → `400`; before clearing, duplicate may create a second order — document as known limitation; idempotency-key header is Phase 12.
- What happens when RabbitMQ/Redis unavailable during checkout? → No `ReservationExpired`/`Inventory` logic depends on them; checkout does not publish inside transaction (constitution async pattern) — if post-commit `order.created` event is added in Phase 11, publish after commit and failures are logged not rolled back.
- What happens when caller passes `reservationId`, `orderId`, or `items[]` in checkout body? → DTO for checkout is empty (`{}`); global `ValidationPipe` (`whitelist + forbidNonWhitelisted + transform`) rejects any `items[]`, `reservationId`, or `orderId` with `400`.
- What happens when User calls `POST /reservations` after checkout-only refactor? → `403 Forbidden {message:"Reservation can only be created via POST /order/checkout"}` (or `404` if route deleted); Admin internal path remains but not User. Prevents manual-vs-checkout race and phantom holds.
- What happens when User calls `PATCH /reservations/:id/complete|cancel` on checkout-created reservation? → `403 Forbidden` (restricted to internal Order service + Admin/worker). User must use future `POST /order/:id/cancel` (Phase 8) or let expiration worker handle `EXPIRED`; direct PATCH would leave `Order PENDING` with `Reservation CANCELLED` inconsistency. `GET /reservations/:id` remains allowed for owner/Admin.
- What happens when checkout Reservation expires (`RESERVED`→`EXPIRED` via worker) with linked Order `PENDING`? → Worker transaction also sets `Order PENDING→CANCELLED` atomically (`reservedAmount-=qty`, `Reservation EXPIRED`, `Order CANCELLED` in same `EntityManager` commit). Subsequent `GET /order/:id` shows `CANCELLED`; `GET /reservations/:id` shows `EXPIRED`. Failure in any step rolls back whole worker batch item; no dangling `PENDING` orders with expired holds.

---

## 3. Requirements

### Functional Requirements

- **FR-001**: System MUST define the authoritative **Order** model in PostgreSQL that persists checkout results. Columns: `id uuid PK`, `userId uuid FK → User.id ON DELETE CASCADE @Index(['userId'])`, `status enum (OrderStatus) default PENDING @Index(['status'])`, `total int/decimal CHECK >=0` (sum of items), `createdAt/updatedAt timestamptz`. Relations: `ManyToOne User` + `OneToMany OrderItem`. No premature `stock` on Order; total is authoritative. The existing incorrect `ManyToMany + JoinTable` on `Order.order_items` MUST be fixed to `OneToMany`. Migration MUST change the schema without dropping historic data (Phase 6 has no historic orders beyond seeds).

- **FR-002**: System MUST define **OrderItem** that captures historical commerce facts. Columns: `id uuid PK`, `orderId uuid FK → Order.id ON DELETE CASCADE @Index(['orderId'])`, `productId uuid FK → Product.id ON DELETE RESTRICT/SET NULL` (preferred RESTRICT; document) `@Index(['productId'])`, `quantity int CHECK quantity>0`, `unit_price int/decimal CHECK >=0` — snapshot of `Product.price` at checkout time, `productNameSnapshot varchar nullable` optional. `@Unique(['orderId','productId'])` to prevent duplicate product in same order. Derived `subtotal = quantity * unit_price` may be stored generated column or computed in service but MUST NOT be client-supplied. Relation: `ManyToOne Order`, `ManyToOne Product`.

- **FR-003**: System MUST provide a single **checkout transaction** that creates `Order` + `OrderItems` + `Reservation` + increments `Inventory.reservedAmount` atomically. Pseudocode inside `dataSource.transaction(async manager => ...)` (caller owns commit/rollback per `AGENTS.md` Transactions):
  1. Load `Cart` for `requestingUserId` with `cart_items + product + inventory` (via `manager`), assert non-empty; collect `productIds` → `inventoryIds` mapping and `quantity` per product; reject duplicate product in cart (cart already normalizes).
  2. Read `Product.price` per `productId` via `manager` (no need to lock Product unless plan decides `pessimistic_read`; price snapshot is taken from read value; service validates `price >=0`).
  3. `sortedInventoryIds = [...new Set(inventoryIds)].sort()` deterministic ordering.
  4. `SELECT ... FOR UPDATE` every referenced `Inventory` row via `manager.find(Inventory, { where:{ id: In(sortedIds) }, lock:{ mode:'pessimistic_write' } })`; if any missing → `404`.
  5. Verify `available = stock - reservedAmount >= requested quantity` per inventory; if any fails → `409 Conflict Insufficient available`.
  6. Increment `inventory.reservedAmount += quantity` per item and `manager.save(Inventory)` (no `stock` change yet — sale is Phase 7).
  7. Compute `total = sum(quantity * unit_priceSnapshot)` and create `Order { userId=requestingUserId, status=PENDING, total }` via `manager`.
  8. Create `OrderItem[]` with `orderId=Order.id`, `productId`, `quantity`, `unit_price=snapshot` via `manager`; save.
  9. Create `Reservation { userId, orderId=Order.id, status=RESERVED, expiresAt=now+15m (DEFAULT_TTL_MS) }` via `ReservationService.create`-like logic but reusing the same `manager` + same locked inventories — MUST NOT re-lock inventories; creation path MUST be the same `manager` and same locked rows to keep transaction short. Create `ReservationItem[]` linking `reservationId` + `inventoryId` + `quantity`.
  10. Clear cart `cart_items` via `manager.delete(CartItem, { cart: { id } })` (or via CartService helper that accepts `EntityManager`).
  11. Commit; any failure rolls back entirely — no partial `reservedAmount`/`Order`/`Reservation`.
  Transaction MUST NOT contain Redis, RabbitMQ, or external HTTP I/O. Phase 6 checkout MUST NOT publish any post-commit event (clarified 2026-09-21 Option B — `order.created` deferred to Phase 11); no `ClientProxy` injection required in Phase 6.

- **FR-004**: System MUST enforce **historical price** isolation. `OrderItem.unit_price` is set once inside the checkout transaction to `Product.price` read at that instant and never updated when `Product.price` later changes. `Product` price updates MUST NOT trigger `OrderItem` updates; price is not re-read on `GET /order`. Verification: create product `price=100`, checkout, update product `price=999`, fetch order → `unit_price=100`.

- **FR-005**: System MUST decide `When does inventory become reserved?` — **C. When order is created (inside the checkout transaction)**. Adding to cart (A) only does an optimistic `inventory.available` pre-check and never mutates `reservedAmount`. Starting checkout without completing (B is indistinguishable from C because there is no multi-step checkout state machine; the reservation is created as part of same transaction). The spec declares: cart `add/increase` remains read-only; the **authoritative** availability check and `reservedAmount += qty` happens only inside the checkout transaction. The cart's `available` check may still reject additions with `409` to improve UX, but correctness is enforced in the DB transaction.

- **FR-006**: System MUST support **OrderStatus** minimal state machine for Phase 6. Values: `PENDING` (initial, order created + reserved), future `COMPLETED`/`CANCELLED` are Phases 7-8. `OrderStatus` enum (`PENDING`, `SUCCESS`, `FAILD`) currently contains typos — clarified 2026-09-21 Option A, the Phase 6 migration MUST correct the DB enum to `PENDING|COMPLETED|CANCELLED|FAILED` (renaming `SUCCESS→COMPLETED`, `FAILD→FAILED`, adding `CANCELLED`/`FAILED`); no alias kept. `PENDING` is the only valid state produced by checkout. `validateOrderTransition` guards future transitions similarly to `Reservation.validateTransition`. No transition is performed in Phase 6 beyond creation; `GET` does not mutate status. DB `CHECK status IN (...)` enforced via enum column.

- **FR-007**: System MUST expose a **REST checkout API** and **read APIs** that are thin (no business logic in controller). Routes:
  | Method | Path | Auth | Body | Success | Errors |
  |--------|------|------|------|---------|--------|
  | POST | `/order/checkout` (alias `POST /order`) | `JwtGuard @Auth()` | `{}` empty body — cart implied (server reads `Cart`/`CartItems` for current user; explicit `items[]` in body is rejected `400`) | `201 { id, status:PENDING, total, items:[{productId, quantity, unitPrice, subtotal}], reservationId, expiresAt }` | `400 empty cart / validation / explicit items not allowed`, `401 unauth`, `404 product/inventory`, `409 insufficient available` |
  | GET | `/order` | `JwtGuard` | query `page, limit, status?` | `200 { data: Order[], meta:{ totalItems, itemCount, itemsPerPage, totalPages, currentPage } }` paginated owner-scoped (admin may filter `userId`) | `401`, `400` pagination validation |
  | GET | `/order/:id` | `JwtGuard + assertOwner` | — | `200 Order with items + reservationId` | `403 owner mismatch`, `404 not found` |
  Existing `POST /order` without checkout semantics MUST be deprecated/redirected to `POST /order/checkout`; `CreateOrderDto` empty is replaced with empty `CheckoutDto` (no fields, whitelisted only `{}`, any extra field → `400`). Swagger `@ApiOperation`/`@ApiResponse` + `ValidationPipe`.

- **FR-008**: System MUST be safe under **concurrent checkout races**. Correctness is via row-level `FOR UPDATE` on sorted `Inventory` rows inside the checkout transaction (same pattern as Phases 3-4). The first committer's `reservedAmount` mutation wins; the second transaction after acquiring locks sees `available < requested` and throws `409`. No in-memory `available` cache drives the decision; PostgreSQL transaction is authoritative (constitution I). Deterministic lock ordering prevents deadlocks; transactions kept short (lock → check → mutate → insert → clear cart) with no I/O inside.

- **FR-009**: System MUST enforce **DB constraints and indexes** for the new model (or fix existing). Required constraints: `Order.total >=0`, `OrderItem.quantity >0`, `OrderItem.unit_price >=0`, `Inventory.stock >=0`, `Inventory.reservedAmount >=0`, `Inventory.reservedAmount <= stock`, `@Unique orderId+productId` on `OrderItem`, `@Index(['userId'])` + `@Index(['status'])` on `Order`, `@Index(['orderId'])` on `OrderItem`. Indexes on `Reservation.orderId` already exist and will be used to join `Reservation→Order`. Migration `17xxxxx-OrderIntegrationFix` MUST add/alter `Order`/`OrderItem` without violating existing `synchronize:false`; never edit committed migrations.

- **FR-010**: System MUST have **DB-backed tests** proving checkout correctness: unit tests (mocked `EntityManager` for DTO/Business guards) for empty cart `400`, duplicate product handling, historical price snapshot, `PAGINATION` shape; **integration tests against real PostgreSQL** for checkout creates atomic Order+Reservation+Inventory (shared) — including the case where product price mutation before/after does not affect committed `unit_price`; availability rejection `409` with no side effects; `FOR UPDATE` single-winner checkout vs checkout contending on same `Inventory` → exactly one `201` and one `409` and exactly one `reservedAmount` increment; idempotent re-fetch of already-created order does not double-increment; **E2E (supertest)** `register → add to cart → checkout → GET /order → update product price → GET /order/:id still old price` and `register→add→checkout→GET /reservation/:id linked to order`.

### Key Entities

- **User**: `id uuid PK`, `firstName`, `lastName`, `email @Unique @Index`, `password nullable (for OAuth)`, `role enum`, `phoneNumber nullable @Index`, `googleId nullable @Index`, `provider enum('local','google')`, `tokenVersion int`, `orders OneToMany`, `cart OneToOne`. Already exists; no change in this phase but checkout resolves `requestingUserId` via `@CurrentUser('id')`.

- **Product**: `id uuid PK`, `name @Unique @Index('name')`, `slug`, `description`, `price int CHECK >=0`, `created_at`, `inventory OneToOne`, `cart_items OneToMany`, `order_items OneToMany`. No `stock` field (removed Phase 1). Price is the snapshot source; no lock on product required for Phase 6.

- **Inventory**: `id uuid PK`, `productId uuid FK→Product CASCADE @Unique @Index`, `stock int CHECK >=0`, `reservedAmount int CHECK >=0 CHECK <=stock`, derived `available = stock - reservedAmount` (not stored mutably). Only mutated via checkout transaction `reservedAmount += qty`.

- **Cart / CartItem**: `Cart { id uuid PK, userId FK→User UNIQUE @Index, cart_items OneToMany }`, `CartItem { id uuid PK, cart ManyToOne, product ManyToOne eager, quantity int CHECK >0 }`. Existing; checkout clears `CartItem`s atomically via `EntityManager`.

- **Reservation**: `id uuid PK`, `userId FK→User CASCADE @Index`, `orderId FK→Order SET NULL nullable @Index`, `status enum RESERVED|COMPLETED|EXPIRED|CANCELLED @Index + composite @Index(['status','expiresAt'])`, `expiresAt timestamptz`, `createdAt/updatedAt`, `items OneToMany`. Reservation is created **inside** checkout transaction; `orderId` is set at creation (not patched after).

- **ReservationItem**: `id uuid PK`, `reservationId FK→Reservation CASCADE @Index`, `inventoryId FK→Inventory CASCADE @Index`, `quantity CHECK >0`, `@Unique(['reservationId','inventoryId'])`. Links reservation to exact inventory mutation amount.

- **Order**: `id uuid PK`, `userId FK→User CASCADE @Index(['userId'])`, `status enum PENDING|COMPLETED|CANCELLED|FAILED default PENDING @Index`, `total int/decimal CHECK >=0`, `created_at/updated_at timestamptz`, `order_items OneToMany`, `reservation OneToOne optional (via Reservation.orderId)`. Replaces stub `ManyToMany` + `JoinTable`.

- **OrderItem**: `id uuid PK`, `orderId FK→Order CASCADE @Index(['orderId']) @Unique(['orderId','productId'])`, `productId FK→Product RESTRICT @Index`, `quantity int CHECK >0`, `unit_price int/decimal CHECK >=0` (historical snapshot), optional `productNameSnapshot`, stored `subtotal = quantity*unit_price` may be generated. Relation `ManyToOne` to both `Order` and `Product`.

- **CheckoutTransaction**: Not a DB entity; the `DataSource.transaction(manager => ...)` scope that owns the lock→check→mutate→create pattern. Config `DEFAULT_TTL_MS=15m`, `OrderTotal` arithmetic rule; all writes via `manager.getRepository`.

---

## 4. Success Criteria

### Measurable Outcomes

- **SC-001**: A checkout with `P-A price100 qty2 + P-B price50 qty1` where `A stock10 reserved0`, `B stock5 reserved0` succeeds → single `Order` `status=PENDING` `total=250`, 2 `OrderItems` with historical `unit_price 100/50`, one `Reservation` `RESERVED` with `orderId=Order.id` and items matching OrderItems qty, both `Inventory.reservedAmount` incremented by ordered quantities (`A 0→2`, `B 0→1`), cart emptied, all persisted in one commit (verified by integration test on real PostgreSQL, not mocked).
- **SC-002**: After checkout, updating `Product A price 100→999` and re-fetching `GET /order/:id` still returns `OrderItem.unit_price=100` (historical isolation) and re-running checkout for a new order snapshots `999`.
- **SC-003**: Concurrent checkouts on `A available=1` — two simultaneous `POST /order/checkout` (each `A qty1`) → exactly one `201` and one `409 Conflict Insufficient available`, `reservedAmount` increases exactly once (e.g., `9→10` if `stock=10` `reserved=9`), the loser creates no `Order`/`Reservation` and causes no partial inventory mutation (verified by parallel `Promise.all` concurrency test with real `DataSource.transaction`, `--runInBand`).
- **SC-004**: Checkout with any item `available < quantity` (e.g., `A stock10 reserved8 avail2` requesting `A qty3`) is rejected with `409` and after rollback verifies `Order` count unchanged, `Reservation` not created, `Inventory reservedAmount` still 8 and `stock` still 10 — no partial writes.
- **SC-005**: Checkout with empty cart returns `400 Cart is empty` and leaves DB unchanged (no order/reservation/inventory mutation).
- **SC-006**: `GET /order` as authenticated user with `page=1 limit=10` returns `{ data, meta:{ totalItems, itemCount, itemsPerPage, totalPages, currentPage } }` consistent with `GET /products` pagination shape; `GET /order/:id` as owner succeeds, as non-owner non-admin fails `403`; admin can fetch any order.
- **SC-007**: Deterministic lock ordering prevents deadlock: two concurrent checkouts with items `[A,B]` vs `[B,A]` and `stock` sufficient for only one combined allocation both complete without deadlock — verified by opposite-order integration test that asserts both transactions either succeed or one fails with `409` but never hangs (`lock timeout` not hit).
- **SC-008**: `EXPLAIN` for the checkout's `SELECT ... FOR UPDATE` scan shows row-level `Lock Rows` on `Inventory` via `id` PK (or `SELECT ... FOR UPDATE` on `Inventory` filtered by `In(sortedIds)`) and no table-level lock; `Order`+`OrderItem` inserts use FK indexes `orderId`/`userId`; smoke timing: checkout commit holds row locks <100ms under no contention (observed via log, not a hard SLA).

---

## 5. Assumptions

- **A1**: PostgreSQL is authoritative; Redis/RabbitMQ/BullMQ are never authoritative for order/reservation truth (constitution I). Phase 6 performs **no** Redis caching and **no** post-commit publish (`order.created` deferred to Phase 11 per 2026-09-21 clarification Option B); transaction contains only PostgreSQL via `EntityManager`.
- **A2**: Phases 1-5 entities are correct: `Inventory`/`Product` one-to-one, `Reservation`/`ReservationItem` with constraints and composite `status+expiresAt` index, `Cart`/`CartItem` with eager product, `User` with `password nullable` etc. No new Redis/RabbitMQ infrastructure beyond existing `BullModule` for expiration and `NOTIFICATION_SERVICE` for future events.
- **A3**: The current `Order`/`OrderItem` stub must be fixed (`ManyToMany` + `JoinTable` is wrong, missing `userId` FK, missing indexes/checks, `quantity`/`unit_price` as `decimal` may stay but should be `int` cents; enum `SUCCESS/FAILD` typo is corrected to `PENDING/COMPLETED/CANCELLED` or kept with alias — plan decides). Migration will correct relations: `Order.user` FK `user_id` column, `OrderItem.order_id` FK + `product_id` FK, `unique(orderId,productId)`, `CHECK quantity>0`, `CHECK unit_price>=0`.
- **A4**: Cart is the checkout source: `POST /order/checkout` with empty body chews the current user's cart (clarified 2026-09-21: cart-only, explicit `items[]` rejected `400` via `forbidNonWhitelisted`). No explicit-items checkout path in V1.
- **A5**: Inventory becomes reserved **when order is created** (option C). Adding to cart (A) is optimistic only; the authoritative `available >= requested` and `reservedAmount += qty` happens inside the checkout transaction. No separate "reserve on add-to-cart" step.
- **A6**: TTL for checkout-created reservation remains `15 minutes` (`DEFAULT_TTL_MS` from `reservation.service.ts`), independent of product. Expiration worker (§5) will later expire it if not completed. Checkout does not accept client-supplied `expiresAt`.
- **A7**: Transaction boundary is `dataSource.transaction(manager => OrderCheckoutService.checkout(manager, userId))` with `EntityManager`; all writes via `manager.getRepository`. Same pattern as Phases 3-4. Worker/expiration not involved in checkout path.
- **A8**: Error mapping keeps Phase 4 conventions: `400` validation/empty cart, `401` unauthenticated, `403` owner mismatch, `404` product/inventory/order missing, `409` insufficient available or DB CHECK violation, `500` unexpected only. Global `AllExceptionsFilter` serializes.
- **A9**: Order total is authoritative as sum of `quantity*unit_price`; rounding is integer cents; `total` stored as `int` mirrors `Product.price` type. Currency is not modeled (future).
- **A10**: Payment is **not** in scope for Phase 6 (per `docs/plan.md` Phase 7). Creation leaves `Order.status=PENDING`; transition to `COMPLETED` (`stock -= qty` `reserved -= qty`) is Phase 7; cancellation/refund is Phase 8. Phase 6 only proves reservation linkage.

---

## 6. Dependencies

- Phase 1 `Inventory` (`InventoryService`, constraints, `InventorySeeder`, DB checks, `synchronize:false`) — DONE 2026-08-21.
- Phase 2 `Reservation`/`ReservationItem` entities, indexes (composite `status+expiresAt`), `ReservationService`/`ReservationController`, `validateTransition`, `assertOwner`, migration `1755850000000` — DONE 2026-08-22.
- Phase 3 transaction-safe `ReservationService.create` (`FOR UPDATE` sorted inventories, `available` check, `reservedAmount` increment) — DONE 2026-08-30.
- Phase 4 reservation lifecycle (`complete`/`cancel`/`expire` transactional, `FOR UPDATE` Reservation+Inventories, single-winner, `COMPLETED→COMPLETED` idempotent) — DONE 2026-09-14.
- Phase 5 expiration cleanup worker (`ReservationExpirationService` + `ReservationExpirationProcessor` BullMQ repeat 30s, `EXPIRATION_MAX_RETRIES=3`, `reservation.expired` post-commit) — DONE 2026-09-21 (`specs/006...` 45 tasks, build 169 tests pass).
- `DataSource`/`EntityManager` transactional support, global `ValidationPipe` + `AllExceptionsFilter` + `Logger`.
- Existing modules: `cart` (Cart/CartItem + CartService `getInventory` optimistic check), `products` (Product `price`), `users`/`auth` (`JwtGuard`, `@Auth`, `@CurrentUser`), `inventory`.
- No new infrastructure dependency is required for the exit criterion; optional future `order.created` RabbitMQ event would reuse existing `NOTIFICATION_SERVICE` after commit if added in Phase 11.

---

## 7. Out of Scope (this phase)

- Any payment provider integration, payment state machine, `Payment` entity, success/failure callbacks, or Pay-then-complete orchestration — Phases 7-8. `Order.status=PENDING` only; no `Order → COMPLETED` transition here (`stock -= qty` sale logic is Phase 7).
- Order cancellation / refund, `stock += qty` or `reservedAmount -= qty` on cancellation, cancellation state machine — Phase 8. Checkout only creates; it does not cancel.
- Redis caching of products/orders/inventory, cache keys/TTLs/invalidation, product list `product:{id}` cache — Phase 9. Redis must not become authoritative for `available` decisions.
- Rate limiting on new endpoints — Phase 10; checkout has no throttle beyond existing global limits.
- Broader RabbitMQ/BullMQ async event fan-out (`OrderCreated`, `ReservationExpired` notification, analytics) — Phase 11; Phase 6 may publish minimal `order.created` after commit but broader notification fan-out is deferred.
- Idempotency-retry framework, idempotency-key header, client retry dedup — Phase 12; duplicate checkout after empty cart → `400` is the V1 behavior; retry after `409` is manual.
- Broad DB constraint/index sweep beyond `Order`/`OrderItem` and the checkout transaction's required indexes — Phase 13 (no full optimization).
- Frontend, GraphQL mutations for checkout, email templates — out of scope; REST only.
- New reservation states, new `Reservation`/`Inventory` columns, or changing `expiresAt` generation (still `now+15m`) — out of scope.
- Multi-warehouse inventory, backorders, partial fulfillment — out of scope; checkout is all-or-nothing.

---

## 8. Clarifications

### Session 2026-09-21 (Phase 6 kickoff)

- Q: When does inventory become reserved? (docs/plan.md §6.4 A/B/C/D) → A: **C. When order is created** inside the single checkout transaction. Cart `add`/`increase` only pre-checks `available` for UX; the authoritative reservation `reservedAmount += qty` is only inside `checkout → createOrder → createReservation` transaction. Adding to cart (A) never reserves. (No separate `checkout_started` state.)
- Q: Should checkout publish an async event after commit? → A: **Out of scope for minimal exit criterion**, but if added, it MUST be after DB commit (constitution async pattern) with `{ orderId, userId, total, reservationId }` via RabbitMQ `order.created`, failures logged not rolled back — Phase 11 fan-out remains deferred. Plan will decide whether to implement or defer.
- Q: Is `POST /order/checkout` cart-based or explicit-items? → A: **Cart-only** (original Q superseded by 2026-09-21 clarification Option A). `POST /order/checkout` uses `{}` empty body and reads server `Cart`; explicit `items[]` is rejected `400`.
- Q: How to fix the existing `OrderStatus` enum (`SUCCESS`/`FAILD` typo) and `Order.order_items ManyToMany`? → A: **Migration corrects both**: `OrderStatus` becomes `PENDING|COMPLETED|CANCELLED|FAILED` (or alias `SUCCESS→COMPLETED`, `FAILD→FAILED`) and `Order` relation is changed to `OneToMany OrderItem` (fix `@JoinTable` misuse). `synchronize:false`; a real migration alters the schema.
- Q: Checkout source — cart-based vs explicit `items[]` in body? → A: **Cart-only** (clarified 2026-09-21, Option A). `POST /order/checkout` MUST be called with empty body `{}` (or no body); it always reads the server-side `Cart`/`CartItems` for the authenticated user. Explicit `items: {productId, quantity}[]` in the checkout body MUST be rejected with `400` via global `ValidationPipe` (`forbidNonWhitelisted`). No dual path in V1; plan may add explicit-items variant later as separate endpoint if headless use-case is proven.
- Q: Should checkout create a new Reservation or consume an existing client-provided `reservationId`? → A: **Create new Reservation atomically** (clarified 2026-09-21, Option A). The checkout transaction itself creates `Reservation (RESERVED, expiresAt=now+15m, orderId=Order.id)` with `ReservationItem`s from the locked inventories in the same `EntityManager` commit. Client-supplied `reservationId` in the checkout body is not accepted (`400`). Existing `POST /reservations` remains for non-checkout reserve flows, but checkout does not consume it to avoid double-reserve and cart-vs-reservation divergence checks. Hybrid reuse may be added later if proven.
- Q: Should `OrderItem` reference `productId` or `inventoryId`? → A: **productId only → Product** (clarified 2026-09-21, Option A). `OrderItem.productId FK → Product ON DELETE RESTRICT`; `Inventory` is derived via `Product.id → Inventory.productId` 1-1. No `inventoryId` column on `OrderItem` in V1 to avoid coupling history to inventory row lifecycle. Snapshot `unit_price` and `productName` stored denormalized for historical isolation.
- Q: How to fix `OrderStatus` typo `SUCCESS/FAILD`? → A: **Migrate now to `PENDING|COMPLETED|CANCELLED|FAILED`** (clarified 2026-09-21, Option A). Migration in Phase 6 renames `SUCCESS→COMPLETED`, `FAILD→FAILED`, ensures `PENDING` default, adds `CANCELLED`/`FAILED`. No alias kept; DB enum is corrected immediately while Order table has no historic data.
- Q: Should checkout publish `order.created` RabbitMQ event post-commit? → A: **Defer to Phase 11** (clarified 2026-09-21, Option B). Phase 6 checkout performs **no** RabbitMQ/Redis I/O, before or after commit. The only persistence is PostgreSQL (`Order`/`OrderItem`/`Reservation`/`Inventory`/`Cart`). Async fan-out (`order.created`, notifications, analytics) is Phase 11; failures do not affect checkout.
- Q: After making reservation checkout-only (refactor 2026-09-21), should `POST /reservations` remain for User? → A: **No — blocked for User** (plan D1). `POST /reservations` returns `403 {message:"Reservation can only be created via POST /order/checkout"}` for `User` (or `404` if route deleted); internal `ReservationService.createForCheckout(manager,userId,items,orderId)` is the sole producer. `GET /reservations*` remains for owner/Admin, but `POST` for User is removed to eliminate manual-vs-checkout race.
- Q: Should User be able to `PATCH /reservations/:id/complete|cancel` their checkout-created reservation directly? → A: **No — restricted for User** (clarified 2026-09-21, Option B). `PATCH /:id/complete` and `PATCH /:id/cancel` return `403` for `User` on checkout-created reservations; state transitions must go via Order lifecycle (Phase 7 `COMPLETED` → `stock-=qty`, Phase 8 `CANCELLED` → `reserved-=qty`) or Admin/worker. `GET /reservations/:id` and `GET /` remain for owner/Admin, and `PATCH /:id/expire` stays `Admin` only. Prevents Order `PENDING` vs Reservation `CANCELLED` inconsistency and keeps `reservedAmount` single-producer.
- Q: When checkout-created Reservation expires (`RESERVED`→`EXPIRED` via worker), what happens to linked Order `PENDING`? → A: **Order auto → `CANCELLED`** (clarified 2026-09-21, Option B). Expiration worker transaction that marks `Reservation RESERVED→EXPIRED` and `reservedAmount-=qty` also sets `Order.status PENDING→CANCELLED` atomically in the same `EntityManager` commit (lock Reservation → lock Inventories → update both). Failure rolls back both; `FAILED` reserved for payment failures, `CANCELLED` for expiry. Keeps Order and Reservation consistent without manual retry leaving dangling `PENDING` orders.
- Q: Should Admin still be able to `POST /reservations` after checkout-only refactor? → A: **Yes — Admin keeps `POST /reservations` → `201`** (clarified 2026-09-21, Option A). `@Auth(Admin)` on `POST /` remains for admin/internal tooling and tests; `User` → `403 {message:"Reservation can only be created via POST /order/checkout"}`. This preserves ability to create fixtures for expiration tests without full cart+checkout while still eliminating user race.
- Q: Should `GET /order/:id` embed full `Reservation` object? → A: **No — `reservationId` only** (clarified 2026-09-21, Option A). `GET /order/:id` and `GET /order` return `{..., reservationId: uuid, expiresAt}` link only; client fetches `GET /reservations/:id` for items/status. Keeps modular boundaries (OrderModule → ReservationModule via `orderId` FK, not eager join) and avoids duplicating inventory data in order payload. `?expand=reservation` may be added later if needed.

No additional clarification markers remain at spec authoring time. All business invariants are fully specified; plan may open ≤1 focused clarifications if research surfaces a price-locking or product-relation edge.

---

## 9. Acceptance Scenarios (for planning)

1. Checkout atomic: cart `A2 B1` stock sufficient → `POST /order/checkout` → `PENDING total = sum(qty*price)` + `OrderItems` snapshot + `RESERVED` with `orderId` + `reservedAmount` inc + cart empty — one commit.
2. Historical price: `Product price 100 → checkout → 100 snapshot → product price 999 → GET /order` still 100; new checkout snapshots 999.
3. Insufficient available: `available 1 qty2` → `409` no order/reservation/inventory side effect.
4. Empty cart: → `400` no side effect.
5. Concurrent checkout: `available1` two `qty1` checkouts → one `201` one `409`, `reserved` inc exactly once.
6. Opposite-order deadlock avoidance: `[A,B]` vs `[B,A]` concurrent checkouts with sufficient stock succeed without deadlock; with only one unit of `A`, single winner.
7. Pagination read: `GET /order` returns `{ data, meta }` paginated `userId`-scoped; `GET /order/:id` owner/admin 200, non-owner 403.

