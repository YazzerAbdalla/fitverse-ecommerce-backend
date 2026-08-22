# Feature Specification: Reservation Domain

**Feature Branch**: `002-reservation-domain`
**Created**: 2026-08-22
**Status**: Draft (ready for /speckit.clarify)
**Input**: `docs/plan.md` Phase 2 — Reservation Domain (temporary inventory ownership)
**Source**: `docs/plan.md` §§2.1-2.3 + constitution principles III, IV, V

---

## 1. Overview

Phase 1 introduced `Inventory` as the sole owner of `stock` / `reserved_amount` with
DB-enforced invariants and a business API. Orders and checkout can contain multiple
products, so a single-product claim is insufficient.

This feature introduces **Reservation** as a first-class domain that represents a
**temporary claim on one or more inventory records**. It provides the data model
and service boundary that later phases (Phases 3-5 transaction-safe locking,
lifecycle, expiration) will make atomic, state-safe, and expirable. No
transactional locking, stock mutation, or expiration cleanup is implemented in
this phase — only the representation and validated state machine scaffolding.

### Goal

The system can represent, persist, retrieve, and validate transitions for a
reservation that temporarily claims inventory across multiple products. Inventory
remains the source of truth; reservation is the temporary ownership record.

---

## 2. User Scenarios & Testing

### User Story 1 — Create reservation with items (Priority: P1)

A checkout/cart flow (or an internal caller) creates a reservation for a user
that claims specific quantities of one or more inventories. The reservation
records who owns it, its status, when it expires, and the line items.

**Why this priority**: Core domain concept. Without this, no later concurrency
or lifecycle phase has anything to operate on. Delivers the minimal viable
temporary-claim representation.

**Independent Test**: Can be verified by creating a reservation with 2 items for
existing inventories and reading it back — reservation + items persisted with
correct FKs, quantities, and initial status `RESERVED`.

**Acceptance Scenarios**:

1. **Given** existing inventories for products A (stock 10, reserved 0) and B
   (stock 5, reserved 0) and an authenticated user U, **When** a reservation is
   created for U with items `[{inventoryId: A, quantity: 2}, {inventoryId: B, quantity: 1}]`
    and `expiresAt` in the future, **Then** a `Reservation` with status `RESERVED`
   and two `ReservationItem`s are persisted and retrievable by id.

2. **Given** a valid user but an item referencing a non-existent inventory,
   **When** creation is attempted, **Then** the system rejects with `404` / `NotFound`.

3. **Given** a user attempts to create a reservation with `quantity <= 0` or
   non-integer, **When** the request is validated, **Then** it is rejected with
   `400` / validation error (DB `CHECK quantity > 0` also enforced).

---

### User Story 2 — Retrieve reservation (Priority: P1)

A user or internal service retrieves a reservation by id to inspect its status,
expiration, and items. Ownership is enforced.

**Why this priority**: Read path is required to use reservations at all and to
test creation. Independent of mutation.

**Independent Test**: Create reservation, then `GET /reservations/:id` (or
service `findById`) returns the reservation with items and inventory references;
requesting unknown id returns 404.

**Acceptance Scenarios**:

1. **Given** a reservation R owned by user U exists, **When** U fetches R,
   **Then** the full reservation with items is returned.
2. **Given** reservation R exists, **When** a different user V (non-owner, non-ADMIN) or unauthenticated caller fetches R, **Then** the request is rejected (`403` for non-owner non-ADMIN / `401` unauthenticated). Owner or ADMIN succeeds.
3. **Given** no reservation with id X, **When** fetched, **Then** `404`.

---

### User Story 3 — Validate state transitions (Priority: P2)

The system enforces the reservation state machine. Only valid transitions are
accepted; invalid ones are rejected explicitly.

**Why this priority**: Prevents lifecycle corruption that later phases (complete /
cancel / expire) rely on. Can be tested without yet mutating inventory.

**Independent Test**: Attempt each transition from each state and assert only
allowed transitions succeed.

**Acceptance Scenarios**:

1. **Given** a reservation in `RESERVED`, **When** transitioning to `COMPLETED`,
   `CANCELLED`, or `EXPIRED`, **Then** the transition succeeds (state updated).
2. **Given** a reservation in `COMPLETED`, `EXPIRED`, or `CANCELLED`,
   **When** any further transition is attempted, **Then** it is rejected with
   `409 Conflict` / `BadRequest`.
3. **Given** a transition `RESERVED -> COMPLETED`, **When** performed, **Then** `orderId` may be set if supplied and validated (404 if not found); otherwise remains NULL until Phase 6 checkout links it, after which FK becomes strict.

---

### User Story 4 — List / ownership scoping (Priority: P3)

A user lists their own reservations (paginated); admins may list all.

**Why this priority**: Useful for debugging and future order integration but not
required for the minimal claim representation. Defer if needed.

**Independent Test**: Create 3 reservations for U, 1 for V; listing as U returns
only U's 3 (paginated).

**Acceptance Scenarios**:

1. **Given** user U has 3 reservations, **When** U lists with `page=1, limit=2`,
   **Then** 2 items + pagination meta returned.
2. **Given** admin role, **When** listing with optional `userId` filter,
   **Then** all reservations or filtered set returned.

---

### Edge Cases

- What happens when `expiresAt` is in the past at creation time? → Reject validation (`expiresAt` must be a future timestamp).
- What happens when the same `inventoryId` appears twice in one reservation? → Rejected with `400` by the service (duplicate detected before persistence); on a race the DB unique constraint `(reservationId, inventoryId)` yields `409` — no merge.
- What happens when `quantity` exceeds available inventory? → Phase 2 does NOT enforce availability via stock mutation, but creation should validate `quantity > 0` and item inventory existence. Availability enforcement belongs to Phase 3 (transaction + lock). Spec notes this deferral.
- What happens when `orderId` is provided but does not reference an existing Order? → Service validates existence and throws `404` if not found (per /speckit.clarify). If `orderId` is omitted it stays `NULL`; Phase 6 links it on `COMPLETE`. FK is nullable (`ON DELETE SET NULL`) now.
- How does system handle concurrent state transitions (e.g. complete vs expire vs cancel)? → Phase 2 validates single-threaded transitions; atomicity/row-locking is Phase 3-5. Document race note.
- What happens when reservation has zero items? → Reject (at least one item required).

---

## 3. Requirements

### Functional Requirements

- **FR-001**: System MUST provide a `Reservation` entity with fields:
  `id` (uuid pk), `userId` (uuid, FK → User), `orderId` (uuid, nullable, FK → Order),
  `status` (enum `RESERVED | COMPLETED | EXPIRED | CANCELLED`), `expiresAt`
  (timestamp), `createdAt`, `updatedAt`.

- **FR-002**: System MUST provide a `ReservationItem` entity with fields:
  `id` (uuid pk), `reservationId` (uuid, FK → Reservation, CASCADE),
  `inventoryId` (uuid, FK → Inventory, CASCADE or RESTRICT), `quantity` (int, >0),
  `createdAt`, `updatedAt` (both timestamps), with
  unique constraint on `(reservationId, inventoryId)` to prevent duplicate inventory
  claim within same reservation.

- **FR-003**: Relation: `Reservation` 1 — * `ReservationItem` * — 1 `Inventory`.
  Fetching a reservation MUST be able to include its items (and items' inventory)
  without N+1.

- **FR-004**: System MUST enforce reservation status enum with exactly four states:
  `RESERVED`, `COMPLETED`, `EXPIRED`, `CANCELLED`. No additional states in this phase.

- **FR-005**: System MUST enforce explicit state-transition rules:
  - `RESERVED → COMPLETED | EXPIRED | CANCELLED` allowed.
  - All other transitions (`COMPLETED → *`, `EXPIRED → *`, `CANCELLED → *`) MUST be
    rejected with `409 Conflict` (or `BadRequest`). Transition validation is via a
    service method, not only DB check.

- **FR-006**: System MUST validate `Reservation` fields:
  `expiresAt` is optional at API (defaults to `now + 15m` in service) and when supplied must be in the future at creation; `quantity > 0`
  integer per item; at least one item; no duplicate `inventoryId` within a reservation.
  `orderId` nullable `FK ON DELETE SET NULL` now; when supplied, service checks existence → `404` if not found; remains NULL until Phase 6 links on `COMPLETE`, after which FK enforcement becomes strict (future migration).

- **FR-007**: System MUST expose a `ReservationModule` with `ReservationService`
  providing operations: `create`, `findById`/`retrieve`, `complete`, `cancel`,
  `expire`, `validateTransition` (and optionally `listByUser`). Service is the only
  place that mutates reservation state; controllers are thin. Module exports
  `ReservationService` for later order integration.

- **FR-008**: System MUST enforce auth/ownership: creating a reservation requires
   authenticated user (`@Auth(UserRoles.User, UserRoles.Admin)` + `JwtGuard`); a user can only `create` for themselves and `read/cancel/complete/list` reservations where `reservation.userId === requesterId` unless caller has the `ADMIN` role (enforced in service via `UserRoles.Admin`). Unauthenticated → `401`; wrong owner non-ADMIN → `403`. The `expire` endpoint additionally requires `@Auth(UserRoles.Admin)`. Controller uses `@CurrentUser('sub')` for `requestingUserId` and `@CurrentUser('role')` for role.

- **FR-009**: System MUST add DB constraints and indexes:
  - `CHECK quantity > 0` on `ReservationItem`.
  - `@Index(['userId'])`, `@Index(['status'])`, `@Index(['expiresAt'])` on Reservation;
    `@Index(['reservationId'])`, `@Index(['inventoryId'])` on ReservationItem.
  - FKs: `Reservation.userId → User`, `Reservation.orderId → Order` (nullable),
    `ReservationItem.reservationId → Reservation`, `ReservationItem.inventoryId → Inventory`.
  - Enum constraint on `status`.

- **FR-010**: System SHALL NOT in Phase 2 implement: pessimistic locking,
  `Inventory.reservedAmount` mutation on reservation create/complete/cancel/expire,
  expiration cleanup worker, or order checkout transaction. Those belong to Phases 3-6.
  The service stubs for `complete`/`cancel`/`expire` in this phase only update
  reservation status (and optionally `orderId`) after transition validation; inventory
  adjustment is deferred. Method signatures MUST accept `EntityManager` (e.g. `create(manager, dto)`) for future transactional use (decided Option B).

- **FR-011**: System MUST have tests: unit tests for service (creation, retrieval,
  transition validation, duplicate/zero-quantity rejection) and integration tests
  against real PostgreSQL for FKs, constraints, indexes, and entity persistence.
  Concurrency/expiration-worker tests are deferred to Phases 3-5.

### Key Entities

- **Reservation**: Represents a temporary claim on inventory for a user, optionally
  linked to an order after checkout. Attributes: id, userId, orderId (nullable),
  status (RESERVED|COMPLETED|EXPIRED|CANCELLED), expiresAt, createdAt, updatedAt.
  Relations: many ReservationItems, one User, zero/one Order.

- **ReservationItem**: Line item within a reservation claiming a quantity of a
  specific inventory. Attributes: id, reservationId, inventoryId, quantity.
  Relations: one Reservation, one Inventory.

---

## 4. Success Criteria

### Measurable Outcomes

- **SC-001**: A reservation with 1..N items can be created and retrieved by id
  with status `RESERVED` and correct `expiresAt` and item quantities (verified by
  unit + integration test).

- **SC-002**: Invalid writes are rejected: `quantity <= 0` → 400, duplicate
  `(reservationId, inventoryId)` → 409/unique-violation, `expiresAt` in past → 400,
  unknown `inventoryId` → 404 (verified by tests against real DB).

- **SC-003**: Only allowed state transitions succeed; all disallowed transitions
  are rejected with 409 (verified by exhaustive transition matrix test).

- **SC-004**: DB constraints exist and are verified by integration tests:
  `CHECK quantity > 0`, FK integrity, enum enforcement, indexes on
  `status`, `expiresAt`, `userId`, `reservationId`, `inventoryId`.

- **SC-005**: Module boundary respected: no other module reaches into
  `Reservation`/`ReservationItem` repositories directly; all access via
  `ReservationService` (verified by code review).

---

## 5. Assumptions

- **A1**: Auth system (`Auth`, `JwtGuard`, `CurrentUser`) from existing codebase is
  reused; no new auth mechanism.
- **A2**: `Inventory` already exists and seeded (Phase 1). `ReservationItem.inventoryId`
  references `Inventory.id` (not `Product.id` directly) per `docs/plan.md` §2.2.
- **A3**: `Order` entity exists as stub; `Reservation.orderId` is nullable `FK ON DELETE SET NULL` in Phase 2 and may stay NULL; if supplied service validates → 404. After Phase 6, FK becomes strict when linked on `RESERVED→COMPLETED` (future migration to enforce).
- **A4**: `expiresAt` is optional in DTO; when omitted service defaults to `now + 15 minutes`. When supplied it MUST be a future timestamp (validated with `IsDateString` + `isFuture` check). Past or equal-to-now values rejected with `400`.
- **A5**: No new infrastructure (Redis/RabbitMQ/BullMQ) in this phase; expiration
  cleanup worker is Phase 5.
- **A6**: Pagination for list follows existing `offset-based {page, limit} → {data, meta}` shape.
- **A7**: Business operation names follow existing conventions; exact DTO/controller
  route names finalized in design.
- **A8**: `synchronize: false` (migrations required) continues from Phase 1.

---

## 6. Dependencies

- Phase 1 Inventory domain (entity, constraints, `InventoryService`, seeding) — DONE.
- Existing `User` entity (`src/modules/users/entity/user.entity.ts`) for FK.
- Existing `Order` stub (`src/modules/order/entities/order.entity.ts`) — nullable FK.
- Existing `Inventory` entity (`src/modules/inventory/entities/inventory.entity.ts`).
- Global `ValidationPipe` (whitelist, forbidNonWhitelisted, transform).
- `AllExceptionsFilter` for error serialization.

---

## 7. Out of Scope (this phase)

- Phase 3 Transaction-safe reservation (pessimistic locking, `reservedAmount` mutation,
  availability check `available >= requested_quantity`, deadlock-safe ordering).
- Phase 4 Full lifecycle with inventory effects (complete → `stock/reservedAmount` decrements).
- Phase 5 Expiration cleanup worker (BullMQ/Nest scheduler, race handling).
- Phase 6+ Order integration, checkout transaction, payment, cancellation/refund,
  Redis cache, rate limiting, async events, idempotency.
- REST controller routes beyond thin CRUD (deferred decision; service-first is sufficient for Phase 2).

---

## 8. Clarifications

### Session 2026-08-22

- Q: Default `expiresAt` TTL when caller does not supply value? → A: Optional → defaults to now + 15 minutes; if supplied must be future (Option A).
- Q: Ownership enforcement — who can read/mutate a reservation? → A: Owner or ADMIN only — create requires auth; read/cancel/complete allowed only if `reservation.userId === requesterId` OR requester is `ADMIN` (otherwise 403; unauth 401) (Option A).
- Q: `orderId` FK enforcement timing? → A: Nullable FK (`ON DELETE SET NULL`) now; service validates if `orderId` supplied but not found → 404, otherwise stays NULL until Phase 6; after Phase 6 FK becomes strict required when linked on COMPLETE (future update).
- Q: Duplicate `inventoryId` within same reservation? → A: Reject duplicate — DTO 400 validation + DB `@Unique(['reservationId','inventoryId'])` → 409 on violation (Option A).
- Q: `ReservationService` method signatures in Phase 2? → A: Require `EntityManager` param now for future transactional safety (Option B) — `create(manager, dto)` etc.; plain wrappers will be added in Phase 3 for locking.

---

## 9. Acceptance Scenarios (for planning)

1. Create reservation for user U with 2 items (inventory A qty 2, inventory B qty 1,
   future expiresAt) → `RESERVED` with both items persisted.
2. Create with quantity 0 or -1 → `400`.
3. Create with duplicate inventoryId in items → `400`/`409`.
4. Fetch existing reservation by id as owner → returns with items.
5. Fetch unknown id → `404`.
6. Transition `RESERVED → COMPLETED` → succeeds (Phase 2 status-only).
7. Transition `COMPLETED → CANCELLED` → `409`.
8. Integration: direct INSERT of `ReservationItem` with `quantity = 0` violates
   `CHECK` and is rejected by DB.
