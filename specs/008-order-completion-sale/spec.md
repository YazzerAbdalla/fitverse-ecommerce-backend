# Feature Specification: Order Completion / Sale

**Feature Branch**: `008-order-completion-sale`  
**Created**: 2026-09-22  
**Status**: Draft  
**Input**: User description: "start phase 7"  
**Source**: `docs/plan.md` Phase 7 — Order Completion / Sale (§§7.1-7.2), `docs/architecture/inventory-reservation.md` (Completion rule `stock -= qty; reserved -= qty`), constitution I/III/IV/V, existing `src/modules/order` (`Order`/`OrderItem`, `OrderStatus PENDING|COMPLETED|CANCELLED|FAILED`, `POST /order/checkout` checkout-only transaction) + `src/modules/reservation` (`Reservation` `RESERVED→COMPLETED` via `FOR UPDATE` + `ReservationTransitionBuilder`, expiration worker `RESERVED→EXPIRED` + `Order PENDING→CANCELLED`) + `src/modules/inventory` (`stock`, `reservedAmount`, `available = stock - reservedAmount`, DB CHECKs)

---

## 1. Overview

Phases 1-6 established a correct reservation path: `Inventory` is authoritative (`stock`, `reservedAmount`, `available = stock - reservedAmount`, DB CHECKs `stock>=0`, `reservedAmount>=0`, `reservedAmount<=stock`, unique `productId`), `Product` owns price only, `Reservation`+`ReservationItem` (`RESERVED|COMPLETED|EXPIRED|CANCELLED`, composite `status+expiresAt` index) is created atomically via `FOR UPDATE` sorted inventories (`available >= requested`, `reservedAmount+=qty`), `Order`+`OrderItem` (`PENDING` initial, `total = Σ qty*unit_price`, historical `unit_price` snapshot, `@Unique orderId+productId`, FK `productId→Product RESTRICT`) is created together with `Reservation` inside a single `DataSource.transaction` by `POST /order/checkout` (cart-only, clears cart, deterministic lock ordering, single-winner concurrency), and the expiration worker expires `status=RESERVED AND expiresAt<=NOW()` + atomically `Order PENDING→CANCELLED`.

The `Order` module remains **PENDING-only** — there is no sale yet. `Reservation` completion via `PATCH /reservations/:id/complete` exists but is restricted to `Admin` (`User → 403 Reservation transitions via Order lifecycle only` per Phase 6). Inventory `stock` is never decreased on checkout; only `reservedAmount` increases. Phase 7 must define the missing sale step.

**Decision for Phase 7 V1** (per `docs/plan.md` §7.2): the project has **no payment provider**. Phase 7 MUST NOT invent a payment integration (Stripe, PayPal, etc.), MUST NOT require a `Payment` entity, and MUST define payment state separately later. Completion is an **explicit, user-initiated or admin-initiated state transition** that simulates "payment succeeded" — `Order PENDING → COMPLETED` and `Reservation RESERVED → COMPLETED` atomically with `stock -= qty` + `reservedAmount -= qty`. Payment failure (`Order PENDING → FAILED`) is defined as a state but not implemented as a separate payment callback in V1; it is covered as a rule for future phases.

### Goal

A completed sale permanently decreases stock while releasing its reservation. — `docs/plan.md` Phase 7 Exit Criteria.

---

## 2. User Scenarios & Testing

### User Story 1 — Owner completes own PENDING order → sale recorded (Priority: P1)

An authenticated shopper has checked out: `Order O` (`status=PENDING`, `total=250`, 2 `OrderItems` `A qty2 unit_price100`, `B qty1 unit_price50`, linked `Reservation R` `RESERVED expiresAt=now+15m` with items `A qty2`, `B qty1`, inventories `A stock=10 reserved=2`, `B stock=5 reserved=1`). The shopper calls `POST /order/:id/complete` (or `PATCH /order/:id/complete`) as owner. The system atomically verifies ownership, verifies `Order PENDING` and `Reservation RESERVED` linked via `R.orderId=O.id`, locks `Order`+`Reservation`+ sorted `Inventories` `FOR UPDATE`, decrements `stock -= qty` and `reservedAmount -= qty` per item (`A stock 10→8 reserved 2→0`, `B stock 5→4 reserved 1→0`), transitions `Order PENDING→COMPLETED` and `Reservation RESERVED→COMPLETED`, commits, and returns `200` with `Order COMPLETED` and `Reservation COMPLETED`. Subsequent `GET /order/:id` shows `COMPLETED`; `GET /reservations/:id` shows `COMPLETED`; `GET /inventory/:productId` shows new `stock`/`available`.

**Why this priority**: This is the Phase 7 exit criterion. Without it stock never reflects sold units and the reservation lifecycle ends at `PENDING`. Every downstream concern (cancellation after sale, analytics, restocking) depends on this transition.

**Independent Test**: Seed products `A/B` with inventories, user U1 `POST /cart/items` → `POST /order/checkout` → capture `orderId`/`reservationId`, assert `Order PENDING`, `Reservation RESERVED`, `A reserved=2`. `POST /order/:id/complete` as U1 → `200` `{ status: COMPLETED, reservation:{ status: COMPLETED } }`. Fetch `GET /order/:id` → `COMPLETED`, `GET /inventory/:productId` for A → `stock 8 reserved 0 available 8`, for B → `stock 4 reserved 0 available 4`, `total` unchanged `250`. Re-fetch `OrderItems` still `unit_price 100/50` (historical).

**Acceptance Scenarios**:

1. **Given** `Order PENDING` with `Reservation RESERVED` (`A stock10 reserved2 available8`, `B stock5 reserved1 available4`, `O total250`), **When** owner `POST /order/:id/complete`, **Then** `201/200` with `Order.status=COMPLETED`, `Reservation.status=COMPLETED`, `A.stock=8 A.reservedAmount=0 A.available=8`, `B.stock=4 B.reservedAmount=0 B.available=4`, `Order.total` still `250` and `OrderItems.unit_price` unchanged.
2. **Given** same `Order PENDING`/`Reservation RESERVED`, **When** completion succeeds, **Then** `GET /order/:id` returns `COMPLETED` with `reservationId` link, `GET /reservations/:id` returns `COMPLETED` with `orderId=O.id`, both observable in same committed state (no phantom `PENDING` with `COMPLETED` reservation).
3. **Given** `Order PENDING` with single item `A qty1` where `A stock10 reserved1`, **When** owner completes, **Then** `stock 10→9 reserved 1→0 available 9` and `Order COMPLETED` persisted; no other inventory row mutated.
4. **Given** completion was already performed (see Story 2 idempotency), **When** fetching inventory, **Then** `stock` reflects exactly one decrement per ordered quantity, never double-decremented.

---

### User Story 2 — Concurrent completion race: single winner + idempotent retry (Priority: P1)

Two concurrent callers (duplicate client retry, double-click, or two admin consoles) race to complete the same `Order PENDING`/`Reservation RESERVED`. Only one transaction must win the inventory mutation; the other must observe the already-COMPLETED state without corrupting inventory.

**Why this priority**: Constitution IV (no double-sale). Inventory `stock-=qty` must happen exactly once. Without single-winner locking, two concurrent completions could decrement `stock` twice for one sale, or leave `reservedAmount` negative.

**Independent Test**: Seed `Order PENDING` with `Reservation RESERVED` (`A stock10 reserved2` for `A qty2`). Fire `Promise.all([complete(orderId), complete(orderId)])` via `dataSource.transaction` with real PostgreSQL `--runInBand`. Assert exactly one initial completion does `stock 10→8 reserved 2→0` + `200` with state change, the other returns `200` idempotent `COMPLETED→COMPLETED` with no additional inventory change (or `409` if plan chooses non-idempotent for `Order`; spec chooses idempotent per `Reservation` pattern), after settlement `A.stock=8 A.reserved=0` (not `6`/`-2`), both callers see `Order COMPLETED` + `Reservation COMPLETED`. Verify `FOR UPDATE` on `Order`+`Reservation`+ sorted `Inventories` is used.

**Acceptance Scenarios**:

1. **Given** `Order PENDING` + `Reservation RESERVED` (`A stock10 reserved2`), **When** two `POST /order/:id/complete` for same `id` execute concurrently, **Then** exactly one transaction performs `stock-=2 reserved-=2`, both callers end with `200` and `Order COMPLETED`/`Reservation COMPLETED`, final `reservedAmount=0 stock=8` (never `stock=6`).
2. **Given** `Order COMPLETED` (already completed), **When** owner retries `POST /order/:id/complete`, **Then** `200` idempotent success, no inventory mutation, response still `COMPLETED` (consistent with `Reservation COMPLETED→COMPLETED` idempotency in Phase 4 Q4).
3. **Given** `Order PENDING` where `Reservation` is contended with concurrent `expire` worker (`RESERVED→EXPIRED`) vs `complete` (`RESERVED→COMPLETED`), **When** both race, **Then** single winner: if `complete` wins, `Order COMPLETED` `stock-=qty`; if `expire` wins, `Order CANCELLED` `reserved-=qty` only; loser gets `409 Conflict` (or `200` idempotent if already in terminal state it requested) and inventory changed exactly once.
4. **Given** completion with items `[A,B]` vs another completion for different order on `B` only racing on shared `B`, **When** executed concurrently, **Then** row-level locking on sorted `Inventories` ensures correct serialization without deadlock; both succeed if stock sufficient, or second fails if combined would violate `stock>=0`.

---

### User Story 3 — Ownership, visibility, and invalid transitions (Priority: P2)

Users can complete only their own orders; admins can complete any; invalid states are rejected with precise errors; completed orders remain readable and price history stays frozen.

**Why this priority**: P2 because correctness of P1 is primary, but without ownership and transition guards the API is insecure and future cancellation (Phase 8) cannot reason about `OrderStatus`.

**Independent Test**: Create U1 order `PENDING`, U2 order `PENDING`, one `EXPIRED` order (via reservation expiry worker). As U2 attempt `POST /order/:id/complete` on U1's order → `403`; as Admin → `200`. As owner attempt `POST /order/:id/complete` on `EXPIRED` (`Order CANCELLED` + `Reservation EXPIRED`) → `409`; on already `COMPLETED` → `200` idempotent. `GET /order/:id` as owner/admin succeeds, as other user `403`.

**Acceptance Scenarios**:

1. **Given** `Order PENDING` belongs to U1, **When** U2 (non-admin, non-owner) `POST /order/U1-order-id/complete`, **Then** `403 Forbidden "You are not allowed to access this order"` and no DB mutation; when Admin completes same order, **Then** `200` (admin bypass).
2. **Given** `Order CANCELLED` (expired, `Reservation EXPIRED`) or `Order FAILED` (future payment failure placeholder), **When** owner `POST /order/:id/complete`, **Then** `409 Conflict "Invalid order transition: CANCELLED -> COMPLETED"` and inventory unchanged (`stock`/`reservedAmount` not decremented again).
3. **Given** `Order COMPLETED`, **When** fetching `GET /order/:id` after `Product A price 100→999`, **Then** `OrderItem.unit_price` still `100` (historical isolation unchanged by completion) and `Order.total` still original sum.
4. **Given** `Order PENDING` with `Reservation RESERVED` but `Inventory` row was deleted concurrently (edge), **When** completing, **Then** `404 Inventory <id> not found`, entire transaction rolls back, `Order` remains `PENDING` and `Reservation` remains `RESERVED` (no partial state).

---

### Edge Cases

- What happens when `Order` is `PENDING` but linked `Reservation` is missing (data inconsistency)? → Completion MUST find `Reservation` by `orderId` inside transaction (`SELECT Reservation WHERE orderId=:id FOR UPDATE`), if missing → `404 Reservation for order <id> not found`, rollback, `Order` stays `PENDING`.
- What happens when `Order` `PENDING` but `Reservation` is `CANCELLED` (manual cancel) or `EXPIRED` (worker) → `409 Conflict` (invalid transition `CANCELLED→COMPLETED` / `EXPIRED→COMPLETED`), no inventory `stock-=qty`. The previous `CANCELLED`/`EXPIRED` already did `reserved-=qty`; completion must not re-apply.
- What happens when `Order` already `COMPLETED` and client retries → idempotent `200` (no inventory change), same as `Reservation COMPLETED→COMPLETED` (Phase 4 Q4). Non-idempotent would be `409`; spec chooses idempotent to be safe for retries (Phase 12 reliability).
- What happens when `Order` is `FAILED` (future payment-failed state) → `409` on `FAILED→COMPLETED`; a separate `retry` flow would be a new order, not reuse.
- What happens when two different orders share same `Inventory` and both complete concurrently on same `Inventory`? → Row-level `FOR UPDATE` on sorted `Inventories` serializes; final `stock = initialStock - sum(completedQty)` correctly, no oversell beyond `stock`, `reservedAmount` decremented per completed order.
- What happens when `Inventory.stock < quantity` at completion time due to prior `decreaseStock` admin action? → DB `CHECK stock>=0` would be violated by `stock-=qty`; service MUST map `23514`/`CHK_inventory_stock_non_negative` to `409 Conflict "Insufficient stock to complete sale"` and rollback. This cannot happen if checkout invariants held, but guard is required per `docs/architecture/inventory-reservation.md` Q2 pattern (rely on DB CHECK as backstop).
- What happens when `Reservation.items` quantity sum differs from `OrderItems` quantity (should never diverge; checkout created them atomically)? → Use `ReservationItems` as source for inventory mutation (authoritative for `reservedAmount`), but validate `OrderItems` exist; if mismatch, log warning and still use `ReservationItems` qty for `stock`/`reserved` math.
- What happens when client passes `paymentId`, `amount`, or `items[]` in completion body? → `CompleteOrderDto` is empty (like `CheckoutDto`); global `ValidationPipe` (`whitelist + forbidNonWhitelisted + transform`) rejects any extra field with `400`.
- What happens when completion is called after `expiresAt` but before worker expired it (`expiresAt <= NOW()` but still `RESERVED`)? → Completion MUST still succeed if it wins the race: `FOR UPDATE` on `Reservation` verifies `status==RESERVED` (not `expiresAt`), so a timely `complete` near TTL can still complete; worker will then see `COMPLETED` and do nothing (single-winner per Phase 5).
- What happens when RabbitMQ/Redis unavailable during completion? → Completion does **not** publish inside transaction; any `order.completed` / `reservation.completed` async event (Phase 11) is published **after commit**; failures are logged not rolled back. If Redis rate-limit fails, fail open with log per Phase 9/10 rule.
- What happens when caller `GET /order/:id` immediately after `POST /order/:id/complete` (read-after-write)? → Read shows `COMPLETED` with `reservationId` and updated inventories; no eventual consistency delay — PostgreSQL is source of truth.
- What happens when `Order.userId` is deleted (`User CASCADE`)? → Existing `ON DELETE CASCADE` on `Order.userId` and `Reservation.userId` cascades; completion on deleted user never happens (order gone). No additional handling.

---

## 3. Requirements

### Functional Requirements

- **FR-001**: System MUST define and enforce **Order lifecycle** relevant to sale. Allowed `OrderStatus` values remain `PENDING|COMPLETED|CANCELLED|FAILED` (Phase 6). **Valid transitions for Phase 7**: `PENDING → COMPLETED` (success sale), `PENDING → CANCELLED` (already exists via expiration worker; not changed here), `PENDING → FAILED` (defined but not implemented in V1 — reserved for future payment failure; if called via future endpoint it would be `PENDING→FAILED` + `reservedAmount-=qty` release, stock unchanged). **Invalid**: `COMPLETED→*`, `CANCELLED→COMPLETED`, `FAILED→COMPLETED`, `EXPIRED→COMPLETED` (no `EXPIRED` order status, but `Reservation EXPIRED` case maps to `CANCELLED`). Idempotency: `COMPLETED→COMPLETED` MUST be idempotent `200` (no inventory re-mutation), mirroring `Reservation COMPLETED→COMPLETED`. A `validateOrderTransition(from,to)` helper (analogous to `ReservationService.validateTransition`) MUST guard transitions and throw `409 Conflict` on invalid.

- **FR-002**: System MUST provide a **single transactional sale operation** `POST /order/:id/complete` (idempotent alias `PATCH /order/:id/complete` allowed if existing `Reservation` pattern is reused; spec requires at least `POST /order/:id/complete`) that atomically: locks `Order` + linked `Reservation` + sorted `Inventories`, transitions `Order PENDING→COMPLETED` + `Reservation RESERVED→COMPLETED`, and persists `Inventory.stock -= quantity` + `Inventory.reservedAmount -= quantity` per item. Pseudocode inside `DataSource.transaction(async manager => ...)` (caller owns commit/rollback, all writes via `manager`):

  1. `SELECT Order WHERE id=:orderId FOR UPDATE` via `manager.findOne(Order, { where:{id}, lock:{mode:'pessimistic_write'} })`; if missing → `404`; `assertOwner(order, requestingUserId, role)` (`owner || Admin`, else `403`).
  2. Idempotent check: if `order.status===COMPLETED` and target `COMPLETED` → return `200` with current `Order`+`Reservation` (no inventory change); if `order.status` is `CANCELLED`/`FAILED` → `validateOrderTransition` will throw `409` (do not short-circuit before validation except for idempotent case).
  3. `validateOrderTransition(PENDING, COMPLETED)` (or current→target); if invalid → `409`.
  4. `SELECT Reservation WHERE orderId=:orderId FOR UPDATE` (lock without outer join; then load with `relations:{items:true}`); if missing → `404 Reservation for order <id> not found`; `validateTransition(RESERVED, COMPLETED)` via `ReservationService.validateTransition`; special idempotent `COMPLETED→COMPLETED` already handled at order level but also at reservation level if reservation already `COMPLETED`.
  5. No items? Still allow `Order→COMPLETED` + `Reservation→COMPLETED` without inventory mutation (edge; log).
  6. `sortedIds = [...new Set(reservation.items.map(i=>i.inventoryId))].sort()` deterministic ordering.
  7. `SELECT ... FOR UPDATE` every referenced `Inventory` row via `manager.find(Inventory, { where:{ id: In(sortedIds) }, lock:{mode:'pessimistic_write'} })`; if any missing → `404`; build `inventoryMap`.
  8. Mutate per item `inventory.stock -= item.quantity; inventory.reservedAmount -= item.quantity;` and `manager.save(inventory)`; rely on DB `CHECK stock>=0`/`reservedAmount>=0`/`reservedAmount<=stock` as backstop — map `23514`/`CHK_` to `409 Conflict` (no explicit `stock>=qty` pre-check needed per Phase 4 Q2, but `available` invariant still holds).
  9. Set `reservation.status=COMPLETED` (and `orderId` unchanged) and `order.status=COMPLETED`; `manager.save` both.
  10. Commit; any failure rolls back entirely — no partial `stock`/`reserved`/`Order`/`Reservation`.

  Transaction MUST NOT contain Redis, RabbitMQ, or external HTTP I/O. If `order.completed`/`reservation.completed` events are emitted, they MUST be after commit (Phase 11 pattern).

- **FR-003**: System MUST enforce **inventory arithmetic correctness on sale**. For each `ReservationItem { inventoryId, quantity }` linked to the completing order: `stock` decreases by `quantity` and `reservedAmount` decreases by `quantity`, so `available = stock - reservedAmount` stays unchanged by the pair (see Phase 4 §4.2 example: `stock10 reserved3 avail7 → stock7 reserved0 avail7`). The decrease is applied exactly once per successful sale; idempotent retries MUST NOT re-apply. DB constraints (`CHK_inventory_stock_non_negative`, `CHK_inventory_reserved_non_negative`, `CHK_inventory_reserved_lte_stock`) are the final backstop; service maps violations to `409`.

- **FR-004**: System MUST expose a **thin REST completion API** (no business logic in controller) and preserve read APIs. Routes:

  | Method | Path | Auth | Body | Success | Errors |
  |--------|------|------|------|---------|--------|
  | POST | `/order/:id/complete` | `JwtGuard @Auth()` owner-or-Admin | `{}` empty body — `CompleteOrderDto` with no fields; any `items[]`, `paymentId`, `amount`, `reservationId` rejected `400` via `ValidationPipe forbidNonWhitelisted` | `200 { id, status:COMPLETED, total, items:[{productId,quantity,unitPrice,subtotal}], reservationId, reservation:{id,status:COMPLETED,expiresAt}, inventoriesAffected:[{inventoryId,stock,reservedAmount,available}] }` (or minimal `{ id, status, reservationId }` if plan keeps payload small — decision in plan, but MUST include `status=COMPLETED` and `reservationId`) | `400 validation`, `401 unauth`, `403 owner mismatch`, `404 order/reservation/inventory not found`, `409 invalid transition / insufficient stock / already CANCELLED/FAILED` |
  | PATCH | `/order/:id/complete` | alias to POST (optional, for consistency with `PATCH /reservations/:id/complete` history) | same | same | same |
  | GET | `/order/:id` | `JwtGuard + assertOwner` (existing) | — | `200 Order COMPLETED with items + reservationId` (historical `unit_price` frozen) | `403`/`404` |
  | GET | `/order` | `JwtGuard` paginated owner-scoped (existing) | query `page,limit,status` | `200 { data, meta }` paginated `created_at DESC` | `401`/`400` |
  | GET | `/reservations/:id` | existing | — | `200 Reservation COMPLETED` | `403`/`404` |

  `POST /reservations/:id/complete` MUST remain `Admin`-only (`User→403`); the Order completion endpoint is the **user-facing** sale path. Direct reservation completion by User is still blocked to keep `Order` and `Reservation` consistent (single producer: Order).

- **FR-005**: System MUST be **safe under concurrent completion races**. Correctness is via row-level `FOR UPDATE` on `Order` first, then `Reservation`, then sorted `Inventories` inside the transaction (same deterministic ordering as checkout). The first committer's `reserved→stock` mutation wins; the second transaction after acquiring locks sees `Order COMPLETED` (idempotent) or `Reservation COMPLETED` and returns `200` without re-mutating, or if it raced with `expire` sees `CANCELLED`/`EXPIRED` and gets `409`. No in-memory `available` cache drives the decision; PostgreSQL transaction is authoritative (constitution I). Transactions kept short (lock → validate → mutate → save) with no I/O inside.

- **FR-006**: System MUST **not invent a payment integration** in V1. No `Payment` entity, no Stripe/PayPal SDK, no webhook, no `paymentIntents` table. The `PENDING→COMPLETED` transition is the stand-in for "payment succeeded". The spec MUST define: on payment **success** → `Order PENDING→COMPLETED` + `Reservation RESERVED→COMPLETED` + `stock-=qty reserved-=qty`; on payment **failure** → `Order PENDING→FAILED` + `Reservation RESERVED→CANCELLED` (or `EXPIRED` if TTL) with `reserved-=qty` only and `stock` unchanged — but **failure path is not implemented as an endpoint in Phase 7 V1**; it is documented as future (`POST /order/:id/fail` or webhook) and the `FAILED` enum value is kept. Phase 7 implementation MUST NOT create a fake payment service that blocks checkout; it directly transitions on `POST /order/:id/complete`.

- **FR-007**: System MUST keep **historical price isolation** untouched. `OrderItem.unit_price` remains the snapshot taken at checkout; completion does not re-read `Product.price`, does not recalculate `Order.total`, and does not mutate `OrderItems`. Verification: create `Product price100`, checkout (`unit_price100`), complete order, update `Product price999`, fetch `GET /order/:id` → `unit_price100` still.

- **FR-008**: System MUST enforce **ownership and visibility** for completion. `assertOwner` MUST be called for `Order` (and optionally for `Reservation` via `order.userId === reservation.userId` consistency check). `User` can complete only own `PENDING` orders; `Admin` (`@Auth(UserRoles.Admin)`) can complete any. `GET /order/:id` and `GET /order` remain owner-scoped with admin `userId` filter already implemented. Error mapping: `400` validation/empty body with extra fields, `401` unauthenticated, `403` owner mismatch, `404` order/reservation/inventory missing, `409` invalid transition or DB CHECK violation, `500` unexpected only. Global `AllExceptionsFilter` serializes.

- **FR-009**: System MUST maintain **DB constraints and indexes** for the sale path (no new table; uses existing). Required that existing constraints stay enforced: `Order.total >=0` (`CHK_order_total`), `OrderItem.quantity>0`/`unit_price>=0`, `Inventory.stock>=0`/`reservedAmount>=0`/`reservedAmount<=stock` (`CHK_inventory_*`), `@Unique(orderId,productId)`, `@Index(['userId'])` + `@Index(['status'])` on `Order`, composite `@Index(['status','expiresAt'])` on `Reservation` (for worker), FK `Reservation.orderId` indexed. Phase 7 adds **no new migration** unless a missing index is proven needed by `EXPLAIN`; if a new `OrderStatus.FAILED` handling is added later it will be a separate migration. `synchronize:false` remains.

- **FR-010**: System MUST have **DB-backed tests** proving sale correctness: unit tests (mocked `EntityManager` for guards, DTO empty-body validation, `validateOrderTransition`, `assertOwner`, idempotent `COMPLETED→COMPLETED`, invalid `CANCELLED→COMPLETED` `409`); **integration tests against real PostgreSQL** for: owner completes `PENDING→COMPLETED` with `stock-=qty reserved-=qty` and `Reservation COMPLETED`; concurrent `complete` vs `complete` on same order → exactly one `stock` decrement + idempotent `200`s + `reservedAmount` never double-decremented; concurrent `complete` vs `expire` (worker `RESERVED→EXPIRED` + `Order CANCELLED`) → single winner `409`/`200`; `User` completing other user's order `403`; completing `CANCELLED`/`EXPIRED`/`FAILED` `409`; `COMPLETED` retry idempotent `200`; missing `Reservation` `404`; **E2E (supertest)** `register → add to cart → checkout → complete → GET /order/:id COMPLETED → update product price → GET /order/:id still old unit_price` and `GET /reservations/:id COMPLETED`.

---

### Key Entities

- **User**: `id uuid PK`, `firstName`, `lastName`, `email @Unique @Index`, `password nullable`, `role enum User|Admin`, `googleId/phoneNumber nullable`, `provider`, `orders OneToMany`, `cart OneToOne`. Existing; completion resolves `requestingUserId` via `@CurrentUser('sub')` + `@Auth()`.

- **Product**: `id uuid PK`, `name @Unique @Index`, `slug`, `description`, `price int CHECK >=0`, `created_at`, `inventory OneToOne`, `orderItems OneToMany`. No `stock` field. Price is snapshot source;Completion does not lock Product.

- **Inventory**: `id uuid PK`, `productId uuid FK→Product CASCADE @Unique @Index`, `stock int CHECK >=0`, `reservedAmount int CHECK >=0 CHECK <=stock`, derived `available = stock - reservedAmount` (not stored). Only mutated on checkout (`reserved+=qty`) and on completion (`stock-=qty reserved-=qty`) via transaction.

- **Cart / CartItem**: Existing; not involved in completion beyond checkout already cleared.

- **Reservation**: `id uuid PK`, `userId FK→User CASCADE @Index`, `orderId FK→Order SET NULL @Index`, `status enum RESERVED|COMPLETED|EXPIRED|CANCELLED @Index + composite @Index(['status','expiresAt'])`, `expiresAt timestamptz`, `createdAt/updatedAt`, `items OneToMany`. Phase 7 transitions `RESERVED→COMPLETED` via Order completion; `COMPLETED→COMPLETED` idempotent.

- **ReservationItem**: `id uuid PK`, `reservationId FK→Reservation CASCADE @Index`, `inventoryId FK→Inventory CASCADE @Index`, `quantity CHECK >0`, `@Unique(['reservationId','inventoryId'])`. Source of truth for inventory qty to decrement.

- **Order**: `id uuid PK`, `userId FK→User CASCADE @Index(['userId'])`, `status enum PENDING|COMPLETED|CANCELLED|FAILED default PENDING @Index`, `total int CHECK >=0` (`Σ qty*unit_price`), `created_at/updatedAt`, `orderItems OneToMany`, `reservation OneToOne via Reservation.orderId`. Phase 7 adds `PENDING→COMPLETED` sale transition; `COMPLETED→COMPLETED` idempotent.

- **OrderItem**: `id uuid PK`, `orderId FK→Order CASCADE @Index @Unique(['orderId','productId'])`, `productId FK→Product RESTRICT @Index`, `quantity int CHECK >0`, `unit_price int CHECK >=0` (historical snapshot), `productNameSnapshot varchar nullable`, stored/calculated `subtotal`. Not mutated on completion.

- **CompleteOrderTransaction**: Not a DB entity; the `DataSource.transaction(manager => ...)` scope that owns `lock Order FOR UPDATE → lock Reservation FOR UPDATE → lock sorted Inventories FOR UPDATE → validate → mutate stock/reserved → save Order+Reservation`. Same pattern as Phases 3-6.

---

## 4. Success Criteria

### Measurable Outcomes

- **SC-001**: A checkout with `P-A price100 qty2 + P-B price50 qty1` where `A stock10 reserved0`, `B stock5 reserved0` succeeds → `Order PENDING total250` + `Reservation RESERVED`; then `POST /order/:id/complete` as owner succeeds → single `Order COMPLETED` + `Reservation COMPLETED`, both `Inventory` rows show `stock` decremented by ordered quantities (`A 10→8`, `B 5→4`) and `reservedAmount` back to `0` (`A 2→0`, `B 1→0`), `available` (`A 8→8`, `B 4→4` unchanged by pair), cart remains empty, all persisted in one commit and observable via `GET /order/:id` and `GET /reservations/:id` and `GET /inventory/:productId` (verified by integration test on real PostgreSQL, not mocked).

- **SC-002**: After completion, updating `Product A price 100→999` and re-fetching `GET /order/:id` still returns `OrderItem.unit_price=100` (historical isolation) and `Order.total=250` unchanged; a new checkout after price change snapshots `999` for new orders (price isolation survives completion).

- **SC-003**: Concurrent completions on same `Order PENDING` — two simultaneous `POST /order/:id/complete` → final `reservedAmount` decreases exactly once (e.g., `A reserved2→0` not `2→-2`) and `stock` decreases exactly once (`10→8` not `10→6`), both callers end with `Order COMPLETED`/`Reservation COMPLETED` (one with state-change `200`, the other idempotent `200` without re-mutation), loser creates no second `Order`/`Reservation` state and causes no partial inventory mutation (verified by parallel `Promise.all` concurrency test with real `DataSource.transaction`, `--runInBand`).

- **SC-004**: Completion with `Order CANCELLED` (expired, `Reservation EXPIRED`) or `Order FAILED` is rejected with `409 Conflict "Invalid order transition"` and after rollback verifies `Inventory stock` and `reservedAmount` unchanged (`reservedAmount` already `0` from expiry, `stock` unchanged), no `COMPLETED` state created.

- **SC-005**: Completion by non-owner `User` returns `403 Forbidden` and leaves DB unchanged (no order/reservation/inventory mutation); same completion by `Admin` succeeds `200` (admin bypass verified).

- **SC-006**: Idempotent retry: `POST /order/:id/complete` on already `COMPLETED` order returns `200` (same payload as first) and after second call `Inventory stock=8 reserved=0` still (no second `stock-=qty`); concurrent `complete` vs `expire` race → single winner, loser `409` (or `200` idempotent if it requested the winner's terminal state), inventory changed exactly once.

- **SC-007**: `GET /order` as authenticated user with `page=1 limit=10` after completions returns `{ data, meta:{ totalItems, itemCount, itemsPerPage, totalPages, currentPage } }` with `COMPLETED` orders included and filterable `?status=COMPLETED`; `GET /order/:id` as owner succeeds `200` with `reservationId` link, as non-owner `403`.

- **SC-008**: `EXPLAIN` for the completion's `SELECT ... FOR UPDATE` scan shows row-level `Lock Rows` on `Order` (PK) + `Reservation` (PK/`orderId`) + `Inventory` (PK via `In(sortedIds)`) and no table-level lock; smoke timing: completion commit holds row locks `<100ms` under no contention (observed via log, not a hard SLA); integration test asserts no deadlock when two completions touch disjoint inventories.

---

## 5. Assumptions

- **A1**: PostgreSQL is authoritative; Redis/RabbitMQ/BullMQ are never authoritative for order/reservation truth (constitution I). Phase 7 performs **no** Redis caching and **no** post-commit publish inside the transaction (`order.completed` / `reservation.completed` deferred to Phase 11 per `docs/plan.md` Phase 11); if added, publish **after commit** with failures logged not rolled back. No Redis `available` cache drives sale decision.

- **A2**: Phases 1-6 entities are correct: `Inventory`/`Product` 1-1, `Reservation`/`ReservationItem` with constraints and composite `status+expiresAt` index, `Order`/`OrderItem` with `PENDING|COMPLETED|CANCELLED|FAILED`, `Cart` with eager product, `User` with `password nullable`. No new infrastructure beyond existing `BullModule` (expiration) and optional `NOTIFICATION_SERVICE` (future events).

- **A3**: The current `Order`/`Reservation` linkage is `Reservation.orderId → Order.id` (`SET NULL`, `@Index`). Checkout creates `Reservation.orderId=Order.id` atomically (Phase 6). Completion MUST look up `Reservation` by `orderId` (not by `order.reservationId` getter) and lock it `FOR UPDATE`. No schema change to add `Order.reservationId` FK; keep single FK direction.

- **A4**: Payment is **out of scope for Phase 7 V1** (docs/plan.md §7.2 — do not invent payment provider). `POST /order/:id/complete` is an explicit state transition simulating "payment succeeded". Real payment callbacks / `Payment` entity / webhook verification are deferred to when payment requirements exist. `FAILED` status is defined but no `POST /order/:id/fail` endpoint is required to meet the exit criterion; it may be added as a stub if plan chooses to define failure rule without implementation.

- **A5**: Order completion is **owner-or-Admin** authorized. `User` can complete own `PENDING` orders; `Admin` can complete any. This differs from `PATCH /reservations/:id/complete` which is `Admin`-only — intentional: the Order path is the user-facing sale; the Reservation path remains internal/Admin to prevent `Order PENDING` vs `Reservation COMPLETED` drift.

- **A6**: TTL for checkout-created reservation remains `15 minutes` (`DEFAULT_TTL_MS`). Completion can happen any time while `RESERVED`; after `expiresAt` but before worker expiration, completion can still win the race if it locks first (see Edge Cases). No client-supplied `expiresAt` on completion.

- **A7**: Transaction boundary is `dataSource.transaction(manager => OrderCompletionService.complete(manager, userId, orderId))` with `EntityManager`; all writes via `manager.getRepository`. Same pattern as Phases 3-6 and Phase 4's `transitionWithInventoryInternal`. No Redis/RabbitMQ I/O inside.

- **A8**: Error mapping keeps Phase 4/6 conventions: `400` validation/empty body with extra fields, `401` unauthenticated, `403` owner mismatch, `404` product/inventory/order/reservation missing, `409` insufficient stock (`CHK_*` → `409`) or invalid transition or already `CANCELLED`/`FAILED`, `500` unexpected only. Global `AllExceptionsFilter` serializes.

- **A9**: Order `total` remains authoritative as sum of `quantity*unit_price` computed at checkout; completion does not recalculate or mutate `total`. Currency is not modeled.

- **A10**: Inventory `available` is derived (`stock - reservedAmount`) everywhere; no third mutable `available` column. Completion's `stock-=qty` + `reserved-=qty` keeps `available` invariant; the derivation is asserted in unit tests.

---

## 6. Dependencies

- Phase 1 `Inventory` (`InventoryService`, constraints, `InventorySeeder`, DB CHECKs, `synchronize:false`) — DONE 2026-08-21.
- Phase 2 `Reservation`/`ReservationItem` entities, indexes (composite `status+expiresAt`), `ReservationService`/`ReservationController`, `validateTransition`, `assertOwner`, migration `1755850000000` — DONE 2026-08-22.
- Phase 3 transaction-safe `ReservationService.create` (`FOR UPDATE` sorted inventories, `available` check, `reservedAmount` increment) — DONE 2026-08-30.
- Phase 4 reservation lifecycle (`complete`/`cancel`/`expire` transactional, `FOR UPDATE` Reservation+Inventories, single-winner, `COMPLETED→COMPLETED` idempotent) — DONE 2026-09-14.
- Phase 5 expiration cleanup worker (`ReservationExpirationService` + `ReservationExpirationProcessor` BullMQ repeat 30s, `EXPIRATION_MAX_RETRIES=3`, `reservation.expired` post-commit, `Order PENDING→CANCELLED` on expiry) — DONE 2026-09-21 (`specs/006...` 45 tasks, 169 tests pass).
- Phase 6 order integration (`Order` fix `ManyToMany→OneToMany`, `OrderItem` fix, `POST /order/checkout` atomic `Order+Reservation+Inventory reserved+=qty`, `GET /order`/`GET /order/:id` owner-scoped, checkout-only reservation refactor `User→403` on `POST /reservations`/`PATCH .../complete|cancel`) — DONE 2026-09-21 (`specs/007...`, `docs/decisions/ADR-checkout-only-reservation.md`).
- `DataSource`/`EntityManager` transactional support, global `ValidationPipe` + `AllExceptionsFilter` + `Logger`, `@Auth`/`@CurrentUser` decorators, `JwtGuard`/`RolesGuard`.
- Existing modules: `products` (`Product.price`), `cart` (`CartService.clearCartForCheckout`), `users`/`auth`.

---

## 7. Out of Scope (this phase)

- Any payment provider SDK, `Payment` entity, payment intent/charge table, webhook endpoint, or funds-transfer logic — deferred until payment requirements are defined (docs/plan.md §7.2). No Stripe/PayPal/MockPay integration.
- Order cancellation / refund, `stock += qty` restoration on cancellation, cancellation state machine (`PENDING→CANCELLED` beyond expiry, `COMPLETED→CANCELLED` refund) — Phase 8. Completion only does `COMPLETED`; it does not cancel.
- Payment failure handling endpoint (`POST /order/:id/fail` → `PENDING→FAILED`) beyond defining the `FAILED` enum value and rule; implementation deferred (plan may stub it, but not required for SCs).
- Redis caching of products/orders/inventory, cache keys/TTLs/invalidation — Phase 9. Redis must not become authoritative for sale decisions.
- Rate limiting on `/order/:id/complete` — Phase 10; completion has no throttle beyond existing global limits (plan may add if trivial).
- Broader RabbitMQ/BullMQ async fan-out (`OrderCompleted` event, email, analytics) beyond optional minimal `order.completed` post-commit publish — Phase 11; Phase 7 MAY publish after commit if plan decides, but NOT inside transaction and NOT required for SCs.
- Idempotency-key header / client retry dedup framework — Phase 12; idempotency here is `COMPLETED→COMPLETED` returning `200` without re-mutation, not a generic key.
- Inventory dimension changes: new `Reservation`/`Inventory` columns, new states, multi-warehouse, backorders, partial fulfillment, split shipments — out of scope; completion is all-or-nothing per reservation.
- Frontend, GraphQL mutations for completion, email templates — out of scope; REST only.
- New cron jobs or BullMQ repeat jobs beyond existing expiration worker — out of scope.

---

## 8. Clarifications

### Session 2026-09-22 (Phase 7 kickoff)

- Q: What API should trigger sale? `POST /order/:id/complete` vs `PATCH /reservations/:id/complete` vs payment webhook? → **A: `POST /order/:id/complete` (owner-or-Admin)** is the V1 user-facing sale endpoint. `PATCH /reservations/:id/complete` stays `Admin`-only (internal). No webhook in V1; payment success is simulated by this explicit call. Plan may add `PATCH` alias for consistency but `POST` is canonical.

- Q: Should `User` be allowed to complete own order, or only `Admin`? → **A: Owner-or-Admin** (like `GET /order/:id`). `User` completing other user's order → `403`. Admin bypasses owner check. This enables e2e testing without admin fixtures while keeping ownership enforceable.

- Q: How to handle `COMPLETED→COMPLETED` retry? → **A: Idempotent `200`** (like Phase 4 `Reservation` `COMPLETED→COMPLETED`). Second call returns same `Order COMPLETED`/`Reservation COMPLETED` with no inventory re-mutation. This is safer for client retries and aligns with Phase 12 reliability goal.

- Q: Do we need a `Payment` entity or `paymentStatus` field now? → **A: No.** `docs/plan.md` §7.2 says "Do not invent a payment integration; Define payment state separately when payment requirements exist". Phase 7 keeps `OrderStatus` only; payment state is separate concern (future `Payment` entity or `paymentStatus` enum). `Order FAILED` is reserved for payment failure but not exercised beyond transition validation in V1.

- Q: What happens when completion races with expiration worker (`RESERVED→EXPIRED` + `Order CANCELLED`)? → **A: Single winner via `FOR UPDATE`**. If `complete` wins, `Order COMPLETED` `stock-=qty`; if `expire` wins, `Order CANCELLED` `reserved-=qty` only; loser gets `409` (or `200` idempotent if it asked for the winner's state). Already implemented generically in Phase 5 worker's `FOR UPDATE` pattern.

- Q: Should completion re-check `available >= qty` before `stock-=qty`? → **A: No explicit `available` check; rely on DB CHECK `stock>=0` / `reservedAmount>=0 / <=stock` as backstop** (same as Phase 4 Q2). Pre-check would be racy; the DB constraint is the source of truth. Map `23514` to `409`.

- Q: Does completion need to handle `OrderItem.productId → Inventory` indirection? → **A: No, uses `ReservationItem.inventoryId`** as source. `OrderItem` already denormalized `productId` + `unit_price`; inventory mutation follows `ReservationItem` to guarantee `reservedAmount` accounting matches checkout's increment.

- Q: Should completion publish an async event after commit? → **A: Deferred to Phase 11** (consistent with Phase 6 `order.created` deferral). If plan adds it, MUST be after commit via `ClientProxy` or `BullMQ` with `order.completed` / `reservation.completed` payload, failures logged not rolled back. Not required for SCs.

No additional `[NEEDS CLARIFICATION]` markers remain at spec authoring time. All business invariants are fully specified; plan may open ≤1 focused clarifications if research surfaces a price-recalculation or `FAILED`-path edge.

---

## 9. Acceptance Scenarios (for planning)

1. Checkout atomic (precondition): `A2 B1` stock sufficient → `POST /order/checkout` → `PENDING total250` + `OrderItems` snapshot + `RESERVED` with `orderId` + `reservedAmount` inc — one commit.
2. Sale: `POST /order/:id/complete` as owner → `200` `Order COMPLETED` + `Reservation COMPLETED` + `A stock10→8 reserved2→0`, `B stock5→4 reserved1→0` — one commit, no second `stock` move.
3. Historical price survives sale: `Product price 100→999` after complete → `GET /order/:id` still `unit_price100 total250`.
4. Invalid transition: `POST /order/:id/complete` on `CANCELLED`/`EXPIRED`/`FAILED` → `409` no inventory change.
5. Ownership: `User` completing other's order → `403`; `Admin` → `200`.
6. Idempotent retry: `POST /order/:id/complete` twice on same `COMPLETED` → both `200`, `stock` decremented exactly once.
7. Concurrent `complete` vs `complete` single winner + idempotent; `complete` vs `expire` single winner (`COMPLETED` with `stock-=qty` vs `CANCELLED` with `reserved-=qty`).

