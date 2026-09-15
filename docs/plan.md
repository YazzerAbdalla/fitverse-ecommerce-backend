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

**Status: NOT DONE**

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

Expired reservations eventually release inventory and concurrent expiration/completion/cancellation cannot corrupt inventory.

---

# Phase 6 — Order Integration

**Status: NOT DONE**

**Goal:** Connect reservations to Orders.

## 6.1 Order Model

Conceptually:

```text
Order
-----
id
user_id
status
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
unit_price
```

## 6.2 Historical Price

When the order is created:

```text
unit_price = Product.price
```

The OrderItem keeps this value.

Historical orders must not depend on the current Product price.

## 6.3 Checkout Flow

The exact checkout behavior must first be specified.

Current architectural direction:

```text
Client
  ↓
Cart
  ↓
Checkout
  ↓
Validate cart
  ↓
Reserve inventory
  ↓
Create order
  ↓
Create order items
  ↓
Commit
```

The exact transaction boundary must be decided in the feature specification.

## 6.4 Important Unresolved Requirement

Before implementation, decide:

```text
When does inventory become reserved?
```

Possible choices:

```text
A. When item is added to cart
B. When checkout starts
C. When order is created
D. Another explicit business stage
```

Do not implement this assumption silently.

### Phase 6 Exit Criteria

A successful checkout produces a consistent Order + OrderItems + Reservation + Inventory state.

---

# Phase 7 — Order Completion / Sale

**Status: NOT DONE**

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

* [ ] Do not invent a payment integration
* [ ] Define payment state separately when payment requirements exist
* [ ] Specify what happens when payment fails
* [ ] Specify what happens when payment succeeds

### Phase 7 Exit Criteria

A completed sale permanently decreases stock while releasing its reservation.

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
[x] POST /auth/otp/request and POST /auth/otp/verify implement 6-digit OTP via WhatsAppProvider abstraction (Noop in dev/test, Twilio/Meta in prod), Redis TTL 5m, hash, 3 attempts, 60s cooldown
[x] GET /auth/google and GET /auth/google/callback via passport-google-oauth20 issue same JWT shape as local login, link-by-email or create, password nullable, state CSRF
[x] User migration applied (googleId, phoneNumber, provider, password nullable, partial uniques), PasswordResetToken + OtpVerification (audit) migrations
[x] Rate limiting on all new auth endpoints via Redis (fail-open on Redis down)
[x] Unit 30+ and integration 10+ and E2E 3 flows PASS, including concurrent token reuse → single winner
[x] Swagger updated, docs/decisions ADR recorded, no secrets in repo, AllExceptionsFilter handles 400/401/429
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

[ ] Auth upgrades — Phase 16 (planned 2026-09-15)
[ ]   Forgot password (POST /auth/forgot-password anti-enum, sha256 hashed token, 15m TTL, invalidate priors)
[ ]   Recovery token (POST /auth/reset-password + validate, single-use, EntityManager tx, bcrypt)
[ ]   WhatsApp OTP (POST /auth/otp/request|verify, 6-digit crypto, Redis TTL 5m, 3 attempts, 60s cooldown, Twilio/Meta abstraction)
[ ]   Google OAuth login (GET /auth/google + callback, passport-google-oauth20, link-by-email or create, password nullable, state CSRF)
[ ]   User alterations (googleId, phoneNumber, provider, password nullable, partial uniques)
[ ]   Rate limiting on auth endpoints (Redis, fail-open)

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

Finally:

```text
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
>>> CURRENT TARGET <<<
    ↓
Expiration Cleanup (Phase 5 — automated worker)
    ↓
Orders
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
