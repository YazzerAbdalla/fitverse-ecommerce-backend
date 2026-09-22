# Mini E-Commerce Backend — Phased Manual Development Backlog

## Project Architecture

**Architecture:** NestJS Modular Monolith

**Core stack:**

* NestJS
* TypeScript
* PostgreSQL
* TypeORM
* Redis
* RabbitMQ
* BullMQ
* Docker / Docker Compose
* REST
* JWT
* Jest / Integration / E2E testing

### Core architectural rule

PostgreSQL is the source of truth for transactional business state.

Redis, RabbitMQ, and BullMQ are infrastructure components and must not become the authoritative source for:

* Inventory
* Reservations
* Orders
* Payments
* Other transactional business state

The application remains a **modular monolith**.

Do not split modules into microservices unless a demonstrated requirement appears later.

---

# Phase 0 — Existing Foundation

**Status: DONE / EXISTING**

The project already has the basic e-commerce foundation.

### Existing areas

* [x] NestJS application
* [x] TypeScript
* [x] PostgreSQL
* [x] TypeORM
* [x] Docker-based development infrastructure
* [x] Redis infrastructure
* [x] RabbitMQ infrastructure
* [x] Authentication module
* [x] Users
* [x] Products
* [x] Cart
* [x] Cart items
* [x] Basic centralized error handling
* [x] Validation infrastructure
* [x] REST API structure

### Architectural decisions already established

* [x] Modular monolith architecture
* [x] Product does not own inventory state
* [x] Inventory is a separate domain
* [x] Reservation is a separate domain
* [x] PostgreSQL is the transactional source of truth
* [x] Redis is not authoritative for inventory
* [x] Inventory concurrency must be handled at the database level
* [x] Background processing must not replace transactional consistency

### Important previous Cart/Inventory decision

The cart should not directly mutate inventory.

The inventory lifecycle belongs to the inventory/reservation/order workflow.

---

# Phase 1 — Inventory Foundation

**Status: DONE — 2026-08-21** (inventory entity, constraints, business API, REST controller, migration, tests, random seeding)

**Goal:** Introduce inventory as a first-class domain without implementing reservations yet.

## 1.1 Inventory Entity

Create the Inventory entity with:

```text
Inventory
---------
id
product_id
stock
reserved_amount
created_at
updated_at
```

### Rules

* [x] `stock >= 0` — `CHK_inventory_stock_non_negative` on `Inventory.stock`
* [x] `reserved_amount >= 0` — `CHK_inventory_reserved_non_negative`
* [x] `reserved_amount <= stock` — `CHK_inventory_reserved_lte_stock`
* [x] `product_id` references Product — `FK_inventory_productId` (`Product.id` ON DELETE CASCADE)
* [x] Decide whether one product can have exactly one inventory record — **one-to-one**, `Inventory` owns FK, `UQ_inventory_productId` + `@Index(productId)`
* [x] Add appropriate unique constraint for `product_id` — done

Do not store `available` as an independently mutable database field.

Calculate:

```text
available = stock - reserved_amount
```

## 1.2 Inventory Module

Create:

```text
inventory/
├── inventory.module.ts
├── inventory.controller.ts
├── inventory.service.ts
├── entities/
└── dto/
```

Follow the repository's existing structure rather than blindly creating this exact layout.

## 1.3 Inventory Business API

Expose business operations rather than allowing other modules to mutate the entity directly.

Conceptually:

```text
getInventory()
checkAvailability()
increaseStock()
decreaseStock()
reserve()
releaseReservation()
completeSale()
```

Exact names should follow existing project conventions.

## 1.4 Inventory Tests

* [x] Create inventory — unit `createForProduct` + integration `INSERT` succeeds
* [x] Read inventory — `getInventory` + `GET /inventory/:productId`
* [x] Calculate available quantity — `available = stock - reservedAmount` getter, integration asserts 7
* [x] Reject negative stock — `CHK` + `ConflictException`, integration `stock=-1` throws
* [x] Reject invalid reserved amount — `CHK reservedAmount>=0` and `<=stock`, integration throws
* [x] Prevent invalid inventory state — all three DB checks + `UQ productId` verified

### Phase 1 Exit Criteria

Inventory exists independently from Product and the database enforces its basic invariants. — **MET**: `Inventory` entity owns `stock`/`reservedAmount`, `Product.stock` removed, `InventoryService` is sole mutation point, REST API thin, migration `1755800000000-CreateInventoryAndDropProductStock` (seed + drop) executed, `synchronize: false`, unit 26 + integration 7 PASS, 5 products seeded with random stock 67-174.

---

# Phase 2 — Reservation Domain

**Status: DONE — 2026-08-22** (Reservation + ReservationItem entities, ReservationService/Controller, state machine, migration, REST API, tests)

**Goal:** Introduce temporary inventory ownership.

## 2.1 Reservation Entity

Create:

```text
Reservation
-----------
id
user_id
order_id nullable
status
expires_at
created_at
updated_at
```

Recommended states:

```text
RESERVED
COMPLETED
EXPIRED
CANCELLED
```

Do not add unnecessary states.

## 2.2 Reservation Item

Because checkout can contain multiple products, use:

```text
ReservationItem
---------------
id
reservation_id
inventory_id
quantity
```

Relationship:

```text
Reservation
    |
    ├── ReservationItem
    ├── ReservationItem
    └── ReservationItem
```

Each item references Inventory.

## 2.3 Reservation Module

Create a dedicated reservation module.

Responsibilities:

* [x] Create reservation (`POST /reservations` → `RESERVED`, default `expiresAt=now+15m`, validation `quantity>0`, future `expiresAt`, duplicate `inventoryId` rejected, FK `inventoryId`/`orderId` checked)
* [x] Add reservation items (`ReservationItem` with `@Unique reservationId+inventoryId`, `@Check quantity>0`, FK `inventoryId`)
* [x] Complete reservation (`PATCH /:id/complete` → `RESERVED→COMPLETED`, optional `orderId` validated)
* [x] Cancel reservation (`PATCH /:id/cancel` → `RESERVED→CANCELLED`)
* [x] Expire reservation (`PATCH /:id/expire` admin-only → `RESERVED→EXPIRED`, future worker will use `status+expiresAt` index)
* [x] Retrieve reservation (`GET /:id` owner-or-admin, `GET /` paginated owner-scoped with admin `userId` filter)
* [x] Validate reservation state transitions (`validateTransition` enforces `RESERVED→COMPLETED|EXPIRED|CANCELLED` only, others `409`)

### Phase 2 Exit Criteria

The system can represent a temporary claim on one or more inventory records. — **MET**: `Reservation` (`userId` FK CASCADE, `orderId` FK SET NULL, `status` enum, `expiresAt` timestamptz, indexes `userId/status/expiresAt/status+expiresAt`) + `ReservationItem` (unique + CHECK) entities present; `ReservationService` (EntityManager writes `create/complete/cancel/expire`, `validateTransition`, `assertOwner`) + thin `ReservationController` (6 REST routes, `Auth`/`CurrentUser`, transaction wrapping) implemented; migration `1755850000000-CreateReservationAndReservationItem` (enum, tables, indexes, FKs) executed; unit 30 + integration 8 PASS (real PostgreSQL, constraints verified); `synchronize:false`, module boundaries respected.

---

# Phase 3 — Transaction-Safe Reservation

**Status: DONE — 2026-08-30** (pessimistic `FOR UPDATE` + deterministic ordering + `available` check + `reservedAmount` increment atomic, concurrency tests)

This is the most important implementation phase.

**Goal:** Prevent overselling under concurrency.

## 3.1 Reservation Transaction

Reservation creation must execute atomically:

```text
BEGIN

    Lock inventory rows

        ↓

    Check availability

        ↓

    Increase reserved_amount

        ↓

    Create Reservation

        ↓

    Create ReservationItems

COMMIT
```

If anything fails:

```text
ROLLBACK
```

## 3.2 Row-Level Locking

Use PostgreSQL row-level locking where appropriate:

```sql
SELECT ...
FROM inventory
WHERE id = ?
FOR UPDATE;
```

For multiple inventory records:

* [x] Lock every required inventory row — `manager.find(Inventory, { where: { id: In(sortedIds) }, lock: { mode: 'pessimistic_write' } })` in `src/modules/reservation/reservation.service.ts:79-87`
* [x] Use a deterministic ordering when acquiring multiple locks — `sortedIds = [...new Set(dto.items.map(i=>i.inventoryId))].sort()` lexicographic
* [x] Avoid unnecessary locking — only requested `Inventory` rows locked, no table-level lock
* [x] Keep the transaction short — lock→check `available`→increment `reservedAmount`→insert `Reservation`+`ReservationItem`s only, no Redis/RabbitMQ I/O

Deterministic lock ordering is important because multiple-resource transactions can otherwise create unnecessary deadlock risk.

## 3.3 Availability Rule

For every inventory record:

```text
available = stock - reserved_amount
```

Reservation succeeds only when:

```text
available >= requested_quantity
```

## 3.4 Concurrency Test

Test:

```text
stock = 10
reserved = 8

User A requests 2
User B requests 2
```

Expected:

```text
User A → SUCCESS
User B → INSUFFICIENT INVENTORY
```

Never:

```text
A → SUCCESS
B → SUCCESS
```

### Phase 3 Exit Criteria

Concurrent reservation requests cannot oversell inventory. — **MET**: `ReservationService.create` now atomically `FOR UPDATE` locks sorted inventories, checks `available >= requested` per item, increments `reservedAmount` via `EntityManager` inside `dataSource.transaction`, rolls back on any `409/404/400`; concurrency test `stock=10,reserved=8 qty=2 vs qty=2 → one 201 one 409 final reserved=10` + opposite-order deadlock-avoidance test + disjoint row-level test in `src/modules/reservation/test/reservation.integration.spec.ts`; unit tests 33 PASS (lock ordering, insufficient rejection, multi-item rollback) + integration 14 (real PG when available).

---

# Phase 4 — Reservation Lifecycle

**Status: DONE — 2026-09-14** (transactional `RESERVED→COMPLETED` `stock-=qty` `reserved-=qty`, `RESERVED→CANCELLED/EXPIRED` `reserved-=qty`, `FOR UPDATE` Reservation-first + sorted Inventories, immediate admin expire override, orderId overwrite, idempotent `COMPLETED→COMPLETED` `200`, single-winner races)

**Goal:** Make reservation state transitions explicit and safe.

## 4.1 Reservation Creation

```text
NONE
 ↓
RESERVED
```

When created:

```text
inventory.reserved_amount += quantity
```

## 4.2 Reservation Completion

```text
RESERVED
 ↓
COMPLETED
```

On successful sale:

```text
stock -= quantity
reserved_amount -= quantity
```

Example:

```text
Before:

stock = 10
reserved = 3
available = 7

After sale:

stock = 7
reserved = 0
available = 7
```

## 4.3 Reservation Cancellation

```text
RESERVED
 ↓
CANCELLED
```

Release:

```text
reserved_amount -= quantity
```

Stock does not change.

## 4.4 Reservation Expiration

```text
RESERVED
 ↓
EXPIRED
```

Release:

```text
reserved_amount -= quantity
```

Stock does not change.

## 4.5 State Transition Rules

Implement explicit transition rules.

Invalid examples:

```text
COMPLETED → EXPIRED
COMPLETED → CANCELLED
EXPIRED → COMPLETED
CANCELLED → COMPLETED
```

must not be silently accepted.

### Phase 4 Exit Criteria

Every reservation has a well-defined lifecycle and inventory remains synchronized with the reservation state. — **MET**: `ReservationService.transitionWithInventoryInternal` now atomically `FOR UPDATE` locks Reservation then sorted Inventories, `RESERVED→COMPLETED` (`stock-=qty`+`reserved-=qty`, orderId overwrite, idempotent `COMPLETED→COMPLETED` `200` per Q4) vs `RESERVED→CANCELLED/EXPIRED` (`reserved-=qty` only, stock unchanged, immediate admin `expire` per Q1, `CANCELLED/EXPIRED→*` remain `409` per Q5), DB `CHECK` backstop per Q2; `ReservationController` wraps in `dataSource.transaction`; unit 33 + integration 89 PASS (`--runInBand`), manual `verify-phase4-simple.ts` (complete/cancel/expire/concurrent/orderId) PASS.

---

# Phase 5 — Reservation Expiration / Cleanup

**Status: DONE — 2026-09-21** (BullMQ repeat 30s / 60s SLA, `FOR UPDATE` single-winner, batch paging, Redis tick lock + poison TTL, `reservation.expired` post-commit; `specs/006-reservation-expiration-cleanup` 45 tasks, `npm run test -- --runInBand` 20 suites 169 tests pass, `npm run build` pass)

**Goal:** Automatically release expired inventory.

## 5.1 Expiration Source of Truth

The authoritative rule is:

```text
expires_at <= current_time
```

The database field determines whether a reservation is expired.

The cleanup worker does not define expiration.

It only discovers and processes expired reservations.

## 5.2 Cleanup Process

Conceptually:

```sql
WHERE status = 'RESERVED'
AND expires_at <= NOW()
```

For each candidate:

```text
BEGIN

    Lock reservation

        ↓

    Verify status is still RESERVED

        ↓

    Lock relevant inventory

        ↓

    Release reserved quantity

        ↓

    Mark reservation EXPIRED

COMMIT
```

## 5.3 Race Conditions

Handle cases such as:

```text
Cleanup worker
       +
Checkout completion
       +
Cancellation
```

happening concurrently.

Only one state transition should win.

The losing operation must safely detect that the reservation is no longer `RESERVED`.

## 5.4 Cleanup Job

Use the project's existing background-job infrastructure.

Decide during implementation whether this workload belongs in:

* BullMQ
* NestJS scheduler
* another already-existing mechanism

Do not introduce infrastructure without a reason.

  ### Phase 5 Exit Criteria

  Expired reservations eventually release inventory and concurrent expiration/completion/cancellation cannot corrupt inventory. — **MET 2026-09-21**: `ReservationExpirationService` (`findExpiredCandidateIds` `status=RESERVED AND expiresAt<=NOW()` + per-candidate `FOR UPDATE` via builder `ReservationTransitionBuilder` `src/modules/reservation/reservation-transition.builder.ts`) + `ReservationExpirationProcessor` (`@Processor concurrency:1` + Redis `SET NX expiration:tick:lock` `src/modules/reservation/reservation-expiration.processor.ts:52` + BullMQ repeat `30s`/`EXPIRATION_CRON` jobId singleton) + Redis poison `expiration:poison:count/quarantine` `24h TTL` (`src/modules/reservation/reservation-expiration.service.ts:19`, `EXPIRATION_MAX_RETRIES=3`) + RabbitMQ `reservation.expired` post-commit (`spec.md` Q3, `.env.example:34`); SC-001..008 verified in `src/modules/reservation/test/expiration.integration.spec.ts` (single/multi-item, immunity, worker-vs-complete/cancel/worker single-winner, idempotency, batch 25/10, EXPLAIN composite index `status+expiresAt`, poison 3→quarantine); `jest --runInBand` now default (`package.json:16`, `transformIgnorePatterns` for `@nestjs/bullmq` ESM).

---

# Phase 6 — Order Integration

**Status: DONE — 2026-09-21** (checkout-only reservation refactor, `POST /order/checkout` atomic, Order/OrderItem fix, migration, expiration auto-cancel)

**Goal:** Connect reservations to Orders.

## 6.1 Order Model

Conceptually:

```text
Order
-----
id
user_id
status (PENDING|COMPLETED|CANCELLED|FAILED)
total
created_at
updated_at
```

Order item:

```text
OrderItem
---------
id
order_id
product_id
quantity
unit_price (historical snapshot)
productNameSnapshot
subtotal (generated)
```

## 6.2 Historical Price

When the order is created:

```text
unit_price = Product.price
```

The OrderItem keeps this value.

Historical orders must not depend on the current Product price.

## 6.3 Checkout Flow

Implemented as single `DataSource.transaction`:

```text
Client
  ↓
Cart (load via manager, validate non-empty)
  ↓
Checkout (sortedIds deterministic)
  ↓
Lock Inventories FOR UPDATE
  ↓
Check available = stock - reservedAmount
  ↓
Reserve inventory (reservedAmount+=qty)
  ↓
Create order (PENDING, total=Σ qty*price)
  ↓
Create order items (snapshot price)
  ↓
Create reservation (RESERVED, expiresAt now+15m, orderId) via createForCheckout (no re-lock)
  ↓
Clear cart (manager.delete)
  ↓
Commit
```

Cart-only: `POST /order/checkout` `{}` empty body, explicit `items[]` rejected `400` via `forbidNonWhitelisted`.

## 6.4 Important Unresolved Requirement

Before implementation, decide:

```text
When does inventory become reserved?
```

**Decision: C. When order is created** inside the single checkout transaction (Session 2026-09-21 Q1-Q5 + checkout-only directive). Adding to cart only does optimistic `available` check, never mutates `reservedAmount`.

### Phase 6 Exit Criteria

A successful checkout produces a consistent Order + OrderItems + Reservation + Inventory state. — **MET 2026-09-21**: `Order` fixed (`ManyToMany`→`OneToMany`, `SUCCESS/FAILD`→`PENDING|COMPLETED|CANCELLED|FAILED`, `total` `CHECK>=0`, indexes `userId/status`) + `OrderItem` fixed (`Unique(orderId,productId)`, `CHECK quantity>0`, `CHECK unit_price>=0`, `productId` FK RESTRICT) via migration `1755900000002-OrderIntegrationCheckoutOnly`; `POST /order/checkout` (`OrderCheckoutService` `DataSource.transaction`, sorted `FOR UPDATE`, `available` check, `createForCheckout` without re-lock, `clearCartForCheckout` via `EntityManager`) + `GET /order` paginated owner-scoped + `GET /order/:id` owner check via `OrderService`; `Reservation` refactor (`POST /reservations` `User→403 Use POST /order/checkout`, `PATCH :id/complete|cancel` `User→403`, `createForCheckout` internal) + `CartService.clearCartForCheckout`; expiration worker extended to auto-cancel `Order PENDING→CANCELLED` atomically with `Reservation EXPIRED`; `npm run build` + `npm run test -- --runInBand` pass, `docs/decisions/ADR-checkout-only-reservation.md` recorded.

---

# Phase 7 — Order Completion / Sale

**Status: DONE — 2026-09-22** (order sale `POST /order/:id/complete` owner-or-Admin, `Order PENDING→COMPLETED` + `Reservation RESERVED→COMPLETED` + `stock-=qty reserved-=qty` transactional, idempotent `COMPLETED→COMPLETED`, no Payment entity, concurrency single-winner)

**Goal:** Convert reserved inventory into sold inventory.

## 7.1 Successful Completion

Conceptually:

```text
Reservation
    ↓
COMPLETED

Inventory:
stock -= quantity
reserved_amount -= quantity
```

This must be transactional.

## 7.2 Payment

The project currently does not define a payment provider.

Therefore:

* [x] Do not invent a payment integration — Phase 7 keeps `OrderStatus` only, no `Payment` entity/webhook (spec Q3)
* [x] Define payment state separately when payment requirements exist — `OrderStatus.FAILED` defined guard-only, `PENDING→FAILED` `409` reserved for future
* [x] Specify what happens when payment fails — `PENDING→FAILED` + `reserved-=qty` only (stock unchanged), not implemented as endpoint in V1, documented in `specs/008-order-completion-sale/spec.md` FR-006
* [x] Specify what happens when payment succeeds — `POST /order/:id/complete` `PENDING→COMPLETED` + `RESERVED→COMPLETED` + `stock-=qty reserved-=qty` via `OrderCompletionService`

### Phase 7 Exit Criteria

A completed sale permanently decreases stock while releasing its reservation. — **MET 2026-09-22**: `POST /order/:id/complete` (owner-or-Admin, `CompleteOrderDto` empty, `ValidationPipe` 400, `assertOwner` 403, `validateOrderTransition` 409, `FOR UPDATE` Order→Reservation→sorted Inventories, `CHK 23514→409`, idempotent `COMPLETED→COMPLETED` 200) + `PATCH` alias; `npm run build` + `npm run test -- --runInBand` 19 unit + 10 integration (SC-001 sale + historical price + ownership + invalid + missing 404, concurrency `complete vs complete` / `complete vs expire` single-winner) pass, real PostgreSQL verified.

---

# Phase 8 — Order Cancellation

**Status: NOT DONE**

**Goal:** Define and implement inventory behavior when orders are cancelled.

## 8.1 Cancellation Before Sale

If inventory is still reserved:

```text
reserved_amount -= quantity
```

Stock remains unchanged.

## 8.2 Cancellation After Sale

If inventory has already been sold:

```text
stock += quantity
```

The exact behavior depends on the business meaning of cancellation/refund.

## 8.3 Required Order State Machine

Before coding cancellation:

* [ ] Define Order statuses
* [ ] Define valid transitions
* [ ] Define cancellation rules per status
* [ ] Define inventory effect per status
* [ ] Define payment/refund behavior

### Phase 8 Exit Criteria

Cancellation cannot accidentally double-release or double-return inventory.

---

# Phase 9 — Redis / Caching

**Status: PARTIALLY DONE / INFRASTRUCTURE EXISTS**

Redis already exists in the project infrastructure.

The remaining work is deciding where caching actually provides value.

## Tasks

* [ ] Define product cache strategy
* [ ] Define cache keys
* [ ] Define TTLs
* [ ] Invalidate cache after product mutation
* [ ] Test cache miss
* [ ] Test cache hit
* [ ] Test invalidation

Example:

```text
product:{productId}
```

## Important Rule

Do NOT use Redis as the authoritative inventory store.

Never make:

```text
Redis inventory
    ↓
reservation decision
```

the source of truth.

The authoritative path is:

```text
PostgreSQL transaction
    ↓
Inventory row
    ↓
Reservation
```

---

# Phase 10 — Rate Limiting

**Status: PARTIALLY DONE / INFRASTRUCTURE DIRECTION EXISTS**

The application already has rate-limiting requirements.

Remaining work:

* [ ] Define protected endpoints
* [ ] Define limits per endpoint/use case
* [ ] Decide whether distributed rate limiting is required
* [ ] Use Redis for shared state when multiple API instances are used
* [ ] Test rate-limit behavior
* [ ] Test behavior when Redis is unavailable

Rate limiting must never compromise transactional inventory correctness.

---

# Phase 11 — Asynchronous Events / Notifications

**Status: NOT DONE**

**Goal:** Separate non-critical work from the transactional path.

The core pattern should be:

```text
Database Transaction
        ↓
Commit
        ↓
Event / Job
        ↓
Worker
        ↓
Notification / Integration
```

Potential events:

```text
OrderCreated
OrderCompleted
OrderCancelled
ReservationExpired
```

Potential consumers:

```text
Notification worker
Email service
External integration
Analytics
```

## RabbitMQ

Use RabbitMQ where asynchronous messaging between components/workflows provides value.

## BullMQ

Use BullMQ where the workload is naturally a background job:

```text
Reservation cleanup
Notification retries
Scheduled processing
```

The exact division between RabbitMQ and BullMQ remains a design decision.

### Phase 11 Exit Criteria

Asynchronous failures do not roll back already committed business transactions.

---

# Phase 12 — Reliability / Idempotency

**Status: NOT DONE**

This phase becomes important once background processing and events exist.

## Tasks

* [ ] Identify retryable operations
* [ ] Make reservation expiration idempotent
* [ ] Make notification jobs idempotent
* [ ] Prevent duplicate order completion
* [ ] Prevent duplicate inventory release
* [ ] Define event/job retry behavior
* [ ] Define failure handling

Example:

If the cleanup worker processes the same reservation twice:

```text
First attempt:
RESERVED → EXPIRED
reserved_amount -= quantity

Second attempt:
reservation is already EXPIRED
→ do nothing
```

The second attempt must not subtract inventory again.

---

# Phase 13 — Database Constraints & Indexes

**Status: PARTIALLY DONE / DESIGN DEFINED, IMPLEMENTATION NOT COMPLETE**

## Constraints

Implement where appropriate:

```text
stock >= 0
reserved_amount >= 0
reserved_amount <= stock
quantity > 0
price >= 0
```

## Indexes

Evaluate based on actual queries:

```text
users.email

inventory.product_id

reservation.status
reservation.expires_at
reservation.user_id
reservation.order_id

reservation_item.reservation_id
reservation_item.inventory_id

order.user_id

order_item.order_id
```

Do not blindly create every proposed index.

Verify query patterns first.

### Phase Exit Criteria

The database enforces important business invariants and common access paths are indexed appropriately.

---

# Phase 17 — Refresh Token (Future)

**Status: NOT DONE — planned 2026-09-23 (future, before final testing)**

**Goal:** Add stateless JWT **refresh token rotation** so clients can silently obtain new `accessToken` without re-login, while preserving `tokenVersion` revocation and without making Redis/RabbitMQ authoritative for auth.

This phase is **orthogonal** to Phases 7-8 (order) and 9-13 (infra). It extends Phase 16 Auth Upgrades (which shipped `tokenVersion` stateless revocation and `JWT_EXPIRES_IN=15m` in `005-auth-upgrades`) but was deliberately deferred from Phase 16 V1 (password-only login) because `POST /auth/login` already works for manual E2E. It must be implemented **before** `Phase 14 — Testing` in the roadmap so final `npm run test:e2e` can cover `register → login → refresh → cart → checkout → complete` without 401 flakes.

## 17.0 Current Auth Snapshot (what exists, 2026-09-22)

```text
auth.controller.ts : POST /auth/register, POST /auth/login (LocalAuthGuard → AuthService.login → JwtService.sign {sub,email,fullName,role,tokenVersion} 15m), POST /auth/forgot-password|validate-reset-token|reset-password, POST /auth/otp/request|verify → 501 TODO, GET /auth/google|/google/callback
auth.service.ts    : register (bcrypt 10, duplicate 400), userValidation (bcrypt.compare), login (sign 15m), requestPasswordReset/validateResetToken/resetPassword (sha256 hash, FOR UPDATE, tokenVersion++), requestWhatsAppOtp/verifyWhatsAppOtp (Redis TTL 5m, hash, 501 guard), handleGoogleLogin (auto-link verified email)
users.entity.ts    : id uuid, email @Unique, password nullable, phoneNumber/@Index, phoneVerified, googleId/@Index, provider enum local|google, tokenVersion int default 0, passwordChangedAt timestamptz nullable, emailVerified
guards             : LocalAuthGuard, JwtGuard (passport-jwt validates tokenVersion === user.tokenVersion else 401), RolesGuard via @Auth, RateLimitGuard (Redis, 5-10/hour, fail-open)
config             : JWT_SECRET, JWT_EXPIRES_IN=15m, RESET_TOKEN_TTL=15m, OTP_TTL=5m
migration          : 1755900000000-AuthUpgradesUserAndResetToken (tokenVersion + phone/google/provider + password nullable)
Gap                : no RefreshToken persistence, no POST /auth/refresh, no POST /auth/logout, no refresh rotation, no HttpOnly cookie vs Authorization: Bearer refresh header decision
```

Manual E2E today (`docs/manual-e2e-test-flow.md:§1.5`) expects `POST /auth/refresh` → `404` and documents re-login on `401`. This phase will make it `200`.

## 17.1 User-facing flow

```text
POST /auth/login {email, password} → 200 {accessToken (15m), refreshToken (7d)}  // or refresh via HttpOnly cookie + body accessToken
        ↓ (client stores refreshToken secure, accessToken in memory)
GET /order (Authorization: Bearer <accessToken>) → 200  (while accessToken valid)
        ↓ (accessToken expires 15m later)
GET /order → 401 { message: "Unauthorized" }  (JwtGuard tokenVersion check still passes but exp fails)
        ↓
POST /auth/refresh { refreshToken }  (or Cookie: refresh_token=...) → 200 {accessToken, refreshToken: <rotated>}
        ↓ (server: hash refreshToken, lookup DB, verify not expired/revoked/used, check user tokenVersion, rotate: invalidate old hash, issue new pair, set cookie)
GET /order (new accessToken) → 200
        ↓
POST /auth/logout { refreshToken } → 200 (revoke this refreshToken)  // or POST /auth/logout-all → revoke all for user (tokenVersion++ alternative)
```

Anti-replay: refresh token is **single-use rotation** — each `POST /auth/refresh` invalidates the used `tokenHash` (`revokedAt`/`usedAt` set) and issues a new one. Reuse of an already-rotated token → `401 Invalid or expired refresh token` and (option) revoke all tokens for that user (detect theft).

## 17.2 Data model

**New entity `RefreshToken` (PostgreSQL source of truth, not Redis):**

```text
RefreshToken
------------
id          uuid PK @PrimaryGeneratedColumn('uuid')
userId      uuid FK → User.id ON DELETE CASCADE @Index
tokenHash   varchar(255)  -- sha256 hex of rawRefreshToken; @Index for lookup (unique where revokedAt IS NULL?)
expiresAt   timestamptz   -- now + REFRESH_TOKEN_TTL (7d default)
revokedAt   timestamptz nullable  -- set on use / logout
createdAt   timestamptz @CreateDateColumn
-- constraints: CHECK expiresAt > createdAt, INDEX (userId, expiresAt), INDEX (tokenHash), partial unique tokenHash WHERE revokedAt IS NULL (optional)
```

Alternative considered: JWT as refresh token (self-contained, no DB) — rejected: cannot revoke individually without `tokenVersion++` nuking all sessions; opaque random token + hash allows selective revocation and single-use rotation with low audit surface (same decision as `PasswordResetToken` in §16.1.2). JWT `refresh_token` could still be used with `jti` + DB, but opaque is simpler.

**Token generation:**

```text
rawRefresh = crypto.randomBytes(32).toString('hex') // 64 chars, 256 bits, same as PasswordResetToken
tokenHash  = crypto.createHash('sha256').update(rawRefresh).digest('hex')
store tokenHash + expiresAt (now+7d), return rawRefresh once (never log rawRefresh)
```

Expiry: `REFRESH_TOKEN_TTL=7d` (env, default `7d`, access `15m`), single-use rotation, nightly cleanup may purge `expiresAt < NOW() - 30d`.

**Alter `User`:** No schema change beyond `tokenVersion` already present; `tokenVersion` remains the global revocation nuke (e.g., `POST /auth/logout-all` or `reset-password` increments it, which implicitly invalidates all refresh tokens because `JwtStrategy` checks `tokenVersion` and `POST /auth/refresh` also checks `user.tokenVersion === payload.tokenVersion` before issuing new accessToken).

## 17.3 Business API (AuthService)

```text
login(email,password): Promise<{accessToken, refreshToken}>  // extended to also create RefreshToken row (hash+7d) and return rawRefresh
  - existing login logic + within same request (after sign):
      rawRefresh = crypto.randomBytes(32).toString('hex')
      tokenHash = sha256(rawRefresh)
      expiresAt = now + REFRESH_TOKEN_TTL
      manager.getRepository(RefreshToken).save({userId, tokenHash, expiresAt})
      return {accessToken, refreshToken: rawRefresh}  // and optionally Set-Cookie

refresh(dto:{refreshToken}): Promise<{accessToken, refreshToken}>
  - hash rawRefresh, SELECT RefreshToken FOR UPDATE where tokenHash = hash AND userId = payload.sub (extracted via JwtService.verify with ignoreExpiration? better lookup by hash alone then verify exp)
  - throw 401 if not found / revokedAt not null / expiresAt <= now
  - load User by userId, verify user exists and (user.tokenVersion === refreshTokenPayload.tokenVersion? if refresh is JWT; if opaque, just check user exists)
  - within transaction:
      UPDATE RefreshToken SET revokedAt=NOW() WHERE id=:id  // invalidate used token
      // rotation: create new RefreshToken row with new hash+expiresAt
      // issue new accessToken via JwtService.sign({sub,email,fullName,role,tokenVersion:user.tokenVersion})
      // issue new rawRefresh + hash
  - after commit: return {accessToken, refreshToken: newRaw}
  - rate-limit outside service (RateLimitGuard) — see 17.5

logout(dto:{refreshToken}): Promise<void>
  - hash, find, SET revokedAt=NOW() WHERE userId=:userId (owner check via refresh row userId vs current user if authenticated, or allow anonymous logout by token alone with 200 anti-enum)
  - throw 401 if already revoked/expired (or 200 idempotent if logout called twice — decide in spec, default 200 idempotent like COMPLETED→COMPLETED)

logoutAll(userId): Promise<void>
  - increment User.tokenVersion (same as reset-password does) → all access+refresh tokens revoked atomically; also SET revokedAt=NOW() for all RefreshToken where userId and revokedAt IS NULL
```

All writes inside `dataSource.transaction` with `EntityManager`; no Redis I/O inside.

## 17.4 REST API

| Method | Path | Auth | Body | Success | Errors |
|--------|------|------|------|---------|--------|
| POST | `/auth/login` | public | `{email,password}` | `200 {accessToken, refreshToken}` + optional `Set-Cookie: refresh_token=<refreshToken>; HttpOnly; Secure; SameSite=Strict; Path=/auth; Max-Age=604800` | `401` bad creds, `429` rate limit |
| POST | `/auth/refresh` | public (refreshToken in body or cookie) | `{refreshToken}` or `{}` with cookie | `200 {accessToken, refreshToken}` (rotated) + new cookie | `401` invalid/expired/revoked, `429` rate limit |
| POST | `/auth/logout` | public (or `JwtGuard` if using accessToken + refreshToken body) | `{refreshToken}` | `200 {message:"Logged out"}` (idempotent 200 if already revoked) | `401` if refresh not found and we choose strict, else `200` anti-enum |
| POST | `/auth/logout-all` | `JwtGuard` | `{}` | `200 {message:"All sessions revoked"}` | `401` unauth |

DTOs: `RefreshTokenDto` (`@IsString` `@Length(64,64)` hex, or `@IsJWT` if JWT refresh), `LoginDto` extended. Reuse global `ValidationPipe`.

Cookie vs body decision (clarify in spec): **body + HttpOnly cookie dual** — return refresh in `Set-Cookie` and also in JSON for non-browser clients (Postman). Refresh endpoint accepts either `Body.refreshToken` or `Cookie.refresh_token`. Document in Swagger as `Refresh via Cookie or Body`.

## 17.5 Security / constraints

* [ ] `tokenHash` is `sha256`, never store rawRefresh, never log rawRefresh (hashed prefix only via Logger)
* [ ] Expiry enforced in DB (`CHECK expiresAt > createdAt`) and service (`expiresAt > now`)
* [ ] Single-use rotation (`revokedAt` set on `refresh`); second use of same `refreshToken` → `401` and optionally revoke all for user (theft detection)
* [ ] `tokenVersion` revocation preserved: `reset-password` increments `tokenVersion` → all outstanding `accessToken` + `refreshToken` fail `tokenVersion` check → force re-login (no separate refresh revocation table scan needed)
* [ ] Rate limit `POST /auth/refresh` per IP `10/hour` + per `refreshToken` hash `5/hour` via Redis `INCR+EXPIRE` fail-open (reuse `RateLimitGuard`)
* [ ] Refresh token theft detection: if rotation reuse detected, revoke all `RefreshToken` for that `userId` (`SET revokedAt=NOW() WHERE userId=:id AND revokedAt IS NULL`) and log `Logger.warn` with hashed prefix
* [ ] `REFRESH_TOKEN_TTL=7d` (env), `JWT_EXPIRES_IN=15m` stays; nightly cleanup job may purge `expiresAt < NOW() - 30d`
* [ ] Transport: `HttpOnly` cookie `Secure` in prod, `SameSite=Strict`, `Path=/auth/refresh`; body fallback for non-browser

## 17.6 Configuration (`.env` additions, `ConfigService`)

```text
# Refresh token (new, Phase 17)
REFRESH_TOKEN_TTL=7d
REFRESH_TOKEN_COOKIE_NAME=refresh_token
REFRESH_TOKEN_COOKIE_SECURE=true  # false in DEV
# Existing (unchanged)
JWT_SECRET=...
JWT_EXPIRES_IN=15m
RESET_TOKEN_TTL=15m
```

All read via `ConfigService`; never hardcode.

## 17.7 Implementation Plan (Spec Kit tasks, before Testing)

```text
1. Spec: /speckit.specify refresh-token (login + refresh + logout + rotation) → clarify Q&A (body vs cookie, theft detection, logoutAll scope, TTLs)
2. Design: data-model.md (RefreshToken entity, User.tokenVersion reuse), research.md (opaque vs JWT jti, rotation vs reuse, cookie vs header)
3. Contract: OpenAPI for POST /auth/refresh, POST /auth/logout(-all) + updated POST /auth/login response
4. Migration: RefreshToken entity + repo + indexes (userId, tokenHash, expiresAt) + partial unique (synchronize:false)
5. Service: AuthService.login extension (create RefreshToken), refresh, logout, logoutAll with FOR UPDATE + revocation
6. Controller: POST /auth/refresh (public, RateLimitGuard), POST /auth/logout(-all) (JwtGuard), Set-Cookie handling, Swagger
7. Unit tests: login creates hashed refresh +7d, refresh rotation single-use → new pair + old revoked, second use 401, expired 401, revoked 401, logout idempotent 200, logoutAll increments tokenVersion + revokes all
8. Integration tests: real PG transaction, concurrent refresh with same token → one 200 one 401 theft→revoke all, DB constraints partial unique
9. E2E: register→login→GET /order → wait 15m or mock exp → POST /auth/refresh → GET /order with new accessToken 200 → POST /auth/logout → refresh again 401 → GET /order still 200 until access exp
10. Docs: docs/architecture/modules.md, docs/decisions/ADR-refresh-token.md, Swagger, Postman, docs/manual-e2e-test-flow.md §1.5 updated (200 not 404)
```

## 17.8 Testing (must cover)

**Unit (mock repos, mock Redis):**
* [ ] login: creates hashed refresh `expiresAt=now+7d`, returns rawRefresh 64 hex, stores hash
* [ ] refresh: valid → new pair + old revoked, expired → 401, revoked → 401, reused rotated → 401 + revoke all
* [ ] logout: valid → revoked, second logout same token → 200 idempotent
* [ ] logoutAll: increments tokenVersion, revokes all RefreshToken for user

**Integration (real PostgreSQL, real Redis when available):**
* [ ] DB constraints: duplicate tokenHash partial unique not violated on rotation (new row, old revoked), expired check
* [ ] Transaction: concurrent `POST /auth/refresh` with same token → one 200 + rotation, one 401 + theft revoke, no double-issue
* [ ] Rate limit: exceed → 429, Redis down → still succeeds with log

**E2E (supertest):**
* [ ] `POST /auth/register` → `POST /auth/login` → `GET /order` with accessToken 200 → `POST /auth/refresh` with refreshToken → `GET /order` with new access 200 → `POST /auth/logout` → `POST /auth/refresh` with old refresh 401
* [ ] `POST /auth/reset-password` → `POST /auth/refresh` with old refresh 401 (tokenVersion mismatch)

## 17.9 Exit Criteria

Auth refresh is complete when:

```text
[x] POST /auth/login returns 200 {accessToken (15m), refreshToken (64 hex, 7d hash stored)}
[x] POST /auth/refresh accepts refreshToken (body or HttpOnly cookie), validates hash+exp+not revoked, rotates (old revoked, new issued) inside EntityManager transaction, returns new pair; second use of old token → 401 (+ optionally revoke all for theft)
[x] POST /auth/logout (and /logout-all via tokenVersion++) revokes refresh (idempotent 200), logoutAll increments tokenVersion and revokes all
[x] RefreshToken migration applied (tokenHash, expiresAt, revokedAt, indexes, partial unique), tokenHash hashed never raw
[x] Rate limiting on /auth/refresh|/logout via Redis fail-open, Swagger updated, ADR recorded, no secrets, AllExceptionsFilter handles 401/429
[x] Unit 10+ and integration 5+ and E2E 2 flows PASS, including concurrent refresh reuse → single winner + theft revoke
```

## 17.10 Out of Scope (this phase)

* Refresh via sliding window extension without rotation (keep single-use rotation).
* Device fingerprint binding beyond `User-Agent` logging (future).
* Remember-me 30d vs 7d toggle per client (use same TTL, prioritize spec).
* Refresh for Google OAuth `refreshToken` itself (Google provider refresh is opaque, stored in `UserOAuthAccount` future table, not here).

---

# Phase 18 — Email Service (Future)

**Status: NOT DONE — planned 2026-09-23 (future, before final testing)**

**Goal:** Deliver transactional and marketing emails without blocking PostgreSQL transactions or making Redis/RabbitMQ authoritative: **verification email after register**, **password-reset email**, and **notifications for sales / new products** — all async after commit, with provider abstraction, rate limiting, and opt-in preferences.

This phase is **orthogonal** to Phases 7-8 (order) and 9-13 (infra) and extends Phase 16 Auth Upgrades (which added `PasswordResetToken` and `emailVerified` flag but left actual sending as `publish after commit → TODO`). It must be implemented **before** `Phase 14 — Testing` so final `npm run test:e2e` can cover `register → verify-email → login → forgot-password → reset → order` and notification idempotency without flaky `console.log` stubs.

## 18.0 Current Auth Snapshot (what exists, 2026-09-22)

```text
users.entity.ts    : emailVerified boolean default false, provider local|google, passwordChangedAt, tokenVersion
auth.service.ts    : requestPasswordReset → crypto.randomBytes 32 → sha256 hash → PasswordResetToken (expires 15m, usedAt) + FOR UPDATE + tokenVersion++ on reset; register → bcrypt 10 + UsersService.createNewUser (no email sent, only Logger.log)
auth.controller.ts : POST /auth/register, POST /auth/login, POST /auth/forgot-password|validate-reset-token|reset-password (real), POST /auth/otp/request|verify → 501 TODO
migration          : 1755900000000-AuthUpgradesUserAndResetToken (emailVerified, User alterations), 1755900000001-AddOtpVerification (otp_verification), NO EmailVerificationToken, NO EmailProvider abstraction
infra              : RabbitMQ 4 + BullMQ available (per Phase 11 plan) but not used by auth; Redis 8 for cache/rate-limit only; Swagger at /api
Gap                : no EmailProvider interface, no VerificationToken persistence, no POST /auth/verify-email|/resend-verification, no email templates, no notification preference, no sales/news broadcast job
```

Manual E2E today (`docs/manual-e2e-test-flow.md:§1.6`) calls `POST /auth/forgot-password` → `200` but **no email is sent** (only `Logger.log` + TODO `publish to RabbitMQ topic auth.password_reset_requested`). Verification after register is not sent either.

## 18.1 User-facing flows

### 18.1.1 Verification after register (verify-email)

```text
POST /auth/register {firstName,lastName,email,password} → 201 (user created, emailVerified false)
        ↓ (inside same request, after DB commit — publish after commit per constitution async rule)
  Generate EmailVerificationToken: raw = crypto.randomBytes(32).toString('hex'), hash = sha256(raw), expiresAt = now + 24h
  Store hash + expiresAt (see §18.2) + emit event
        ↓ (async, outside tx)
  RabbitMQ/BullMQ worker (EmailWorker) → EmailProvider.sendVerification(to: email, link: https://app.example.com/verify-email?token=<raw>&email=<email>, template: verify)
        ↓
GET /auth/verify-email?token=<raw>&email=<email> → 200 {verified:true} (or POST /auth/verify-email {email, token} for body)
        ↓
  SELECT EmailVerificationToken FOR UPDATE where tokenHash=hash AND userId=user.id
  Verify not expired / not usedAt, SET usedAt=NOW(), SET User.emailVerified=true (if not already)
  Publish event auth.email_verified {userId, email} after commit (optional)
        ↓
POST /auth/resend-verification {email} → 200 anti-enumeration (always 200, like forgot-password) — invalidates prior active tokens SET usedAt=NOW() where userId AND usedAt IS NULL, then creates new token + re-emits (RateLimitGuard 3/hour per email + 5/hour per IP, cooldown 60s)
```

Anti-enumeration: `resend-verification` returns `200 {message:"If an account exists, a verification email has been sent."}` even when email not found. Do not leak existence.

### 18.1.2 Password-reset email (upgrade of Phase 16)

Phase 16 already defines `PasswordResetToken` (hash, 15m, single-use, FOR UPDATE). Phase 18 adds the **actual sending**:

```text
POST /auth/forgot-password {email} → 200 (anti-enumeration, invalidates priors, inserts new tokenHash) (existing)
        ↓ (after commit)
  Emit auth.password_reset_requested {userId, email, rawToken, expiresAt} → RabbitMQ (NOTIFICATION_SERVICE) or BullMQ job
        ↓ (worker)
  EmailProvider.sendPasswordReset(to: email, link: https://app.example.com/reset-password?token=<raw>&email=..., template: reset, expiresIn 15m)
```

`POST /auth/reset-password` and `POST /auth/validate-reset-token` remain as in §16 (single-use, bcrypt, tokenVersion++). No new contract.

### 18.1.3 Notifications: sales and new products

*Marketing/transactional blend, opt-in, bulk, idempotent.*

```text
Admin or system trigger:
  - On admin creates sales campaign: POST /admin/notifications/sales {title, body, productIds?}  (Admin Guard) → 202 Accepted + enqueues bulk job
  - On product created (admin GraphQL createProduct): after commit → emit product.created {productId, name, price} → Notification worker fans out to opted-in users

Notification fan-out (async after commit):
  DB commit (Order/Campaign/Product)
          ↓
  Event: OrderCompleted | ProductCreated | SalesCampaignCreated {ids, title}
          ↓
  BullMQ job notification.sendBulk { template: sales|new_product, subject, body, filter: {marketingOptIn: true} }
          ↓
  Worker pages Users WHERE marketingOptIn=true (or emailVerified=true) with cursor, for each user:
    - Idempotency key: notification:send:<template>:<campaignId|productId>:<userId> → Redis SET NX EX 24h (skip duplicate)
    - EmailProvider.send(to: user.email, subject, template, variables {firstName, productName}) + Audit row NotificationLog
          ↓
  Audit table NotificationLog {id, userId, template, subject, productId|orderId nullable, sentAt, providerMessageId}
```

Preferences: `User` adds `marketingOptIn boolean default false` (opt-in at register `marketingOptIn` optional DTO field, plus `PATCH /users/me/preferences {marketingOptIn}` later) — required before bulk send to comply with policy. `emailVerified` gate: Phase 18 V1 sends verification and reset regardless of `marketingOptIn`, but sales/news only if `marketingOptIn=true AND emailVerified=true` (document in spec).

## 18.2 Data model

**Alter `User`:**

```text
User
  + marketingOptIn: boolean default false  (for sales/news, GDPR opt-in)
  # emailVerified already exists default false (Phase 16), keep
  # phoneVerified, googleId, provider, tokenVersion already exist
```

Migration must: `ALTER TABLE "user" ADD COLUMN "marketingOptIn" boolean DEFAULT false`, index not required (filter on boolean scan is fine for bulk cursor; add partial index WHERE marketingOptIn IS TRUE if scale proven).

**New entity `EmailVerificationToken`:**

```text
EmailVerificationToken
----------------------
id          uuid PK @PrimaryGeneratedColumn('uuid')
userId      uuid FK → User.id ON DELETE CASCADE @Index
tokenHash   varchar(255)  -- sha256 hex of raw token; @Index for lookup
expiresAt   timestamptz   -- now + 24h (VERIFICATION_TOKEN_TTL)
usedAt      timestamptz nullable  -- single-use, set on verify
createdAt   timestamptz @CreateDateColumn
-- constraints: CHECK expiresAt > createdAt, INDEX (userId, expiresAt), INDEX (tokenHash), UNIQUE? no — multiple per user allowed but only one active (old invalidated via usedAt)
```

Pattern mirrors `PasswordResetToken` (§16.1.2) but `TTL 24h` and separate table to avoid mixing concerns (reuse same hashing `crypto.randomBytes 32 → hex → sha256`).

**Audit table `NotificationLog` (optional but recommended for idempotency and forensics, before Phase 12):**

```text
NotificationLog
---------------
id            uuid PK
userId        uuid FK → User.id ON DELETE CASCADE @Index
template      varchar -- 'verify' | 'reset' | 'sales' | 'new_product'
subject       varchar
productId     uuid nullable FK → Product.id ON DELETE SET NULL @Index
orderId       uuid nullable FK → Order.id ON DELETE SET NULL @Index
provider      varchar -- 'noop'|'smtp'|'ses'|'sendgrid'
messageId     varchar nullable -- provider response
sentAt        timestamptz @CreateDateColumn
-- indexes: (userId, sentAt), (template, sentAt), (productId)
```

If scale > 10k users, add BullMQ job batching (`notification:batch:1` with `attempts 3`, `backoff exponential`).

**Token generation (same as §17.2):**

```text
raw = crypto.randomBytes(32).toString('hex') // 64 hex
hash = crypto.createHash('sha256').update(raw).digest('hex')
store hash, expiresAt = now + 24h, return raw once
```

## 18.3 Business API (AuthService + NotificationService)

```text
register(dto): Promise<{user, message}>  // extended after commit:
  - existing bcrypt + UsersService.createNewUser
  - after commit: await requestEmailVerification(user.email)  // fire-and-forget, never throw to caller (log only)

requestEmailVerification(email: string): Promise<void>
  - lookup user; if not found → return void (anti-enumeration, log debug only)
  - if user.emailVerified → return void (or 200 already verified)
  - within transaction (manager):
      UPDATE EmailVerificationToken SET usedAt=NOW() WHERE userId=:id AND usedAt IS NULL AND expiresAt > NOW()
      INSERT new token {userId, tokenHash, expiresAt: now+24h}
  - after commit: emit email.verification_requested {userId, email, rawToken, expiresAt} via RabbitMQ/BullMQ → worker

verifyEmail(dto:{email, token}): Promise<void>
  - hash raw token, SELECT EmailVerificationToken FOR UPDATE where tokenHash=hash AND userId=user.id
  - throw 400 if not found / expired / usedAt not null
  - transaction:
      SET token.usedAt=NOW()
      UPDATE User SET emailVerified=true WHERE id=:userId (if not already)
  - after commit: optional emit email.verified {userId}

resendVerification(email: string): Promise<void> // anti-enum, rate-limited, cooldown 60s per email, invalidates priors like above

sendPasswordResetEmail: upgrade existing requestPasswordReset — after token insert, publish auth.password_reset_requested with rawToken (already in §16.1.3, now actually consumed by EmailWorker)

NotificationService (new):
  sendSalesCampaign(dto:{title, body, productIds?}, actor: Admin): Promise<{jobId}>
    - validate admin, create campaign row? V1: no Campaign table, just enqueue job with title/body
    - BullMQ add notification.sendBulk {template: 'sales', subject: title, body, productIds}
  onProductCreated(product: Product): void  // after product commit, enqueue new_product
  onOrderCompleted(order: Order): void      // optional after Order PENDING→COMPLETED (Phase 7), enqueue sales-like notification if marketingOptIn
  worker: process bulk with pagination, idempotency Redis SET NX EX 24h + NotificationLog insert
```

All writes inside `dataSource.transaction` with `EntityManager`; no provider I/O inside tx (publish after commit per `AGENTS.md` async rule).

## 18.4 REST API

| Method | Path | Auth | Body | Success | Errors |
|--------|------|------|------|---------|--------|
| POST | `/auth/register` | public | `{firstName,lastName,email,password, marketingOptIn?}` | `201 {message}` + async verification email sent | `400` validation, `400` duplicate email, `429` rate limit |
| GET | `/auth/verify-email` | public | query `?token=<raw>&email=<email>` | `200 {verified:true}` + `emailVerified` set | `400` invalid/expired/used, `429` rate limit |
| POST | `/auth/verify-email` | public | `{email,token}` | `200 {verified:true}` | `400` invalid, `429` |
| POST | `/auth/resend-verification` | public | `{email}` | `200 {message:"If an account exists..."}` anti-enum | `400` validation, `429` cooldown 60s + 3/hour per email |
| POST | `/auth/forgot-password` | public | `{email}` | `200 {message}` (existing, now actually sends email) | `400` validation, `429` |
| POST | `/auth/validate-reset-token` | public | `{email,token}` | `200 {valid:true}` | `400` invalid |
| POST | `/auth/reset-password` | public | `{email,token,newPassword}` | `200 {message}` | `400` invalid/expired/used |
| POST | `/admin/notifications/sales` | `JwtGuard @Auth(Admin)` | `{title, body, productIds?}` | `202 {jobId}` bulk enqueued | `401`, `403`, `429` |
| PATCH | `/users/me/preferences` | `JwtGuard` | `{marketingOptIn: boolean}` | `200 {marketingOptIn}` | `401`, `400` |

DTOs: `VerifyEmailDto` (`@IsEmail`, `@IsString` token 64 hex), `ResendVerificationDto` (`@IsEmail`), `CreateSalesNotificationDto` (`@IsString title 1-200`, `@IsString body`), `UpdatePreferencesDto` (`@IsBoolean`). All `@ApiProperty`, global `ValidationPipe`.

Swagger: `@ApiOperation` per route, `GET /auth/verify-email` documented as `verify via link`.

## 18.5 Provider abstraction

Reuse pattern from WhatsApp OTP (§16.2.1) for testability:

```text
interface EmailProvider {
  send(to: string, subject: string, template: 'verify'|'reset'|'sales'|'new_product', vars: Record<string, any>): Promise<{messageId: string}>;
}
Implementations: SmtpEmailProvider (nodemailer + SMTP_HOST/PORT), SesEmailProvider, SendGridEmailProvider, NoopEmailProvider (dev/test — logs to Logger)
Config: EMAIL_PROVIDER=smtp|ses|sendgrid|noop, SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS, EMAIL_FROM="Mini E-Commerce <noreply@example.com>", EMAIL_VERIFICATION_TTL=24h, EMAIL_RESET_TTL=15m (reuse)
```

`AuthModule` imports `CacheModule` (rate-limit) + `TypeOrmModule.forFeature([EmailVerificationToken, NotificationLog])` + provider injection `EMAIL_PROVIDER`.

## 18.6 Security / constraints

* [ ] `tokenHash` sha256, never store/log raw token (Logger hashed prefix only)
* [ ] Expiry enforced DB `CHECK expiresAt > createdAt` + service `expiresAt > now`; single-use `usedAt` → second use `400`
* [ ] Rate limit `resend-verification` per IP `5/hour` + per email `3/hour`, cooldown `60s` per email via Redis `SET NX EX` fail-open; `verify-email` `10/hour` per IP
* [ ] Verification token TTL `24h` (vs reset `15m`), password rules `MinLength 8` + `newPassword !== email`
* [ ] `marketingOptIn` required for sales/news bulk (check `User.marketingOptIn && User.emailVerified`), not for verify/reset (always sent)
* [ ] Bulk idempotency: `notification:send:<template>:<campaignId|productId>:<userId>` Redis `SET NX EX 24h` before `EmailProvider.send`, plus `NotificationLog` unique guard
* [ ] Async after commit only — `EmailWorker` failures logged not rolled back, BullMQ `attempts 3` + `backoff exponential` for transient SMTP 5xx

## 18.7 Configuration (`.env` additions, `ConfigService`)

```text
# Email (new, Phase 18)
EMAIL_PROVIDER=noop              # noop|smtp|ses|sendgrid
EMAIL_FROM="Mini E-Commerce <noreply@example.com>"
SMTP_HOST=smtp.example.com
SMTP_PORT=587
SMTP_USER=
SMTP_PASS=
SMTP_SECURE=false
EMAIL_VERIFICATION_TTL=24h
EMAIL_RESET_TTL=15m              # reuse RESET_TOKEN_TTL but explicit
EMAIL_SALES_BATCH_SIZE=500
# Existing
JWT_SECRET=...
JWT_EXPIRES_IN=15m
REFRESH_TOKEN_TTL=7d
RESET_TOKEN_TTL=15m
```

All via `ConfigService`; never hardcode.

## 18.8 Implementation Plan (Spec Kit tasks, before Testing)

```text
1. Spec: /speckit.specify email-service (verify after register + reset + sales/news) → clarify Q&A (24h vs 15m, resend anti-enum, opt-in gate, provider, bulk batch size)
2. Design: data-model.md (EmailVerificationToken, User.marketingOptIn, NotificationLog), research.md (nodemailer vs SES vs SendGrid, queue choice RabbitMQ vs BullMQ for each template)
3. Contract: OpenAPI for GET|POST /auth/verify-email, POST /auth/resend-verification, POST /admin/notifications/sales, PATCH /users/me/preferences
4. Migration 1: User.marketingOptIn + EmailVerificationToken (hash, expiresAt, usedAt, indexes) + NotificationLog (optional)
5. Provider: EmailProvider interface + Smtp/Noop/Ses impl + EMAIL_PROVIDER switch + SMTP_* config + Logger
6. Service: AuthService.requestEmailVerification/verifyEmail/resendVerification (FOR UPDATE, hash, 24h, usedAt) + NotificationService.sendSales/onProductCreated with BullMQ bulk
7. Controller: GET|POST /auth/verify-email (public), POST /auth/resend-verification (RateLimitGuard), POST /admin/notifications/sales (Admin), PATCH /users/me/preferences (JwtGuard)
8. Hook: AuthService.register after-commit → requestEmailVerification (fire-and-forget), forgot-password after-commit → publish already done now actually consumed
9. Worker: EmailWorker @Processor (concurrency 5) for verify/reset/sales templates, idempotency Redis SET NX, NotificationLog insert, Set-Cookie not needed
10. Unit tests: register creates hashed verify token 24h, verify valid→emailVerified true, expired 400, used 400, resend invalidates priors + cooldown 60s, sales bulk respects marketingOptIn + emailVerified
11. Integration tests: real PG FOR UPDATE single-winner verify with same token → one 200 one 400, bulk sales 100 users paginated batch, DB constraints partial unique not needed
12. E2E: register→receive rawToken via test hook → GET /auth/verify-email → GET /users/me (emailVerified true) → forgot-password → reset → login; admin sales → verify NotificationLog per user + Redis dedup
13. Docs: docs/architecture/modules.md, docs/decisions/ADR-email-service.md, Swagger, Postman, docs/manual-e2e-test-flow.md §1 updated (200 verify)
```

## 18.9 Testing (must cover)

**Unit (mock repos, mock Redis/EmailProvider):**
* [ ] register: creates hashed verify token 24h + emits event, verify valid → emailVerified true, expired → 400, used → 400, wrong hash → 400, resend invalidates priors
* [ ] sales: marketingOptIn false → skipped, emailVerified false → skipped, bulk 100 users paginated batch + Redis dedup 24h
* [ ] reset: existing reset flow still 200 anti-enum, but now also asserts EmailProvider.send called with reset template

**Integration (real PostgreSQL, real Redis when available):**
* [ ] DB constraints: EmailVerificationToken hash insert, User.marketingOptIn default false, NotificationLog FKs
* [ ] Transaction: concurrent `POST /auth/verify-email` with same token → one 200 one 400
* [ ] Bulk sales: 25 users marketingOptIn true → 25 NotificationLog, 5 users false → 0, Redis dedup prevents double send on retry

**E2E (supertest):**
* [ ] `POST /auth/register` → capture rawToken via AuthService.lastVerificationToken (test hook) → `GET /auth/verify-email?token=&email=` → `200 {verified:true}` → `GET /users/me` → `emailVerified true` → `POST /auth/resend-verification` with same email → second token new
* [ ] `POST /admin/notifications/sales` as Admin with 10 users (5 opt-in) → `202` → worker sends 5 emails (Noop captures), 5 skipped, `GET /admin/notifications/logs` 5 rows

## 18.10 Exit Criteria

Email service is complete when:

```text
[x] POST /auth/register after commit creates sha256-hashed EmailVerificationToken expires 24h and emits email.verification_requested (async, not blocking)
[x] GET|POST /auth/verify-email validates hash+expiry+single-use inside FOR UPDATE, sets usedAt and User.emailVerified=true, 200 {verified:true}, second use 400, expired 400
[x] POST /auth/resend-verification anti-enum 200, validates E.164? email, rate-limit 3/hour per email + cooldown 60s, invalidates priors
[x] POST /auth/forgot-password → actually sends reset email via EmailProvider (Noop in dev/test, SMTP/Ses in prod) after commit (existing token flow now wired to worker)
[x] POST /admin/notifications/sales (Admin) enqueues BullMQ bulk job, worker pages Users WHERE marketingOptIn=true AND emailVerified=true, sends via EmailProvider with Redis dedup 24h + NotificationLog, idempotent on retry
[x] User.marketingOptIn migration applied, EmailVerificationToken + NotificationLog migrations, emailVerified gate for sales/news but not for verify/reset
[x] Rate limiting on verify/resend via Redis fail-open, Swagger updated, ADR recorded, no secrets, AllExceptionsFilter 400/401/429
[x] Unit 15+ and integration 7+ and E2E 2 flows PASS, including concurrent verify same token → single winner
```

## 18.11 Out of Scope (this phase)

* Unsubscribe via List-Unsubscribe header + signed token (future, keep PATCH preferences as V1 opt-out).
* Double opt-in confirmation for marketingOptIn toggle beyond emailVerified gate (V1 trusts PATCH).
* Per-user email frequency caps beyond bulk dedup (future, add EMAIL_DAILY_LIMIT).
* Template i18n / A/B testing / MJML rendering (V1 uses simple subject/body vars).

---

# Phase 19 — Payment (Stripe Test Mode, New Payment Module) (Future)

**Status: NOT DONE — planned 2026-09-23 (future, before final testing)**

**Goal:** Add a **separate `payment` module** that integrates **Stripe in test mode** to validate the real checkout → payment → order completion workflow end-to-end, without making Stripe the source of truth for inventory/orders and without leaking secrets. This replaces the current payment *simulation* (`POST /order/:id/complete` as `PENDING→COMPLETED` in Phase 7) with a realistic **PaymentIntent + webhook** flow that still keeps PostgreSQL authoritative and remains idempotent/concurrency-safe.

This phase is **orthogonal** to Phases 7-8 (order sale/cancellation) and 9-13 (infra) and extends Phase 7's `PENDING→COMPLETED`/`FAILED` states. It must be implemented **before** `Phase 14 — Testing` so final `npm run test:e2e` can cover `register → cart → checkout → create PaymentIntent (test card 4242) → confirm → webhook → COMPLETED` vs `4000000000000002` → `FAILED` without hitting live Stripe.

## 19.0 Current Snapshot (what exists, 2026-09-22)

```text
order.entity.ts      : Order {id, userId, status PENDING|COMPLETED|CANCELLED|FAILED, total int, orderItems} — PENDING created by checkout, COMPLETED via POST /order/:id/complete (simulation), FAILED guard-only (no payment row)
order-completion.service.ts : transactional FOR UPDATE Order→Reservation→Inventories, stock-=qty reserved-=qty, idempotent COMPLETED→COMPLETED, CHK 23514→409 — no Stripe call, no Payment row
reservation.service.ts : RESERVED→COMPLETED inventory math, used by checkout + completion
checkout               : POST /order/checkout {} cart-only → Order PENDING + Reservation RESERVED + reservedAmount+=qty, total Σ qty*unit_price
payment module         : DOES NOT EXIST — no Payment entity, no stripe SDK, no webhook, no POST /payments/intent, no Stripe test keys
config                 : JWT_SECRET, JWT_EXPIRES_IN=15m, RESET_TOKEN_TTL, etc. — no STRIPE_SECRET_KEY, no STRIPE_WEBHOOK_SECRET, no STRIPE_PUBLISHABLE_KEY
infra                  : RabbitMQ/BullMQ exist (Phase 11) but not used by payment; Redis cache-only
Gap                    : no test-mode Stripe integration, no PaymentIntent persistence, no webhook signature verification, no PENDING→COMPLETED via webhook (still manual POST /order/:id/complete), no idempotent webhook replay protection
```

Manual E2E today (`docs/manual-e2e-test-flow.md:§4-6`) calls `POST /order/checkout → POST /order/:id/complete` directly — no `PaymentIntent` and no `4000000000000002` failure path is exercisable.

## 19.1 User-facing flows (Stripe test mode)

### 19.1.1 Happy path — test card `4242 4242 4242 4242` → COMPLETED

```text
1. Client: POST /order/checkout {} → 201 Order PENDING total 250 + Reservation RESERVED (Phase 6)
2. Client: POST /payments/intent {orderId} → 201 {paymentId, clientSecret, amount, currency, status: PENDING, stripePaymentIntentId: pi_xxx}
        ↓ (server: FOR UPDATE Order PENDING, create Payment PENDING with amount=Order.total, currency, stripePaymentIntentId via stripe.paymentIntents.create {amount: total*100, currency:'usd', metadata:{orderId, userId}, automatic_payment_methods:{enabled:true}} in test mode)
3. Client (frontend or Postman): confirm with Stripe test card 4242424242424242 (exp 12/34, cvc 123) via stripe.confirmPayment({clientSecret}) → Stripe test → webhook
   Alternative server-test flow without frontend: POST /payments/intent already confirms test via stripe.paymentIntents.confirm(pi_xxx, {payment_method:'pm_card_visa'}) for E2E (only in test mode, never in prod)
4. Stripe (test) → POST /payments/webhook {type: 'payment_intent.succeeded', data: {object: {id: pi_xxx, metadata:{orderId}, amount}}}
        ↓ (server: verify Stripe-Signature with STRIPE_WEBHOOK_SECRET via stripe.webhooks.constructEvent, idempotent key event.id, lookup Payment by stripePaymentIntentId FOR UPDATE, verify amount == Order.total, then transactional Order PENDING→COMPLETED + Reservation RESERVED→COMPLETED + stock-=qty reserved-=qty same as Phase 7, set Payment SUCCEEDED)
5. Client: GET /order/:id → 200 COMPLETED, GET /payments/:id → 200 SUCCEEDED, GET /inventory/:productId → stock 10→8 reserved 2→0
```

### 19.1.2 Failure path — test card `4000 0000 0000 0002` → FAILED (payment declined)

```text
Same 1-2, but Stripe test → payment_intent.payment_failed (or requires_action) → webhook type payment_intent.payment_failed
        ↓
  Transactional Order PENDING→FAILED + Reservation RESERVED→CANCELLED (reserved-=qty only, stock unchanged) + Payment FAILED, client sees  GET /order/:id → FAILED, cart not cleared? Actually cart already cleared at checkout — failure does not restore cart (documented), but Inventory reserved is released so user can re-add and checkout again
```

### 19.1.3 Cancel before capture (optional)

```text
Client cancels before webhook: POST /payments/:id/cancel → 200 Order PENDING→CANCELLED + Reservation →CANCELLED (reserved-=qty) + Payment CANCELLED + stripe.paymentIntents.cancel(pi_xxx) in test mode
```

All webhook handling **after commit** per async rule, idempotent on replay.

## 19.2 Data model — new `payment` module (PostgreSQL source of truth, Stripe is *not* source)

**New entity `Payment`:**

```text
Payment
-------
id                      uuid PK @PrimaryGeneratedColumn('uuid')
orderId                 uuid FK → Order.id ON DELETE CASCADE @Unique @Index  // one Payment per Order V1
userId                  uuid FK → User.id ON DELETE CASCADE @Index
amount                  int CHECK amount >=0  // copy of Order.total at intent creation, in cents (or same unit as Order.total)
currency                varchar(3) default 'usd'  // or 'egp' per config, but Stripe test expects 'usd' for 4242
status                  enum PaymentStatus { PENDING, SUCCEEDED, FAILED, CANCELLED } default PENDING @Index
stripePaymentIntentId   varchar(64) @Unique @Index  // pi_xxx from Stripe, nullable until created? V1: set on intent creation
stripeEventId           varchar(64) nullable @Index // last webhook event id for idempotency (evt_xxx)
provider                varchar default 'stripe'  // future: 'stripe'|'paypal'
failureReason           varchar nullable  // Stripe failure message or decline code
createdAt               timestamptz @CreateDateColumn
updatedAt               timestamptz @UpdateDateColumn
-- constraints: CHECK amount >=0, @Unique(orderId), @Unique(stripePaymentIntentId), @Index([userId, status]), @Index([status, createdAt])
```

**Enum:**

```text
PaymentStatus { PENDING, SUCCEEDED, FAILED, CANCELLED }
Idempotent: PENDING→SUCCEEDED, PENDING→FAILED, PENDING→CANCELLED only; SUCCEEDED/FAILED/CANCELLED are terminal (no transitions). Webhook replays of same event.id → 200 already processed (no second inventory mutation).
```

**Alter `Order`:** No column change; `Order.status` already `PENDING|COMPLETED|CANCELLED|FAILED` — Payment `SUCCEEDED` ↔ `Order COMPLETED`, `FAILED` ↔ `Order FAILED`, `CANCELLED` ↔ `Order CANCELLED`. Keep single FK direction `Payment.orderId → Order.id`; add optional `OneToOne Payment` relation for `order.payment` eager `false`.

**Idempotency store for webhooks:**

```text
StripeWebhookEvent (optional, for exactly-once)
------------------
id          uuid PK or stripeEventId varchar PK @PrimaryColumn
type        varchar  // payment_intent.succeeded | payment_intent.payment_failed
processedAt timestamptz
-- @Unique stripeEventId
```

Alternative simpler: `Payment.stripeEventId` unique + check before processing; no separate table needed V1 — keep single `Payment` row idempotency via `stripeEventId` column.

## 19.3 Business API

**`PaymentService` (`src/modules/payment/payment.service.ts`) — separate module, owns Payment lifecycle, collaborates via `OrderCompletionService`/`ReservationService`/`Inventory` but does not mutate Order stock directly except via transactional helper:**

```text
createIntent(manager: EntityManager, userId: string, orderId: string, role?: UserRoles): Promise<{payment: Payment, clientSecret: string}>
  - FOR UPDATE Order WHERE id=:orderId → 404, assertOwner → 403
  - validateOrderTransition(PENDING, PENDING) — only PENDING can create intent; COMPLETED/FAILED/CANCELLED → 409
  - check existing Payment by orderId → if exists and PENDING → return existing clientSecret (idempotent POST); if SUCCEEDED/FAILED → 409 Already has payment
  - amount = Order.total, currency = CURRENCY (usd)
  - call stripe.paymentIntents.create {amount: amount*100, currency, metadata:{orderId, userId}, automatic_payment_methods:{enabled:true}} — in test mode use STRIPE_SECRET_KEY test key (sk_test_...)
  - create Payment {orderId, userId, amount, currency, status: PENDING, stripePaymentIntentId: pi.id, stripeEventId: null}
  - return {payment, clientSecret: pi.client_secret}
  // Note: stripe call is OUTSIDE the DB tx — create Payment row first with PENDING, then call stripe, then update stripePaymentIntentId+clientSecret? Alternative: call stripe before DB, but if DB fails we orphan pi_xxx in Stripe test (acceptable, will expire). V1: DB PENDING → stripe → update.

confirmForTest(paymentId: string): Promise<Payment> // TEST ONLY, not exposed in prod — calls stripe.paymentIntents.confirm(pi) with pm_card_visa or pm_card_chargeDeclined to trigger webhook without frontend

handleWebhook(rawBody: Buffer, signature: string, stripeEventId: string): Promise<void>  // called by controller after signature verify, idempotent
  - stripe.webhooks.constructEvent(rawBody, signature, STRIPE_WEBHOOK_SECRET) → throw 400 if fails
  - if event.type NOT in [payment_intent.succeeded, payment_intent.payment_failed, payment_intent.canceled] → 200 ack ignore
  - lookup Payment FOR UPDATE by stripePaymentIntentId → 404 if not found (or 200 ignore for unknown pi)
  - idempotency: if Payment.stripeEventId === event.id → 200 already processed
  - if Payment.status !== PENDING → 200 already terminal (ignore duplicate)
  - verify event.data.object.amount === Payment.amount*100 and metadata.orderId === Payment.orderId → else 400 mismatch
  - transaction per event.type:
      succeeded: Order PENDING→COMPLETED + Reservation RESERVED→COMPLETED + stock-=qty reserved-=qty (reuse OrderCompletionService.complete but via manager, or duplicate helper that reuses same FOR UPDATE Ordering Order→Reservation→Inventories + CHK 23514→409) + Payment SUCCEEDED + Payment.stripeEventId = event.id
      payment_failed / canceled: Order PENDING→FAILED (or CANCELLED if canceled) + Reservation RESERVED→CANCELLED (reserved-=qty only, stock unchanged) + Payment FAILED|CANCELLED + stripeEventId
  - commit; any failure → rollback, no partial; webhook replays → second call sees stripeEventId match → 200 no re-mutation

cancel(manager, userId, paymentId, role): Promise<Payment> // user cancel before webhook — FOR UPDATE Payment PENDING, assertOwner, Order PENDING→CANCELLED, Reservation CANCELLED, Payment CANCELLED, stripe.paymentIntents.cancel(pi) test mode
```

All Payment writes via `EntityManager`; Stripe network I/O **outside** DB tx (create Payment PENDING → call stripe → update pi), webhook transactional part stays `FOR UPDATE Payment` + `FOR UPDATE Order/Reservation/Inventories` same ordering as Phase 7 (Order→Reservation→sorted Inventories).

**`PaymentModule` (`src/modules/payment/payment.module.ts`):**

```text
imports: TypeOrmModule.forFeature([Payment, StripeWebhookEvent?]), OrderModule (OrderCompletionService, OrderService), ReservationModule, InventoryModule, CartModule (not mutated), UsersModule
providers: PaymentService, StripeClient (wrapper around stripe npm, inject STRIPE_SECRET_KEY), Logger
exports: PaymentService
```

Stripe client wrapper for testability:

```text
interface StripeClient { createPaymentIntent(params): Promise<{id, client_secret}>, confirmPaymentIntent(id, pm), cancelPaymentIntent(id), constructWebhookEvent(rawBody, sig, secret): Stripe.Event }
Implementation: StripeStripeClient (real stripe npm with test key), NoopStripeClient (dev/test — returns fake pi_xxx and clientSecret without network, for unit)
```

## 19.4 REST API — new `payment` module

| Method | Path | Auth | Body | Success | Errors |
|--------|------|------|------|---------|--------|
| POST | `/payments/intent` | `JwtGuard @Auth()` owner | `{orderId: uuid}` | `201 {id, orderId, amount, currency, status:PENDING, stripePaymentIntentId: pi_xxx, clientSecret: pi_secret}` | `400` validation (missing orderId), `401`, `403` not owner, `404` Order not found, `409` Order not PENDING or already has SUCCEEDED Payment |
| GET | `/payments/:id` | `JwtGuard` owner-or-Admin | — | `200 Payment` | `403`, `404` |
| GET | `/payments` | `JwtGuard` owner-or-Admin | `?page,limit,orderId?,status?` | `200 {data: Payment[], meta}` paginated `createdAt DESC`, owner-scoped (Admin may ?userId) | `401`, `400` |
| POST | `/payments/webhook` | public (Stripe Signature) | raw JSON `event` body (Stripe) — `Content-Type: application/json` + header `Stripe-Signature: t=...,v1=...` | `200 {received:true}` (always 200 on success, Stripe expects 2xx; replay idempotent) | `400` invalid signature, `400` unknown event type ignored but 200 |
| POST | `/payments/:id/cancel` | `JwtGuard` owner | `{}` | `200 Payment CANCELLED` + `Order CANCELLED` | `403`, `404`, `409` if already SUCCEEDED/FAILED |
| POST | `/payments/:id/confirm-test` | `JwtGuard` owner (or `Admin`) — **test mode only** (`NODE_ENV !== 'production'`) | `{paymentMethod?: 'pm_card_visa'|'pm_card_chargeDeclined'}` | `200` triggers Stripe test confirm (creates webhook) | `403` in prod |

DTOs: `CreatePaymentIntentDto { @IsUUID orderId }`, `WebhookDto` raw body passthrough. All `@ApiProperty`, global `ValidationPipe`. Swagger adds `Bearer` for intent, none for webhook (Stripe-Signature header).

**Frontend (test) flow without real Stripe Elements (for manual):**

```bash
# After checkout
curl -X POST http://localhost:3000/payments/intent -H "Authorization: Bearer $JWT" -H "Content-Type: application/json" -d '{"orderId":"<orderId>"}' # 201 pi_xxx
# Test confirm (server test helper, avoids frontend)
curl -X POST http://localhost:3000/payments/<paymentId>/confirm-test -H "Authorization: Bearer $JWT" -H "Content-Type: application/json" -d '{"paymentMethod":"pm_card_visa"}' # 200 → triggers webhook → order COMPLETED
# Failure
curl -X POST http://localhost:3000/payments/<paymentId>/confirm-test -H "Authorization: Bearer $JWT" -d '{"paymentMethod":"pm_card_chargeDeclined"}' # → webhook payment_failed → order FAILED
```

Production flow uses Stripe Elements `stripe.confirmPayment({clientSecret, payment_method: {card}})` — server does not need `confirm-test`.

## 19.5 Security / constraints

* [ ] `STRIPE_SECRET_KEY` (`sk_test_...`) and `STRIPE_WEBHOOK_SECRET` (`whsec_...`) never committed, via `.env` + `ConfigService`, `STRIPE_PUBLISHABLE_KEY` (`pk_test_...`) exposed via `GET /payments/config` if frontend needs it (or env on frontend)
* [ ] Webhook signature verified via `stripe.webhooks.constructEvent(rawBody, sigHeader, secret)` — raw body needed, so controller must use `@Req() req.rawBody` (Nest `rawBody: true` in `main.ts`/`app.module` `bodyParser: {verify}`), `400` on fail (Stripe will retry)
* [ ] Idempotent webhook: `Payment.stripeEventId === event.id` → `200` already processed; second replay of same `evt_xxx` must not re-apply `stock-=qty`. Use `SELECT Payment FOR UPDATE` + check before mutation.
* [ ] Amount check: `event.data.object.amount === Payment.amount*100` (Stripe amount in cents) else `400` mismatch → no inventory mutation, log `Logger.error` with hashed pi prefix
* [ ] Rate limit `POST /payments/intent` per IP `10/hour` + per `orderId` `5/hour` via Redis `INCR+EXPIRE` fail-open (`RateLimitGuard`), webhook `POST /payments/webhook` per IP `100/hour` (Stripe retries) + verify signature before rate check
* [ ] `Payment` row is source of truth for `orderId→pi` mapping; Stripe is *not* source for inventory/order — Stripe event is trigger, but DB transaction is authoritative (constitution async rule: commit then publish → here webhook commit then inventory)
* [ ] Never log `clientSecret` or raw `Stripe-Signature` header; Logger logs `pi_xxx` prefix + `evt_xxx` prefix only
* [ ] Test mode only: `STRIPE_SECRET_KEY` must be `sk_test_*` in `DEV`/`TEST`; in `PROD` `sk_live_*` required, `confirm-test` endpoint disabled (`403` if `MODE=PROD`)
* [ ] On `POST /auth/refresh` per Phase 17, ensure `Payment` webhook still checks `tokenVersion` via `Order.userId→User`? Not needed — webhook is public via signature, not JWT. Owner check for `createIntent` via `assertOwner` only.

## 19.6 Configuration (`.env` additions, `ConfigService`)

```text
# Stripe Payment Test Mode (new, Phase 19)
STRIPE_SECRET_KEY=sk_test_51...           # test key, never commit
STRIPE_PUBLISHABLE_KEY=pk_test_51...      # for frontend Stripe Elements
STRIPE_WEBHOOK_SECRET=whsec_1...          # stripe listen --forward-to localhost:3000/payments/webhook
STRIPE_CURRENCY=usd                       # or egp if Stripe supports, but test card 4242 expects usd
STRIPE_API_VERSION=2024-06-20
# Existing
JWT_SECRET=...
JWT_EXPIRES_IN=15m
REFRESH_TOKEN_TTL=7d
PORT=3000
MODE=DEV|PROD
```

All via `ConfigService`; `stripe` npm `new Stripe(STRIPE_SECRET_KEY, {apiVersion})`.

## 19.7 Implementation Plan (Spec Kit tasks, before Testing)

```text
1. Spec: /speckit.specify stripe-payment (intent + webhook + confirm-test) → clarify Q&A (amount in cents vs Order.total int, pi per order 1:1, idempotent intent, cancel before capture, test vs live keys, rawBody verify)
2. Design: data-model.md (Payment entity 1:1 Order, PaymentStatus, StripeWebhookEvent optional), research.md (stripe npm vs HTTP, webhook rawBody verify, test card 4242 vs 0002, NoopStripeClient, amount*100)
3. Contract: OpenAPI for POST /payments/intent, POST /payments/webhook (raw + Stripe-Signature header), GET /payments/:id, POST /payments/:id/cancel|confirm-test
4. Migration 1: Payment {orderId @Unique FK CASCADE, userId FK CASCADE, amount CHECK>=0, currency, status enum, stripePaymentIntentId @Unique @Index, stripeEventId @Index, provider} + indexes
5. Module: payment.module.ts (TypeOrmModule.forFeature([Payment]), imports OrderModule/ReservationModule/InventoryModule, providers PaymentService, StripeClient wrapper, controllers PaymentController/WebhookController, rawBody true)
6. Service: PaymentService.createIntent (FOR UPDATE Order PENDING, assertOwner, idempotent existing PENDING, stripe.createPaymentIntent test mode, save), handleWebhook (constructEvent, FOR UPDATE Payment, idempotency stripeEventId, amount check, transaction Order PENDING→COMPLETED/FAILED + Reservation + stock math same as Phase 7), cancel
7. Controller: POST /payments/intent (JwtGuard, RateLimitGuard, @Auth), GET /payments/:id|GET /payments, POST /payments/webhook (public, rawBody, Stripe-Signature header, 200 ack), POST /payments/:id/cancel|confirm-test (JwtGuard, test mode guard)
8. Stripe client: StripeStripeClient (real stripe npm) + NoopStripeClient (dev/test — returns fake pi_xxx without network, for unit), STRIPE_SECRET_KEY switch, Logger prefix
9. Hook: OrderCompletionService still usable for webhook path (reuse same FOR UPDATE Order→Reservation→Inventories helper) — or extract helper to avoid duplication; dashboard metrics can join Payment for revenue
10. Unit tests: createIntent PENDING→201, duplicate intent idempotent 201, COMPLETED order 409, webhook succeeded → Order COMPLETED stock-=qty, failed → Order FAILED reserved-=qty, replay same evt → 200 no re-mutation, amount mismatch 400, invalid signature 400, confirm-test pm_card_visa → event
11. Integration tests: real PG — checkout 2 orders → create intents → concurrent webhook succeeded vs failed for different orders (both succeed without deadlock), webhook replay same evt twice → stock once, cancel before webhook → Order CANCELLED stock unchanged, test card 4242 vs 0002 E2E
12. E2E: register→login→cart→checkout→POST /payments/intent→POST /payments/:id/confirm-test pm_card_visa→GET /order COMPLETED + GET /payments SUCCEEDED + inventory stock decremented; second E2E with pm_card_chargeDeclined → FAILED + reserved released; manual Stripe CLI `stripe trigger payment_intent.succeeded` → webhook → COMPLETED
13. Docs: docs/architecture/modules.md, docs/decisions/ADR-payment-stripe.md (test mode, pi per order, rawBody verify, Noop vs Stripe), Swagger (Payment schema), Postman (intent + webhook + confirm-test), docs/manual-e2e-test-flow.md §4-6 updated (intent + webhook)
```

## 19.8 Testing (must cover)

**Unit (mock repos, mock StripeClient, mock Redis):**
* [ ] createIntent: valid → 201 pi_xxx, duplicate same order PENDING → 201 idempotent same clientSecret, order COMPLETED → 409, non-owner 403, stripe.create called with amount*100 and metadata orderId
* [ ] handleWebhook: valid succeeded → Order COMPLETED + stock-=qty, failed → Order FAILED reserved-=qty, replay same evt → 200 no re-mutation, invalid signature → 400, amount mismatch → 400, unknown pi → 200 ignore
* [ ] cancel: owner cancels PENDING → CANCELLED + Payment CANCELLED + stripe.cancel called

**Integration (real PostgreSQL, real Redis when available, stripe mocked as Noop or stripe-mock):**
* [ ] DB constraints: @Unique orderId, @Unique stripePaymentIntentId, amount CHECK>=0, status enum
* [ ] Transaction: concurrent `POST /payments/webhook` with same evt → one 200 COMPLETED stock once, second 200 idempotent
* [ ] E2E test mode: `4000000000000002` → FAILED not COMPLETED, `4242` → COMPLETED, stock math per Phase 7

**E2E (supertest + stripe-mock or Noop, test mode only):**
* [ ] `POST /auth/register` → `POST /auth/login` → `POST /cart` → `POST /order/checkout` → `POST /payments/intent` → `POST /payments/:id/confirm-test pm_card_visa` → `GET /order/:id` → COMPLETED + `GET /payments/:id` → SUCCEEDED
* [ ] Same but `pm_card_chargeDeclined` → `GET /order` → FAILED + `GET /payments` → FAILED + `GET /inventory` reserved 0
* [ ] `POST /payments/webhook` with tampered Stripe-Signature → 400, Stripe CLI `stripe trigger payment_intent.succeeded` → 200

## 19.9 Exit Criteria

Payment (Stripe test) is complete when:

```text
[x] POST /payments/intent creates sha256? no — Stripe pi_xxx PENDING Payment 1:1 Order with amount=Order.total, returns clientSecret, idempotent on same order PENDING (201 same pi), 409 if already SUCCEEDED
[x] POST /payments/webhook verifies Stripe-Signature via STRIPE_WEBHOOK_SECRET on rawBody, handles payment_intent.succeeded → Order PENDING→COMPLETED + Reservation RESERVED→COMPLETED + stock-=qty reserved-=qty + Payment SUCCEEDED (transactional FOR UPDATE), and payment_intent.payment_failed → Order FAILED + Reservation CANCELLED reserved-=qty + Payment FAILED, both idempotent on event replay (same evt.id → 200 no re-mutation) and amount-checked
[x] POST /payments/:id/confirm-test (test mode only, JwtGuard) triggers Stripe test confirm with pm_card_visa / pm_card_chargeDeclined without frontend, disabled in PROD
[x] POST /payments/:id/cancel + GET /payments/:id|GET /payments owner-or-Admin paginated work, rate-limited, Swagger documented, NoopStripeClient in dev/test (no real network)
[x] Payment migration applied (@Unique orderId, stripePaymentIntentId, amount CHECK>=0, status enum, indexes), Order COMPLETED still via webhook path (POST /order/:id/complete kept as Admin fallback but not user-facing for paid orders)
[x] Unit 12+ and integration 7+ and E2E 2 flows PASS, including concurrent webhook replay → single winner + failure card 0002 → FAILED
```

## 19.10 Out of Scope (this phase)

* Live Stripe `sk_live_` + real card charges (keep test keys, never hit live in CI; live needs separate verification, Apple Pay/Google Pay, 3DS redirect).
* Multiple PaymentIntents per Order or partial capture (V1 1:1, full amount).
* Refund `stock+=qty` on Payment SUCCEEDED → later refund (Phase 8 cancellation covers, not Stripe refund webhook `charge.refunded`).
* Subscriptions / recurring billing (future, add `Subscription` entity).
* Frontend Stripe Elements UI (backend provides clientSecret only, frontend consumes per Stripe docs).

# Phase 20 — Dashboard, RBAC & Metrics (Future)

**Status: NOT DONE — planned 2026-09-23 (future, before final testing)**

**Goal:** Provide an admin/operational dashboard via a **separate `dashboard` module** (thin, service-aggregating) that exposes **CRUD for products, CRUD for users, R for orders, R for carts, CRUD for stock (inventory)**, **RBAC with role hierarchy and admin-controlled upgrade/downgrade**, and **five business/system metrics** with date-range filtering — all without breaking modular-monolith boundaries or making Redis authoritative.

This phase is **orthogonal** to Phases 7-8 (order) and 9-13 (infra) and extends Phases 5-6/16 (reservation/order/auth). It must be implemented **before** `Phase 14 — Testing` so final `npm run test:e2e` can cover `admin → role change → dashboard metrics → stock alert` without mocking dashboard.

## 20.0 Current Snapshot (what exists, 2026-09-22)

```text
users.entity.ts    : User {id uuid, firstName, lastName, email @Unique, password nullable, role enum User|Admin default User, phoneNumber/@Index, phoneVerified, googleId/@Index, provider local|google, tokenVersion int, passwordChangedAt, emailVerified, orders OneToMany, cart OneToOne} — only 2 roles
auth               : JwtGuard (validates tokenVersion), RolesGuard via @Auth(...roles) (checks role === required), RegisterDto {firstName,lastName,email,password}, LoginDto {email,password}
products           : GraphQL Product entity + resolver + ProductsService (create, createMany, findAll cached, findOne, update, updateMany FOR UPDATE, remove) — NO REST CRUD for dashboard, NO stock in Product (stock in Inventory)
inventory          : Inventory {id, productId FK @Unique, stock int, reservedAmount int, available derived} + InventoryService (getInventory, checkAvailability, increaseStock, decreaseStock, reserve/release/completeSale stubs, decreaseStockForOrderMany) + InventoryController (GET /inventory/:productId, availability, increase/decrease) — no dashboard bulk stock CRUD, no low-stock query
order              : Order {id, userId FK, status PENDING|COMPLETED|CANCELLED|FAILED, total, orderItems} + OrderCheckoutService (POST /order/checkout cart-only) + OrderCompletionService (POST /order/:id/complete) + OrderService.findAll/findOne owner-or-Admin paginated
cart               : Cart {id, userId FK, cartItems OneToMany} + CartItem {id, cart, product eager, quantity} + CartService (getUserCart, addCartItem, increase/decrease, remove, clear, clearCartForCheckout via EntityManager)
admin              : Only @Auth(Admin) checks; no Co-Admin, no Content Manager, no Fulfillment; no role upgrade/downgrade endpoint
dashboard          : DOES NOT EXIST — no module, no metrics
Gap                : no expanded roles, no POST /admin/users/:id/role, no REST products CRUD for dashboard, no dashboard stock bulk, no dashboard metrics
```

Manual E2E today uses GraphQL for products and `@Auth(Admin)` for order reads only; dashboard CRUD and metrics are not testable.

## 20.1 Roles — expanded hierarchy and RBAC

### 20.1.1 Role enum (new)

```text
UserRoles (src/modules/users/enum/roles.ts)
  CUSTOMER = 'Customer'   // alias Buyer/User — default on register, can cart/checkout/order (also legacy 'User' kept as alias for compat)
  ADMIN = 'Admin'         // full super-admin, can do everything including role management + stock + metrics
  CO_ADMIN = 'CoAdmin'    // co-admin, can do most admin tasks except: cannot create/remove ADMIN, cannot downgrade ADMIN, cannot remove CO_ADMIN created by another ADMIN? (see §19.1.3)
  CONTENT_MANAGER = 'ContentManager' // aka Editor — can CRUD products (create/update), read orders/carts, cannot mutate users/roles/stock, cannot see revenue metrics beyond product list
  FULFILLMENT_STAFF = 'FulfillmentStaff' // can R orders/carts, update order status? (read-only V1), read stock, cannot mutate users/products/roles, can see fulfillment metrics

Compatibility: keep User = CUSTOMER alias:
  export enum UserRoles { User = 'Customer', Customer = 'Customer', Admin = 'Admin', CoAdmin = 'CoAdmin', ContentManager = 'ContentManager', FulfillmentStaff = 'FulfillmentStaff' }
Migration: ALTER TYPE enum add values (if PG enum) or keep varchar check; add CHECK "role" IN ('Customer','Admin','CoAdmin','ContentManager','FulfillmentStaff') if varchar.
```

### 20.1.2 Permission matrix (V1)

| Resource | Customer | ContentManager | FulfillmentStaff | CoAdmin | Admin |
|----------|----------|----------------|------------------|---------|-------|
| **Products** list `GET /products` (GraphQL) | ✅ | ✅ | ✅ | ✅ | ✅ |
| **Products** `POST|PATCH|DELETE /admin/products|/dashboard/products` | ❌ | ✅ (CRUD) | ❌ read-only | ✅ | ✅ |
| **Stock** `GET|POST /admin/stock`, `PATCH /admin/stock/bulk` | ❌ | ❌ | ✅ read | ✅ `GET`+`PATCH` | ✅ |
| **Users** `GET /admin/users`, `GET /admin/users/:id` | ❌ own `GET /users/me` only | ❌ | ❌ | ✅ read | ✅ read |
| **Users** `PATCH /admin/users/:id/role` (upgrade/downgrade), `DELETE /admin/users/:id` | ❌ | ❌ | ❌ | ⚠️ limited (see §19.1.3) | ✅ full |
| **Orders** `GET /admin/orders`, `GET /admin/orders/:id` | ❌ own `GET /order` only | ✅ read | ✅ read | ✅ read | ✅ read |
| **Carts** `GET /admin/carts`, `GET /admin/carts/:id` | ❌ own `GET /cart` only | ✅ read | ✅ read | ✅ read | ✅ read |
| **Dashboard metrics** `GET /admin/dashboard/*` | ❌ | ❌ only `low-stock`? (see §19.5) | ✅ `low-stock`+`abandonment` | ✅ all except `api-health`? | ✅ all 5 |
| **Metrics** revenue/AOV | ❌ | ❌ | ❌ | ✅ | ✅ |

V1 keeps `orders`/`carts` as **R** (read) for dashboard (no admin create/update via dashboard — orders come via checkout, carts via user flow). Product and user and stock are **CUD** where table says CRUD.

Guards: `RolesGuard` already supports `@Auth(...roles)` — expand to check `role IN allowedRoles`. Add `RoleHierarchyGuard` optional for `CoAdmin` restrictions (see §19.1.3). All dashboard routes use `@Auth(Admin, CoAdmin, ContentManager, FulfillmentStaff)` with service-level fine check.

### 20.1.3 Admin role manipulation rules

```text
POST /admin/users/:id/role { role: Customer|CoAdmin|ContentManager|FulfillmentStaff|Admin }
  Auth: @Auth(Admin, CoAdmin) but service enforces:
    - Only Admin can promote TO Admin or CoAdmin, or demote FROM Admin/CoAdmin
    - CoAdmin can promote Customer → ContentManager/FulfillmentStaff and demote those back to Customer, but:
        * 403 if target is Admin
        * 403 if target is CoAdmin and actor is CoAdmin (only Admin can touch CoAdmin)
        * 403 if dto.role === Admin and actor is CoAdmin
    - Admin can set any role including self? No self-demotion guard: if actor === target and new role !== Admin → 400 self-demotion via this endpoint not allowed (use separate self endpoint or require second Admin)
    - Downgrade: Admin → Customer etc. allowed, but last Admin protection: cannot demote last remaining Admin (count Admin WHERE role=Admin → 1 → 409 Last admin cannot be demoted)
    - All role changes inside DataSource.transaction, FOR UPDATE on User row, audit log Logger.log with actorId→targetId role transition
    - Idempotent: Customer→Customer → 200 no change

DELETE /admin/users/:id  (admin remove user) — only Admin can delete any, CoAdmin can delete Customer/ContentManager/FulfillmentStaff but not Admin/CoAdmin; self-delete 403; last Admin delete 409
GET /admin/users → paginated role filter ?role=Customer|Admin etc.
```

DTOs: `UpdateUserRoleDto { @IsEnum(UserRoles) role }`, `CreateProductDto` already exists for GraphQL but REST will reuse `CreateProductInput` + `stock` for inventory.

## 20.2 Products — Dashboard CRUD (REST) vs GraphQL

GraphQL `products` resolver stays for customer browsing (cached). **Dashboard REST** adds thin CRUD for ContentManager/Admin:

| Method | Path | Auth | Body | Success | Errors |
|--------|------|------|------|---------|--------|
| POST | `/admin/products` | `ContentManager, CoAdmin, Admin` | `{name, slug?, description, price, stock?}` | `201 Product + Inventory` (same as `ProductsService.create` with `inventoryService.createForProduct`) | `400` validation, `409` duplicate name/slug, `403` |
| GET | `/admin/products` | `ContentManager, FulfillmentStaff, CoAdmin, Admin` | query `?page,limit,search?,role?` | `200 {data, meta}` paginated | `401` |
| GET | `/admin/products/:id` | same | — | `200 Product + Inventory stock` | `404` |
| PATCH | `/admin/products/:id` | `ContentManager, CoAdmin, Admin` | `{name?, description?, price?}` (no stock here, use stock endpoints) | `200` | `409` duplicate, `403` |
| DELETE | `/admin/products/:id` | `CoAdmin, Admin` | — | `200` | `403` if ContentManager tries delete |
| PATCH | `/admin/products/bulk` | `ContentManager, CoAdmin, Admin` | `[{id, name?, price?}]` | `200` like `updateMany` FOR UPDATE | `404` missing ids |

All via `ProductsService` (no new logic, just REST wrapper) + `InventoryService` for `stock` on create. `stock` via `admin/stock` separately (see §19.4).

## 20.3 Users — Dashboard CRUD

| Method | Path | Auth | Body | Success |
|--------|------|------|------|---------|
| GET | `/admin/users` | `CoAdmin, Admin` | `?page,limit,role?,search?` | `200 {data: User[], meta}` paginated `createdAt DESC`, `role` filter |
| GET | `/admin/users/:id` | `CoAdmin, Admin` | — | `200 User` |
| PATCH | `/admin/users/:id/role` | `Admin` + limited `CoAdmin` | `{role}` | `200 User` updated role + `tokenVersion++?` no (keep JWT valid but next request will see new role via DB; tokenVersion not bumped on role change — or bump to force re-login? Decision: bump tokenVersion on role change so JWT `role` claim refreshes — see §19.6) |
| DELETE | `/admin/users/:id` | `Admin` + limited `CoAdmin` | — | `200` deleted |
| GET | `/users/me` | `JwtGuard` | — | `200` own User |

Service: `UsersService` owns `findUserById`, `updateUserRole(manager, userId, newRole)` transactional `FOR UPDATE`, last-admin guard, audit.

## 20.4 Orders, Carts, Stock — Dashboard R

| Method | Path | Auth | Body | Success |
|--------|------|------|------|---------|
| GET | `/admin/orders` | `FulfillmentStaff, ContentManager, CoAdmin, Admin` | `?page,limit,status?,userId?,from?,to?` | `200 {data: Order[], meta}` + `reservationId` link, date-range filter on `created_at` |
| GET | `/admin/orders/:id` | same | — | `200 Order + items + reservation` |
| GET | `/admin/carts` | same | `?page,limit` | `200 {data: Cart[], meta}` + `user` + `cartItems` + `product` |
| GET | `/admin/carts/:id` | same | — | `200 Cart` |
| GET | `/admin/stock` | `FulfillmentStaff, CoAdmin, Admin` | `?lowThreshold?` | `200 Inventory[]` |
| PATCH | `/admin/stock/:inventoryId` | `CoAdmin, Admin` | `{stockDelta? , stockAbsolute?}` | `200 Inventory` (`stock+=delta` or `stock=absolute`, check `reservedAmount <= stock`, `stock>=0`) |
| POST | `/admin/stock/bulk` | `CoAdmin, Admin` | `{updates:[{inventoryId, stockDelta|stockAbsolute}]}` | `200 Inventory[]` transactional `FOR UPDATE` sorted ids |

Stock DTOs: `UpdateStockDto { @IsOptional @IsInt stockDelta, @IsOptional @IsInt stockAbsolute }` XOR check, `BulkUpdateStockDto`. All via `InventoryService` (reuse `increaseStock`/`decreaseStock` but now bulk transactional for dashboard).

## 20.5 Dashboard Metrics — Separate Module (5 metrics)

**Module**: `src/modules/dashboard/dashboard.module.ts` — **separate module** per request.

```text
dashboard/
  dashboard.module.ts  // imports TypeOrmModule.forFeature([Order, OrderItem, Inventory, Cart, Product, User]) OR imports OrderModule, InventoryModule, CartModule via exported services (preferred per AGENTS.md — service-only collaboration). Decision: import via services where possible, but for metrics raw aggregations use manager.getRepository + QueryBuilder for performance (allowed per plan — no cross-module repo violation if dashboard is aggregator? Must justify: dashboard is read-only aggregator, so direct repo via manager is scoped. Alternative: add method to each domain service (getRevenue...). Plan chooses direct QueryBuilder for AOV join performance, but keep stock alert via InventoryService.getLowStock() to reuse.
  dashboard.service.ts // 5 metric methods + date-range helper
  dashboard.controller.ts // GET /admin/dashboard/* thin, @Auth(Admin, CoAdmin) etc. with per-metric guard fine-check
  dto/dashboard-query.dto.ts // { from?: ISO string, to?: ISO string, period?: 'day'|'week'|'month', lowThreshold?: int }
```

**Date-range handling** (shared helper `parseRange(dto): {from: Date, to: Date}`): `from`/`to` ISO, default `30d` (`to=NOW()`, `from=NOW()-30d`), max range `1y` (clamp + `400` if exceed), `period` bucket for chart grouping. All aggregations filter `Order.status=COMPLETED` for revenue (not PENDING|CANCELLED|FAILED) and `Order.created_at BETWEEN :from AND :to`.

### Metric 1 — 💰 Total Revenue & Sales Count (baseline aggregation)

- `GET /admin/dashboard/revenue?from=2024-01-01&to=2024-01-31`
- Query: `SELECT COALESCE(SUM(total),0) as revenue, COUNT(*) as salesCount FROM "order" WHERE status='COMPLETED' AND created_at BETWEEN :from AND :to`
- Backend Value: basic `SUM`/`COUNT` + date-range, index `order.status` + `order.created_at` (@Index), proven not to tank with `EXPLAIN`.
- Response: `200 { revenue: int, salesCount: int, currency:"EGP", from, to, period }` + optional `chart: [{date, revenue, count}]` when `period` supplied (group by `DATE_TRUNC(period, created_at)`).

### Metric 2 — 🛒 Average Order Value (AOV = Total Revenue / Total Orders)

- `GET /admin/dashboard/aov?from=&to=`
- Query: same as revenue but `aov = revenue / NULLIF(salesCount,0)` — handles `salesCount=0` → `0` not division-by-zero (COALESCE). For per-day AOV: join per `Order.created_at` bucket.
- Backend Value: multi-step arithmetic + relational `Order`→`OrderItem` not needed (total already denormalized), but verify `total = Σ OrderItem.quantity*unit_price` consistency via join variant for proof: `SELECT SUM(oi.quantity*oi.unit_price) FROM order_item oi JOIN order o ON oi.orderId=o.id WHERE o.status='COMPLETED' ...`
- Response: `200 { aov: number (2 decimals), revenue, salesCount }`.

### Metric 3 — 📦 Low-Stock / Out-of-Stock Alert Counts (inventory logistics)

- `GET /admin/dashboard/low-stock?threshold=5&outOfStockThreshold=0`
- Query: `SELECT COUNT(*) FILTER (WHERE stock - reservedAmount <= :threshold) as lowCount, COUNT(*) FILTER (WHERE stock - reservedAmount = 0) as outCount FROM Inventory` + list `SELECT id, productId, stock, reservedAmount, available FROM Inventory WHERE available <= :threshold ORDER BY available ASC` (limit 100).
- Backend Value: `available = stock - reservedAmount` derived correctness, `reservedAmount <= stock` invariant, showcases `Inventory` model.
- Response: `200 { lowCount, outCount, threshold, items:[{inventoryId, productId, stock, reservedAmount, available}], totalInventories }`.

### Metric 4 — 📉 Cart Abandonment Rate (Carts vs Orders, temporal)

- Definition: `% of carts created that never converted to Order COMPLETED within abandonment window (24h untouched)`. Formula `abandoned = carts that have existed >24h with no matching Order COMPLETED for same user AND no recent update; abandonmentRate = abandoned / totalCarts * 100`.
- `GET /admin/dashboard/abandonment?windowHours=24&from=&to=`
- Query (V1 simple): 
  ```sql
  WITH carts AS (SELECT id, userId, created_at, updated_at FROM cart WHERE created_at BETWEEN :from AND :to),
  orders_completed AS (SELECT userId, created_at FROM "order" WHERE status='COMPLETED' AND created_at BETWEEN :from AND :to)
  SELECT COUNT(DISTINCT c.id) as totalCarts,
         COUNT(DISTINCT c.id) FILTER (WHERE NOT EXISTS (SELECT 1 FROM orders_completed o WHERE o.userId=c.userId AND o.created_at >= c.created_at AND o.created_at <= c.created_at + interval '24 hours')) as abandoned
  FROM carts c
  ```
  Alternative simpler (per constitution kpi): `abandonmentRate = (carts with 0 COMPLETED orders ever) / totalCarts *100` — but windowed is more accurate. V1 chooses *carts untouched 24h + no COMPLETED order* as abandoned.
- Backend Value: session/cart lifecycle, temporal `updated_at`, relation `Cart`↔`Order` via `userId`.
- Response: `200 { totalCarts, abandonedCarts, abandonmentRate: 0-100 (2 decimals), windowHours, from, to }`.

### Metric 5 — 🛠️ API Health & Error Rate (System Metric)

- Definition: `% of HTTP responses that are 4xx or 5xx` over window.
- `GET /admin/dashboard/health?from=&to=`
- Source: V1 `in-memory RequestLoggingMiddleware` or `Logger` interceptor storing `requestLog {method, path, status, duration}` in `cacheManager` or PG table `api_request_log` (future). Simplest V1: piggyback on existing `AllExceptionsFilter` + middleware that increments Redis counters `api:health:<day>:<statusBucket>` (`2xx,4xx,5xx`) with `INCR` + `EXPIRE 7d`, then aggregates: `errorRate = (4xx+5xx)/total*100`.
- Query: `SELECT (SUM(CASE WHEN status>=400 THEN 1 ELSE 0 END)::float / NULLIF(COUNT(*),0))*100 as errorRate, COUNT(*) as total, COUNT(*) FILTER (WHERE status<400) as success, COUNT(*) FILTER (WHERE status>=500) as serverError FROM request_log WHERE createdAt BETWEEN :from AND :to` OR Redis `MGET` aggregation.
- Backend Value: middleware, error tracking, not happy-path only.
- Response: `200 { errorRate, totalRequests, successCount, clientError(4xx), serverError(5xx), from, to }` + optional `perRoute:[{path, errorRate}]` later.
- Guard: only `Admin`/`CoAdmin` (not Customer/ContentManager).

All metrics support `?from&to&` date-range (default last 30d) and `period` grouping where chart makes sense. All via `DataSource.manager` QueryBuilder, never `order.total` trusted without `CHECK`.

## 20.6 Security, module boundaries, config

* [ ] `RolesGuard` expanded to new enum; `@Auth()` usage per matrix above; service-level fine check for `CoAdmin` limited role changes (last Admin guard + audit log).
* [ ] On role change, increment `User.tokenVersion` (so old JWT with old `role` claim is revoked and client must `POST /auth/refresh` per Phase 17 to get new token with new role) — prevents `role` claim staleness.
* [ ] `Product` slug/name `@Unique` still enforced; dashboard bulk `PATCH /admin/products/bulk` uses `FOR UPDATE` + `ON CONFLICT` handling → `409`.
* [ ] Stock `reservedAmount <= stock` + `stock>=0` DB CHECK backstop, mapped `23514 → 409`.
* [ ] Metrics queries use `COALESCE`/`NULLIF` for zero-division, `EXPLAIN` shows index usage (`order.created_at` + `order.status`, `inventory` scan, `cart.userId`), pagination `skip=(page-1)*limit` where needed.
* [ ] Dashboard module imports: `TypeOrmModule.forFeature([Order, OrderItem, Inventory, Cart, Product, User, RefreshToken])` OR reuses domain services (`ProductsService`, `InventoryService`, `OrderService`, `CartService`, `UsersService`) — **prefer service-only** per `AGENTS.md` §2, but for `revenue SUM` direct `manager` is allowed with comment `// Dashboard read-only aggregation, not business mutation, hence direct QueryBuilder scoped to read`.
* [ ] No new Redis authoritative truth for metrics — Redis only for `api:health` counters (ephemeral) + rate-limit; PostgreSQL is source for revenue/stock/cart.
* [ ] Env: `DASHBOARD_LOW_STOCK_THRESHOLD=5`, `DASHBOARD_ABANDONMENT_WINDOW_HOURS=24`, `API_HEALTH_LOG_TTL=7d`.

## 20.7 Implementation Plan (Spec Kit tasks, before Testing)

```text
1. Spec: /speckit.specify dashboard (roles + CRUD + metrics) → clarify Q&A (role names Customer alias User, CoAdmin limits, stock DTO XOR, metrics date-range defaults, abandonment definition, health source)
2. Design: data-model.md (UserRoles enum 5 values, dashboard.aggregations, stock DTO), research.md (RolesGuard hierarchy vs simple IN check, QueryBuilder AOV vs total column, abandonment window 24h, health Redis vs PG table)
3. Contract: OpenAPI for roles PATCH /admin/users/:id/role, products/stock CRUD, carts/orders reads, 5 metrics GET /admin/dashboard/*
4. Migration 1: UserRoles enum widen (add CoAdmin, ContentManager, FulfillmentStaff, keep User as Customer alias, CHECK, last Admin guard not DB but service), no new table for dashboard (metrics are queries), optional api_request_log table for health if PG path chosen
5. Module: dashboard.module.ts (separate module, imports OrderModule/InventoryModule/CartModule/ProductsModule/UsersModule OR TypeOrmModule.forFeature read-only) + dashboard.service.ts (5 metric methods + parseRange helper) + dashboard.controller.ts (thin, @Auth per metric matrix, rate-limited? no throttle beyond existing)
6. Roles: Update UserRoles enum, update RolesGuard to support 5 roles, implement PATCH /admin/users/:id/role transactional FOR UPDATE + last Admin + audit + tokenVersion++ , DELETE /admin/users/:id with guard
7. Products: REST wrapper POST|GET|PATCH|DELETE /admin/products (thin, delegates to ProductsService + InventoryService), bulk PATCH
8. Stock: GET|PATCH|POST /admin/stock + bulk transactional sorted ids + CHECK 23514→409, low-stock query via InventoryService
9. Metrics: revenue/sales SUM+COUNT, AOV NULLIF, low-stock FILTER, abandonment windowed carts vs orders join, health Redis/Middleware counters → QueryBuilder
10. Unit tests: validateRoleTransition matrix (CoAdmin→Admin 403, Admin→Customer 200, last Admin 409), roles guard, products CRUD duplicate 409, stock DTO XOR 400, metrics zero-division AOV 0, abandonment 100% when no orders
11. Integration tests: real PG — role upgrade tokenVersion++ revokes old JWT (401 until refresh), low-stock count matches Inventory, revenue date-range filtering, cart abandonment window 24h, concurrent role change last Admin 409
12. E2E: admin register→login→POST /admin/products→GET /admin/dashboard/revenue?from=&to= → PATCH role Customer→ContentManager → GET /admin/dashboard/low-stock
13. Docs: docs/architecture/modules.md, docs/decisions/ADR-dashboard.md, Swagger, Postman, docs/manual-e2e-test-flow.md §2-6 updated
```

## 20.8 Testing (must cover)

**Unit (mock repos, mock Redis):**
* [ ] Roles: Admin can set any, CoAdmin cannot touch Admin/CoAdmin (403), last Admin demote 409, idempotent same role 200
* [ ] Products: duplicate name 409, ContentManager can create 201 but Customer 403
* [ ] Stock: increase +10, decrease below reserved → 409, bulk sorted FOR UPDATE
* [ ] Metrics: revenue SUM for date range, AOV 0 when sales 0 (NULLIF), low-stock threshold 5, abandonment 0/100 edge, health 0% no errors

**Integration (real PostgreSQL, real Redis when available):**
* [ ] DB: UserRoles 5 values @Check, User role FK, Products slug unique
* [ ] Transaction: concurrent PATCH role same user → one wins FOR UPDATE, last Admin 409 not double-demoted
* [ ] Metrics: 3 orders COMPLETED in Jan → revenue SUM correct, AOV 33, low-stock count matches Inventory, cart abandonment window

**E2E (supertest):**
* [ ] Admin `POST /admin/users/:id/role {role: ContentManager}` → `GET /admin/dashboard/low-stock` as new ContentManager 200 but `GET /admin/dashboard/revenue` 403 (role matrix)
* [ ] Customer `POST /cart` → no order 24h → `GET /admin/dashboard/abandonment` shows 100%

## 20.9 Exit Criteria

Dashboard is complete when:

```text
[x] POST|GET|PATCH|DELETE /admin/products (CoAdmin/Admin + ContentManager CRUD where matrix allows) with Inventory stock creation and bulk FOR UPDATE, 409 on duplicate name
[x] GET /admin/users paginated role filter + PATCH /admin/users/:id/role (Admin full, CoAdmin limited, last Admin 409, tokenVersion++ + audit) + DELETE with guard
[x] GET /admin/orders + /admin/carts R paginated, GET /admin/stock + PATCH bulk stock transactional sorted + CHECK 23514→409
[x] GET /admin/dashboard/revenue?from=&to= + ?period day|week|month returns {revenue, salesCount, chart} via SUM+COUNT WHERE status='COMPLETED' BETWEEN
[x] GET /admin/dashboard/aov?from=&to= returns {aov, revenue, salesCount} with NULLIF zero-division
[x] GET /admin/dashboard/low-stock?threshold=5 returns {lowCount, outCount, items} via available <= threshold FILTER
[x] GET /admin/dashboard/abandonment?windowHours=24 returns {totalCarts, abandonedCarts, abandonmentRate} windowed carts vs COMPLETED orders join
[x] GET /admin/dashboard/health?from=&to= returns {errorRate, totalRequests, 4xx,5xx} via middleware/Redis counters or pg log
[x] Dedicated dashboard.module.ts (separate module, read-only aggregator) thin controllers, @Auth per metric matrix, no cross-module @InjectRepository of another module's entity beyond read scope (or via services)
[x] Unit 15+ and integration 10+ and E2E 4+ flows PASS, including concurrent role change last Admin + low-stock EXPLAIN index
```

## 20.10 Out of Scope (this phase)

* Frontend dashboard UI (React/Vue) — backend APIs only, frontend consumes Swagger.
* Per-user order history export CSV (future, add GET /admin/orders/export).
* Real-time websocket push for low-stock alerts (V1 polling GET, future BullMQ pub).
* Fine-grained per-product stock reservation history chart (V1 alert counts only).
* API health per-route breakdown beyond total (V1 total + 4xx/5xx, per-route later).

---
---

# Phase 14 — Testing

**Status: NOT DONE**

Testing should be implemented progressively rather than postponed until the end.

## Unit Tests

* [ ] Inventory availability
* [ ] Reservation creation rules
* [ ] Reservation state transitions
* [ ] Expiration rules
* [ ] Inventory business methods
* [ ] DTO validation

## Integration Tests

* [ ] PostgreSQL transactions
* [ ] Reservation creation
* [ ] Inventory release
* [ ] Reservation expiration
* [ ] Order completion
* [ ] Order cancellation
* [ ] Database constraints

## Concurrency Tests

Critical test:

```text
Inventory = final 1 unit

Request A → 1
Request B → 1
```

Expected:

```text
A → success
B → conflict
```

Never:

```text
A → success
B → success
```

## E2E

Complete flow:

```text
Register
 ↓
Login
 ↓
Browse product
 ↓
Add to cart
 ↓
Checkout
 ↓
Reservation
 ↓
Order
 ↓
Completion
```

Expiration flow:

```text
Reservation
 ↓
Time passes
 ↓
Cleanup
 ↓
Expiration
 ↓
Inventory released
```

Cancellation flow:

```text
Order
 ↓
Cancel
 ↓
Inventory released/restored
```

---

# Phase 15 — Documentation & Spec-Driven Development

**Status: PARTIALLY DONE**

The project already has an architectural direction and should now turn it into maintainable documentation.

## Documentation

Maintain:

```text
AGENTS.md

docs/
├── architecture/
│   ├── overview.md
│   ├── modules.md
│   ├── inventory.md
│   ├── reservations.md
│   └── order-flow.md
│
├── database/
│   ├── overview.md
│   └── relationships.md
│
├── decisions/
│   └── README.md
│
└── api/
    └── conventions.md
```

Use the existing Spec Kit structure alongside this documentation.

Do not duplicate information unnecessarily.

## Feature Development Process

Every significant feature follows:

```text
Requirement
    ↓
Specification
    ↓
Clarification
    ↓
Design
    ↓
Implementation Plan
    ↓
Implementation
    ↓
Tests
    ↓
Verification
```

---

# Phase 16 — Auth Upgrades: Forgot Password, Recovery Token, WhatsApp OTP, Google OAuth

**Status: NOT DONE — planned 2026-09-15**

**Goal:** Harden the existing `auth`/`users` modules so users can recover a forgotten
password securely (recovery token), verify identity via WhatsApp OTP, and sign in
with Google OAuth — without weakening JWT/password invariants or introducing
auth as a source of inventory/order truth.

This phase is **orthogonal** to Phases 5–8 (reservation/order). It can be
implemented in parallel by a dedicated auth owner, but must respect the same
modular-monolith boundaries, PostgreSQL-as-source-of-truth, and global
`ValidationPipe`/`AllExceptionsFilter` rules in `AGENTS.md`.

## 16.0 Current Auth Snapshot (what exists)

```text
auth.controller.ts : POST /auth/register , POST /auth/login (LocalAuthGuard → AuthService.login → JwtService.sign)
auth.service.ts    : register (bcrypt 10 rounds, duplicate 400), userValidation (bcrypt.compare), login (JwtPayload {sub,email,fullName,role})
auth.module.ts     : JwtModule.registerAsync (JWT_SECRET / JWT_EXPIRES_IN), PassportModule, LocalStrategy
users.entity.ts    : id uuid, firstName, lastName, email (@Index), role enum, password (NOT nullable), orders, cart
guards             : LocalAuthGuard, JwtGuard (manual verify), RolesGuard via @Auth decorator
config             : JWT_SECRET, JWT_EXPIRES_IN=60s
```

Gap: no `phoneNumber`, no `googleId`/`provider`, no `password nullable` for OAuth
users, no reset-token/OTP persistence, no OAuth strategy, no rate limiting on
auth endpoints.

## 16.1 Forgot Password + Recovery Token

### 16.1.1 User-facing flow

```text
POST /auth/forgot-password { email }            → 200 (always, anti-enumeration)
        ↓
  Find user by email (if exists)
        ↓
  Invalidate any prior active reset tokens for that user
        ↓
  Generate cryptographically random token (32 bytes → hex/base64url, 64 chars)
        ↓
  Store ONLY hashed token (sha256 or bcrypt) + expiresAt (now+15m) in DB
        ↓
  Publish event / send notification (email + optional WhatsApp) with link:
      https://app.example.com/reset-password?token=<rawToken>&email=<email>
        ↓
POST /auth/reset-password { email, token, newPassword } → 200 + invalidates token
        ↓
POST /auth/validate-reset-token { email, token } (optional UX helper) → 200/400
```

Anti-enumeration: `forgot-password` returns `200 { message: "If an account exists, a reset link has been sent." }` even when email not found. Do not leak existence. Log at `debug` only.

### 16.1.2 Data model

**Alter `User`:**

```text
User
  + phoneNumber: varchar nullable, @Index, @Unique where not null (optional, for OTP)
  + phoneVerified: boolean default false
  + googleId: varchar nullable, @Unique where not null
  + provider: enum('local','google') default 'local'  OR authProvider
  + password: varchar nullable  (nullable for pure-OAuth users; local users still require it)
  + emailVerified: boolean default false (future use, not blocking)
```

Migration must: `ALTER COLUMN password DROP NOT NULL`, add new columns, add partial
unique indexes (`WHERE "googleId" IS NOT NULL`, `WHERE "phoneNumber" IS NOT NULL`),
keep `@Index(['email'])` unique (add `@Unique(['email'])` if not already enforced
at DB — currently only `@Index`, so add unique constraint).

**New entity `PasswordResetToken`:**

```text
PasswordResetToken
------------------
id              uuid PK
userId          uuid FK → User.id ON DELETE CASCADE, @Index
tokenHash       varchar(255)  -- sha256 hex of rawToken; indexed for lookup
expiresAt       timestamptz   -- now + 15m (configurable via RESET_TOKEN_TTL)
usedAt          timestamptz nullable
createdAt       timestamptz
-- constraints
CHECK expiresAt > createdAt
INDEX (userId, expiresAt)
INDEX (tokenHash)  -- for verify path
UNIQUE? no — multiple tokens per user allowed but only one active; old ones invalidated
```

Alternative considered: store JWT as reset token. Rejected — opaque random token
+ hash is simpler to revoke, shorter audit surface, no JWT secret rotation risk.
JWT can still be used for short-lived `reset_jwt` if product prefers, but document
choice in `docs/decisions/`.

**Token generation details:**

```text
rawToken = crypto.randomBytes(32).toString('hex') // 64 chars, 256 bits
tokenHash = crypto.createHash('sha256').update(rawToken).digest('hex')
store tokenHash, return rawToken once to caller (never log rawToken)
```

Expiry: `RESET_TOKEN_TTL=15m` (env), single-use (`usedAt` set on success),
nightly cleanup job may purge `expiresAt < NOW() - 7d` (not critical path).

### 16.1.3 Business API (AuthService)

```text
requestPasswordReset(email: string): Promise<void>
  - validate email format (DTO)
  - lookup user; if not found → return void (no error)
  - within transaction (manager):
      update prior tokens: SET usedAt=NOW() WHERE userId=? AND usedAt IS NULL AND expiresAt > NOW()
      insert new token (tokenHash, expiresAt)
  - after commit: emit event via RabbitMQ / BullMQ notification worker (do NOT block commit)
  - rate-limit outside service (guard/interceptor) — see 16.5

validateResetToken(email: string, rawToken: string): Promise<User>
  - hash rawToken, find token by tokenHash + join user by email
  - throw 400 if not found / expired / usedAt not null
  - return user

resetPassword(dto: ResetPasswordDto): Promise<void>
  - dto { email, token, newPassword } — class-validator: IsEmail, IsString MinLength 8, MaxLength 72, password strength regex optional
  - transaction:
      SELECT PasswordResetToken FOR UPDATE where tokenHash = hash(token) AND userId = user.id
      verify not expired / not used
      bcrypt.hash(newPassword, 10) → update User.password
      SET token.usedAt = NOW()
      optionally: invalidate all other active tokens for user
  - after commit: revoke existing JWTs? V1: no JWT revocation (stateless); document as open question; optionally rotate via short JWT_EXPIRES_IN
```

All writes inside `dataSource.transaction` with `EntityManager`; no Redis/RabbitMQ
I/O inside the transaction.

### 16.1.4 REST API

| Method | Path | Auth | Body | Success | Errors |
|--------|------|------|------|---------|--------|
| POST | `/auth/forgot-password` | public | `{ email }` | `200 { message }` | `400 validation`, `429 rate limit` |
| POST | `/auth/reset-password` | public | `{ email, token, newPassword }` | `200 { message }` | `400 invalid/expired token`, `400 weak password` |
| POST | `/auth/validate-reset-token` | public | `{ email, token }` | `200 { valid:true }` | `400 invalid` |

DTOs: `ForgotPasswordDto`, `ResetPasswordDto`, `ValidateResetTokenDto` (`class-validator`,
`@ApiProperty` for Swagger). Reuse global `ValidationPipe` (whitelist/forbid).

### 16.1.5 Security / constraints

* [ ] `tokenHash` is `sha256`, never store rawToken
* [ ] Constant-time compare not needed for sha256 hex (hash lookup), but do not log rawToken
* [ ] Expiry enforced in DB (`CHECK`) and service (`expiresAt > now`)
* [ ] Single-use (`usedAt`); second use → `400`
* [ ] Rate limit `forgot-password` per IP + per email (Redis, see 16.5)
* [ ] Password rules: `MinLength 8`, forbid `password === email`, optional strength check
* [ ] Invalidate tokens on successful reset; do not allow `COMPLETED→COMPLETED` reuse (unlike reservation idempotency)
* [ ] Audit log via `Logger` (hashed token prefix only)

## 16.2 WhatsApp OTP

### 16.2.1 Purpose

* Primary: second factor / passwordless login / phone verification / reset-password
  alternative delivery channel.
* User explicitly chooses WhatsApp; never auto-fallback without consent (privacy).

Provider abstraction: `WhatsAppService` interface so tests don't hit real API and
prod can swap Twilio / Meta Cloud API / local mock.

```text
interface WhatsAppProvider {
  sendOtp(phoneNumber: string, otp: string, expiresInMinutes: number): Promise<{ messageId: string }>;
}
```

Implementations: `TwilioWhatsAppProvider`, `MetaCloudWhatsAppProvider`, `NoopWhatsAppProvider` (dev/test).

### 16.2.2 OTP lifecycle

```text
POST /auth/otp/request { phoneNumber }  (or { email } → lookup phoneNumber)
        ↓
  Normalize phone (E.164, e.g. +2010...) validate via regex / libphonenumber
        ↓
  Rate-limit check (Redis)
        ↓
  Generate 6-digit numeric OTP: crypto.randomInt(100000, 999999).toString()
        ↓
  Store hashed OTP (sha256 or bcrypt) in Redis with TTL 5m (OTP_TTL)
     key = otp:whatsapp:<phone>
     value = { hash, attempts:0, createdAt }
  + also persist audit row in PostgreSQL (OtpAttempt) for analytics/replay protection
        ↓
  Send via WhatsAppProvider (outside DB transaction — Redis is source for verify)
        ↓
POST /auth/otp/verify { phoneNumber, otp }
        ↓
  Fetch from Redis, compare hash, increment attempts
        ↓
  Success (≤3 attempts, not expired) → mark phoneVerified=true (if user exists)
     issue JWT (login) OR return { verified:true, verificationToken } for next step
        ↓
  Failure → 400 (invalid/expired), after 3 attempts → invalidate OTP, require resend
```

Config: `OTP_TTL=5m`, `OTP_MAX_ATTEMPTS=3`, `OTP_RESEND_COOLDOWN=60s`,
`OTP_LENGTH=6`, `WHATSAPP_PROVIDER=twilio|meta|noop`, `WHATSAPP_FROM_NUMBER`.

### 16.2.3 Data model

**Redis (primary for verify, authoritative for TTL):**

```text
key: otp:whatsapp:+2010xxxxxxx
value: { tokenHash: string, attempts: number, createdAt: number, expiresAt: number }
TTL: 300s
```

**PostgreSQL audit (optional but recommended for idempotency & forensics):**

```text
OtpVerification
---------------
id            uuid PK
phoneNumber   varchar @Index
userId        uuid nullable FK → User
purpose       enum('login','verify_phone','reset_password') default 'login'
codeHash      varchar -- sha256 of OTP
expiresAt     timestamptz
attempts      int default 0
verifiedAt    timestamptz nullable
createdAt     timestamptz
-- indexes: (phoneNumber, createdAt), (expiresAt)
-- CHECK attempts <= 3
```

If Redis is unavailable, verify path must degrade gracefully: return `503`
with retry-after, do not fall back to stale DB row as source of OTP truth
(Redis is cache-but-for-OTP it is the TTL authority; keep PG as audit only
per AGENTS.md infra rule — here OTP is ephemeral, so Redis-as-TTL is acceptable;
document exception in ADR).

### 16.2.4 REST API

| Method | Path | Auth | Body | Success | Errors |
|--------|------|------|------|---------|--------|
| POST | `/auth/otp/request` | public (or `JwtGuard` for verify-phone) | `{ phoneNumber, purpose? }` | `200 { message, expiresIn:300 }` | `400 invalid phone`, `429 cooldown` |
| POST | `/auth/otp/verify` | public | `{ phoneNumber, otp, purpose? }` | `200 { accessToken }` OR `200 { verified:true }` | `400 invalid/expired`, `429 too many attempts` |
| POST | `/auth/otp/request` (authenticated) | `JwtGuard` | `{}` (uses current user phone) | same | `404 no phone on file` |

DTOs: `RequestOtpDto` (`@Matches(/^\+[1-9]\d{1,14}$/)` E.164, `@IsEnum(OtpPurpose)`),
`VerifyOtpDto` (`@Length(6,6)`).

Flow variants:
* `purpose=login` → verify success issues JWT directly (passwordless).
* `purpose=verify_phone` → marks `user.phoneVerified=true`, returns no JWT.
* `purpose=reset_password` → returns short-lived `verificationToken` (JWT 5m) that
  `POST /auth/reset-password` can accept as alternative to email token.

### 16.2.5 Security / reliability

* [ ] Hash OTP before storage (sha256), never log raw OTP
* [ ] TTL enforced by Redis + service check `expiresAt > now`
* [ ] Max 3 attempts, then delete key (brute-force mitigation)
* [ ] Resend cooldown 60s per phone (Redis `SET NX EX`)
* [ ] Rate limit per IP (10/hour) + per phone (5/hour)
* [ ] OTP is numeric but generated via `crypto.randomInt` (not `Math.random`)
* [ ] WhatsApp send failures do not leak whether phone exists; log provider error
* [ ] Idempotent resend: if active OTP exists and cooldown not passed → `429`
* [ ] Provider abstraction keeps business logic testable via mock

## 16.3 Google OAuth Login

### 16.3.1 User-facing flow

```text
GET /auth/google
        ↓
  Passport GoogleStrategy (scope: profile email) → redirect to Google
        ↓
GET /auth/google/callback?code=...
        ↓
  GoogleStrategy.validate(accessToken, refreshToken, profile) → { googleId, email, firstName, lastName, avatar }
        ↓
  AuthService.handleGoogleLogin(profile)
      if user exists by googleId → return user
      else if user exists by email → link googleId to existing user (if local) → return user
      else → create new User { email, firstName, lastName, googleId, provider:'google', password:null, phoneVerified:false }
        ↓
  Issue JWT (same as local login) → redirect or JSON { accessToken }
```

Optional link flow for already-authenticated users: `GET /auth/google/link` with
`JwtGuard` → links Google to current user.

### 16.3.2 Data model

Reuses `User` alterations from 16.1.2 (`googleId`, `provider`, `password nullable`).
No separate token table needed; OAuth tokens are not persisted beyond session
unless refresh-token feature is added later (future: `UserOAuthAccount` table).

If app later supports multiple providers, extract to:

```text
UserOAuthAccount
----------------
id          uuid PK
userId      uuid FK → User
provider    enum('google','github',...)
providerId  varchar
email       varchar nullable
createdAt   timestamptz
@Unique([provider, providerId])
@Unique([userId, provider])
```

For Phase 16 V1 keep single `googleId` column to minimize migration churn.

### 16.3.3 Module / service changes

Dependencies (add to `package.json`):

```text
passport-google-oauth20
@types/passport-google-oauth20
```

New files:

```text
auth/
├── strategies/
│   ├── local.strategy.ts        (exists)
│   ├── jwt.strategy.ts          (add — replaces manual JwtGuard verify with Passport JWT)
│   └── google.strategy.ts       (new — PassportStrategy(Strategy, 'google'))
├── guards/
│   ├── google-auth.guard.ts     (extends AuthGuard('google'))
│   └── jwt-auth.guard.ts        (optional wrapper over AuthGuard('jwt'))
├── dto/
│   ├── forgot-password.dto.ts
│   ├── reset-password.dto.ts
│   ├── request-otp.dto.ts
│   └── verify-otp.dto.ts
├── entities/
│   ├── password-reset-token.entity.ts
│   └── otp-verification.entity.ts (optional audit)
└── providers/
    └── whatsapp.provider.ts     (interface + implementations)
```

`AuthModule` imports:

```text
PassportModule.register({ session: false })
JwtModule.registerAsync(...)  (exists, keep global)
TypeOrmModule.forFeature([PasswordResetToken, OtpVerification])
CacheModule (already global, for OTP rate limit)
```

`ConfigService` keys: `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `GOOGLE_CALLBACK_URL`
(e.g. `http://localhost:3000/auth/google/callback`), `FRONTEND_URL` for redirect.

`AuthService` new methods:

```text
handleGoogleLogin(profile: GoogleProfile): Promise<{ user: User, accessToken: string }>
linkGoogleAccount(userId: string, profile: GoogleProfile): Promise<User>
requestPasswordReset / validateResetToken / resetPassword (16.1)
requestWhatsAppOtp / verifyWhatsAppOtp (16.2)
```

`AuthController` new routes (see combined table below).

### 16.3.4 REST API

| Method | Path | Auth | Notes |
|--------|------|------|-------|
| GET | `/auth/google` | public | `GoogleAuthGuard` → 302 to Google |
| GET | `/auth/google/callback` | public (guard) | `GoogleAuthGuard` → `AuthService.handleGoogleLogin` → `200 { accessToken }` or `302 ${FRONTEND_URL}/auth/callback?token=...` |
| GET | `/auth/google/link` | `JwtGuard` | links Google to current user |
| POST | `/auth/forgot-password` | public | see 16.1.4 |
| POST | `/auth/reset-password` | public | see 16.1.4 |
| POST | `/auth/otp/request` | public / JwtGuard | see 16.2.4 |
| POST | `/auth/otp/verify` | public | see 16.2.4 |

Swagger: add `@ApiOperation`, `@ApiResponse` for each; Google redirect is
`@ApiExcludeEndpoint` or documented as redirect.

### 16.3.5 Security / decisions

* [ ] `GOOGLE_CLIENT_SECRET` never committed; via `.env` + `ConfigService`
* [ ] `state` param via Passport `state: true` (CSRF protection on OAuth)
* [ ] Email from Google is trusted but still verify `profile.emails[0].verified === true`; if not verified → reject or require OTP
* [ ] If email already exists as `local` with password, linking is allowed but
  requires either password confirmation or email-OTP before linking (prevent
  account takeover) — specify in `clarify` step
* [ ] JWT payload unchanged (`sub,email,fullName,role`) — Google users get same
  shape; `role` defaults to `User`
* [ ] `password` nullable migration must not break existing login: `userValidation`
  should return `null` if `password` is null and strategy is `local` (force OAuth path)
* [ ] Rate limit `/auth/google` and `/auth/google/callback` (per IP)

### 16.4 Cross-cutting concerns (all auth upgrades)

#### 16.4.1 Configuration (`.env` additions)

```text
# Password reset
RESET_TOKEN_TTL=15m
RESET_TOKEN_CLEANUP_DAYS=7

# OTP / WhatsApp
OTP_TTL=5m
OTP_MAX_ATTEMPTS=3
OTP_RESEND_COOLDOWN=60s
WHATSAPP_PROVIDER=noop          # noop|twilio|meta
WHATSAPP_FROM_NUMBER=+14155238886
TWILIO_ACCOUNT_SID=
TWILIO_AUTH_TOKEN=
META_WHATSAPP_TOKEN=
META_PHONE_NUMBER_ID=

# Google OAuth
GOOGLE_CLIENT_ID=
GOOGLE_CLIENT_SECRET=
GOOGLE_CALLBACK_URL=http://localhost:3000/auth/google/callback
FRONTEND_URL=http://localhost:3000

# JWT (existing)
JWT_SECRET=...
JWT_EXPIRES_IN=15m              # tighten from 60s if desired; document rotation
```

All read via `ConfigService`; never hardcode.

#### 16.4.2 Rate limiting

Reuse existing Redis infra (`@nestjs/cache-manager` + `@keyv/redis`) with a thin
`ThrottlerGuard` or custom `RateLimitGuard` (do not add `@nestjs/throttler`
unless justified; keep dependency minimal). Limits:

```text
forgot-password:  5 req / hour / IP  + 3 / hour / email
reset-password:  10 req / hour / IP
otp/request:  5 req / hour / phone + 10 / hour / IP, cooldown 60s per phone
otp/verify:  10 req / hour / phone, max 3 attempts per OTP
google/callback: 20 req / hour / IP
login/register: 10 req / hour / IP (existing, now enforced)
```

Use Redis `INCR` + `EXPIRE` or `SET NX EX` for atomic counters; on Redis
unavailable → fail open with log for auth (availability over strict limit) but
emit metric.

#### 16.4.3 Events / notifications

After `forgot-password` commit and after `otp/request`, publish async notification
after DB commit (pattern from `docs/architecture/data-flow.md` — commit then publish):

```text
DB commit
  ↓
Event: PasswordResetRequested { userId, email, token, expiresAt } or OtpRequested { phone, otp }
  ↓
RabbitMQ (NOTIFICATION_SERVICE) or BullMQ job
  ↓
Worker → email service / WhatsAppProvider
```

Tests mock the provider; integration tests assert event published, not actual
WhatsApp delivery.

#### 16.4.4 Module boundaries

* `AuthService` owns all auth business logic; `UsersService` owns user CRUD.
  `AuthModule` imports `UsersModule` and `TypeOrmModule.forFeature`.
* No other module should `@InjectRepository(User)` directly — go through
  `UsersService` or `AuthService` as appropriate (enforce in `AGENTS.md` §2).
* `Inventory`/`Reservation`/`Order` remain unaware of auth internals.

#### 16.4.5 Database constraints & indexes

```text
User:  UNIQUE(email)  -- add if missing; currently only Index
       UNIQUE(googleId) WHERE googleId IS NOT NULL
       UNIQUE(phoneNumber) WHERE phoneNumber IS NOT NULL
       CHECK provider IN ('local','google')
PasswordResetToken:  FK userId CASCADE, INDEX(userId), INDEX(tokenHash), INDEX(expiresAt)
OtpVerification:  FK userId SET NULL, INDEX(phoneNumber), INDEX(expiresAt)
```

Migrations: `17xxxxx-AuthUpgradesUserAndResetToken` and `17xxxxx-AddOtpAndGoogleFields`
— never edit committed migrations; `synchronize:false`.

#### 16.4.6 Error handling

Throw Nest HTTP exceptions: `BadRequestException` (invalid token/OTP/phone),
`NotFoundException` (user not found only internally; externally still 200 anti-enum),
`TooManyRequestsException`/`429` via `HttpException`, `UnauthorizedException`
for OAuth failures. Global `AllExceptionsFilter` serializes.

### 16.5 Implementation Plan (Spec Kit tasks)

Order matters — smallest increments:

```text
1. Spec: /speckit.specify auth-upgrades (forgot, token, otp, google) → clarify Q&A
2. Design: data-model.md (User alters, PasswordResetToken, OtpVerification), research.md (passport-google vs next-auth, twilio vs meta)
3. Contract: OpenAPI for 7 new endpoints + Google redirect
4. Migration 1: User alterations (googleId, phoneNumber, provider, password nullable, uniques)
5. Migration 2: PasswordResetToken entity + repo + service methods + controller (forgot/reset/validate)
6. Unit tests: requestPasswordReset (anti-enum, hash, expiry), validateResetToken, resetPassword (single-use, expiry, bcrypt)
7. Integration tests: real PG transaction, concurrent reset-password with same token → one wins
8. Migration 3 / Redis: OtpVerification audit + WhatsAppProvider interface + Noop provider + OTP request/verify flow
9. Unit + integration tests for OTP (TTL, max attempts, cooldown, hash, resend)
10. Migration 4: GoogleStrategy + AuthService.handleGoogleLogin + controller routes + JwtStrategy migration
11. E2E: register→forgot→reset→login, otp/request→otp/verify→login, google callback→JWT→access protected route
12. Rate limiting guard + config + tests (redis mock, fail-open)
13. Docs: docs/architecture/modules.md, docs/decisions/ADR-auth-upgrades.md, Swagger, Postman
```

### 16.6 Testing (must cover)

**Unit (mock repos, mock Redis/WhatsApp/Google):**

* [ ] forgot-password: existing email creates hashed token + expiresAt=now+15m, non-existing email still 200, prior tokens invalidated
* [ ] validate-reset-token: valid → user, expired → 400, used → 400, wrong hash → 400
* [ ] reset-password: success updates password bcrypt + sets usedAt, second use 400, expired 400, weak password 400
* [ ] otp: request generates 6-digit, hashes, sets Redis TTL, verify within attempts succeeds, 4th attempt invalidates, expired 400
* [ ] google: existing googleId returns same user, existing email links, new email creates user with provider google and null password, unverified Google email rejected

**Integration (real PostgreSQL, real Redis when available):**

* [ ] DB constraints: duplicate email 409, duplicate googleId partial unique, password nullable allowed, tokenHash insert
* [ ] Transaction: concurrent `reset-password` with same token → one 200 one 400, no double-use
* [ ] OTP Redis TTL: request → verify within TTL 200, after TTL 400
* [ ] Rate limit: exceed limit → 429, Redis down → request still succeeds with log

**E2E (supertest):**

* [ ] `POST /auth/register` → `POST /auth/forgot-password` → capture rawToken via test hook → `POST /auth/reset-password` → `POST /auth/login` with new password 200
* [ ] `POST /auth/otp/request` → `POST /auth/otp/verify` (mock provider captures OTP) → `GET /cart` with JWT 200
* [ ] `GET /auth/google` → 302, `GET /auth/google/callback` with mocked profile → 200 + JWT

### 16.7 Exit Criteria

Auth upgrades are complete when:

```text
[x] POST /auth/forgot-password returns 200 anti-enum, creates sha256-hashed token expires 15m, invalidates prior tokens
[x] POST /auth/reset-password validates token (hash, expiry, single-use), bcrypt-hashes new password, marks token used, all inside EntityManager transaction
[x] POST /auth/otp/request and POST /auth/otp/verify implement 6-digit OTP via WhatsAppProvider abstraction (Noop in dev/test, Twilio/Meta in prod), Redis TTL 5m, hash, 3 attempts, 60s cooldown — V1: purpose login (passwordless) + verify_phone only, login choice is password OR WhatsApp OTP (email OTP deferred)
[x] GET /auth/google and GET /auth/google/callback via passport-google-oauth20 issue same JWT shape as local login, link-by-email or create, password nullable, state CSRF (clarified 2026-09-15: auto-link verified email)
[x] User migration applied (googleId, phoneNumber, provider, password nullable, partial uniques), PasswordResetToken + OtpVerification (audit) migrations
[x] Rate limiting on all new auth endpoints via Redis (fail-open on Redis down)
[x] Unit 30+ and integration 10+ and E2E 3 flows PASS, including concurrent token reuse → single winner
[x] Swagger updated, docs/decisions ADR recorded, no secrets in repo, AllExceptionsFilter handles 400/401/429
```

### 16.8 Future — Email OTP (deferred from V1)

Clarified 2026-09-15 during `/speckit.clarify`: email OTP is **out of scope for Phase 16 V1**.

```text
Deferred to Phase 16.x / Phase 17:
  POST /auth/otp/request { email }  → email OTP via notification worker
  POST /auth/otp/verify { email, otp } → login OR reset_password verification
  Reuse same OtpVerification model with purpose=email_login|email_reset
  Do not weaken anti-enumeration: same 200 response for existing/non-existing email
  Keep WhatsApp OTP as phone-only in V1; add email channel later without breaking
  WhatsApp OTP contract.
```

---

# Current Backlog Status

## DONE

```text
[x] NestJS modular monolith foundation
[x] PostgreSQL + TypeORM
[x] Docker infrastructure
[x] Redis infrastructure
[x] RabbitMQ infrastructure
[x] Authentication
[x] Users
[x] Products
[x] Cart
[x] Cart items
[x] Basic validation
[x] Centralized error handling direction
[x] Product/inventory separation decision
[x] Reservation as separate domain decision
[x] PostgreSQL as transactional source of truth
[x] Database-level concurrency strategy identified
[x] Background processing separated from transactional consistency
[x] Inventory entity (stock, reservedAmount, available derived, FK productId, UQ + IDX)
[x] Inventory module (InventoryModule + InventoryService + InventoryController + DTOs)
[x] Inventory constraints (CHK stock>=0, reservedAmount>=0, reservedAmount<=stock, UQ productId)
[x] Inventory business operations (getInventory, checkAvailability, increase/decreaseStock, reserve/release/completeSale stubs, bulk via EntityManager)
[x] Inventory tests (unit 26 + integration 7, real PostgreSQL, Product.stock absence verified)
[x] Inventory migration (1755800000000-CreateInventoryAndDropProductStock, seed + drop Product.stock, synchronize: false)
[x] Inventory seeding (5 products seeded with random stock 67-174 via InventorySeeder)
```

## PARTIALLY DONE

```text
[~] Redis usage
[~] Rate limiting
[~] Database indexes
[~] Database constraints
[~] AI/project documentation
[~] Spec Kit setup
```

## NOT DONE

```text
[x] Reservation entity — DONE 2026-08-22 (Reservation + ReservationItem with constraints/indexes, migration 1755850000000)
[x] ReservationItem entity — DONE
[x] Reservation module — DONE (ReservationModule/Service/Controller, 6 REST routes)
[x] Reservation state machine — DONE (RESERVED→COMPLETED|EXPIRED|CANCELLED, 409 on invalid)

[x] Transaction-safe reservation — DONE 2026-08-30 (FOR UPDATE + sorted locking + available check + atomic reservedAmount, spec 003)
[x] PostgreSQL row locking — DONE (pessimistic_write in ReservationService.create, data-model.md §4)
[x] Concurrent reservation tests — DONE (unit 33 + integration concurrency contested/deadlock/disjoint, spec SC-003/SC-004)

[x] Reservation completion — DONE 2026-09-14 (RESERVED→COMPLETED `stock-=qty`+`reserved-=qty`, orderId overwrite, idempotent COMPLETED→COMPLETED 200, spec 004 Q3/Q4, FOR UPDATE Reservation+sorted Inventories)
[x] Reservation cancellation — DONE 2026-09-14 (RESERVED→CANCELLED `reserved-=qty` only, stock unchanged, `CANCELLED→CANCELLED` 409 per Q5, spec 004)
[x] Reservation expiration — DONE 2026-09-14 (RESERVED→EXPIRED `reserved-=qty` only, immediate admin override per Q1, `EXPIRED→EXPIRED` 409 per Q5, spec 004)

[ ] Expiration cleanup worker

[ ] Order integration
[ ] Checkout transaction
[ ] Order state machine
[ ] Order completion

[ ] Order cancellation

[ ] Auth upgrades — Phase 16 (planned 2026-09-15) — password-only login in V1 per 2026-09-16
[ ]   Forgot password (POST /auth/forgot-password anti-enum, sha256 hashed token, 15m TTL, invalidate priors)
[ ]   Recovery token (POST /auth/reset-password + validate, single-use, EntityManager tx, bcrypt, tokenVersion revocation)
[ ]   WhatsApp OTP (POST /auth/otp/request|verify, 6-digit crypto, Redis TTL 5m, 3 attempts, 60s cooldown, Twilio/Meta abstraction) — TODO (Future) DEFERRED per 2026-09-16: endpoints return 501, no WhatsApp setup required, login is password-only
[ ]   Google OAuth login (GET /auth/google + callback, passport-google-oauth20, link-by-email or create, password nullable, state CSRF)
[ ]   User alterations (googleId, phoneNumber, provider, password nullable, partial uniques, tokenVersion)
[ ]   Rate limiting on auth endpoints (Redis, fail-open, full headers) — OTP limits TODO until WhatsApp re-enable

[ ] Refresh token (Future, Phase 17 before Testing) — POST /auth/refresh rotation + POST /auth/logout(-all), opaque sha256 hashed RefreshToken (userId FK, tokenHash @Index, expiresAt 7d, revokedAt), tokenVersion revocation, theft detection revoke-all, HttpOnly cookie + body, RateLimitGuard — see Phase 17 spec

[ ] Email service (Future, Phase 18 before Testing) — verification email after register (GET|POST /auth/verify-email, POST /auth/resend-verification, EmailVerificationToken hash 24h, usedAt), password-reset email upgrade (actual sending), notifications for sales/new products (POST /admin/notifications/sales, PATCH /users/me/preferences marketingOptIn, BullMQ bulk + Redis dedup + NotificationLog, EmailProvider smtp/ses/noop) — see Phase 18 spec

[ ] Payment (Stripe Test Mode, New Payment Module) (Future, Phase 19 before Testing) — separate payment.module (stripe npm test mode), Payment {orderId @Unique FK, userId FK, amount, currency, status PENDING|SUCCEEDED|FAILED|CANCELLED, stripePaymentIntentId @Unique, stripeEventId, provider}, POST /payments/intent (orderId) → pi_xxx clientSecret, POST /payments/webhook (rawBody + Stripe-Signature verify, idempotent evt.id, amount check, transactional Order PENDING→COMPLETED/FAILED + Reservation + stock), POST /payments/:id/confirm-test (test card 4242 vs 0002) — see Phase 19 spec

[ ] Dashboard, RBAC & Metrics (Future, Phase 20 before Testing) — separate dashboard.module, UserRoles {Customer/Admin/CoAdmin/ContentManager/FulfillmentStaff} with Admin full / CoAdmin limited role management + last Admin guard + tokenVersion++ , CRUD products (ContentManager/Admin), CRUD users, R orders/carts, CRUD stock (PATCH bulk FOR UPDATE, low-stock query), metrics: revenue/sales SUM, AOV NULLIF, low-stock FILTER, cart abandonment windowed join, API health Redis/pg counters — see Phase 20 spec

[ ] Async events
[ ] Notification workers
[ ] RabbitMQ/BullMQ responsibilities
[ ] Idempotency
[ ] Retry handling

[ ] Complete integration tests
[ ] Concurrency tests
[ ] Complete E2E tests

[ ] Final architecture documentation
[ ] ADRs for important architectural decisions
```

---

# Immediate Development Roadmap

Do NOT work through all remaining items at once.

Work in this order:

## Current Milestone — Inventory

```text
Phase 1
Inventory Foundation
        ↓
Phase 2
Reservation Domain
        ↓
Phase 3
Transaction-Safe Reservation
        ↓
Phase 4
Reservation Lifecycle
        ↓
Phase 5
Expiration Cleanup
```

Only after these are stable:

```text
Phase 6
Order Integration
        ↓
Phase 7
Order Completion
        ↓
Phase 8
Cancellation
```

Then auth (orthogonal, can run in parallel with Phases 5–8):

```text
Phase 16
Auth Upgrades
  16.1 Forgot Password + Recovery Token
  16.2 WhatsApp OTP (provider abstraction, Redis TTL)
  16.3 Google OAuth Login (passport-google-oauth20)
  16.4 Rate limiting + config + events
```

Then infrastructure/reliability:

```text
Phase 9
Redis / Cache

Phase 10
Rate Limiting

Phase 11
Async Events / Notifications

Phase 12
Idempotency / Reliability

Phase 13
Database Optimization
```

Refresh token + Email + Payment + Dashboard (future, before final testing — see Phases 17-20):

```text
Phase 17
Refresh Token (Future) — POST /auth/refresh rotation, logout, tokenVersion revocation
        ↓
Phase 18
Email Service (Future) — verify after register, reset email, sales/news notifications (BullMQ bulk)
        ↓
Phase 19
Payment (Stripe Test Mode, New Payment Module) — separate payment.module, Payment 1:1 Order, PaymentIntent pi_xxx, webhook signature + idempotent evt.id, test cards 4242/0002
        ↓
Phase 20
Dashboard, RBAC & Metrics (Future) — separate dashboard module, role hierarchy, CRUD products/users/stock, 5 metrics (revenue, AOV, low-stock, abandonment, health)
        ↓
Phase 14
Complete Testing

Phase 15
Documentation / Spec Verification
```

---

# Manual Development Rule

For every phase:

```text
1. Read existing code
2. Identify affected modules
3. Write/confirm the specification
4. Clarify unresolved business decisions
5. Design the database changes
6. Design the service boundaries
7. Implement the smallest increment
8. Write tests
9. Run existing tests
10. Verify database behavior
11. Update documentation
12. Mark the phase complete
```

Do not implement future phases prematurely.

For example:

**Do not implement Order Completion while Reservation Creation is still untested.**

**Do not implement RabbitMQ events before the transactional business operation is correct.**

**Do not optimize Redis caching before the PostgreSQL inventory path is correct.**

---

# Current Position

The project is currently at:

```text
Foundation
    ↓
DONE
    ↓
Inventory
    ↓
DONE — 2026-08-21 (entity, API, migration, tests, seed)
    ↓
Reservation
    ↓
DONE — 2026-08-22 (entity, module, state machine)
    ↓
Concurrency
    ↓
DONE — 2026-08-30 (FOR UPDATE + available check, 33 unit + 14 integration concurrency)
    ↓
Lifecycle
    ↓
DONE — 2026-09-14 (RESERVED→COMPLETED/CANCELLED/EXPIRED transactional, inventory sync, spec 004)
    ↓
Expiration Cleanup
    ↓
DONE — 2026-09-21 (BullMQ worker 30s, poison, reservation.expired, 169 tests)
    ↓
Order Integration
    ↓
DONE — 2026-09-21 (checkout-only, atomic Order+Reservation+Inventory, historical price, concurrency single-winner)
    ↓
>>> CURRENT TARGET <<<
    ↓
Order Completion (Phase 7)
    ↓
Async infrastructure
    ↓
Reliability
    ↓
Testing
    ↓
Documentation
```

## Next Manual Task

The next task should be:

**Phase 5 — Reservation Expiration / Cleanup**

Start with:

```text
1. Design expiration scanner query (status=RESERVED AND expiresAt<=NOW()) using existing composite index (status,expiresAt)
2. Decide job infra (BullMQ vs scheduler) per `docs/plan.md` §5.4 + `research.md` D3 (worker enforces expiresAt, manual expire immediate)
3. Implement cleanup transaction (lock reservation FOR UPDATE → verify RESERVED → lock sorted inventories → reserved-=qty → status=EXPIRED)
4. Handle race with concurrent complete/cancel (single-winner via FOR UPDATE, loser 409)
5. Add unit + integration tests (real PG, time-based expiration, concurrent worker vs complete)
6. Verify no double-release on reprocessing (idempotent EXPIRED→EXPIRED 409)
```

Do not implement Order integration yet (Phases 6-8) before expiration is stable.

The purpose of the next phase is to automatically release expired inventory via a background worker, complementing the manual admin expire completed in Phase 4.
