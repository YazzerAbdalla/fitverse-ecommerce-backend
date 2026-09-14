# Feature Specification: Transaction-Safe Reservation

**Feature Branch**: `003-transaction-safe-reservation`
**Created**: 2026-08-30
**Status**: Draft
**Input**: User description: "Let's start on the phase 3 in the plan.md file"
**Source**: `docs/plan.md` Phase 3 — Transaction-Safe Reservation (§§3.1-3.4)

---

## 1. Overview

Phase 1 introduced `Inventory` as sole owner of `stock` / `reservedAmount` (derived `available = stock - reservedAmount`) with DB invariants. Phase 2 introduced `Reservation` + `ReservationItem` as a temporary claim on one or more inventories with a validated state machine (`RESERVED → COMPLETED|EXPIRED|CANCELLED`) but **without** transactional inventory mutation or row-level locking.

This feature makes reservation creation **atomic and concurrency-safe**. Multiple simultaneous requests for the same inventory must never oversell: only reservations whose requested quantities fit within `available` succeed; the rest are rejected with an insufficient-inventory error. All inventory reads, availability checks, `reservedAmount` increments, and `Reservation`/`ReservationItem` inserts must occur inside a single database transaction that holds pessimistic locks on the affected inventory rows for the minimal required duration.

### Goal

Concurrent reservation requests cannot oversell inventory. The system enforces `available >= requested_quantity` atomically under row-level locking inside a short, correctly ordered transaction.

---

## 2. User Scenarios & Testing

### User Story 1 — Atomic reservation creation with inventory hold (Priority: P1)

A shopper (or checkout flow) creates a reservation that claims quantities of one or more inventories. The system atomically verifies availability, increments `reservedAmount`, and persists the reservation. If any item lacks sufficient `available`, the entire request fails and no inventory is changed.

**Why this priority**: Core correctness guarantee. Without atomicity, overselling is possible and every later phase (lifecycle, expiration, orders) is unsafe.

**Independent Test**: Can be verified by creating a reservation for existing inventories within available limits and asserting: transaction committed, `Inventory.reservedAmount` increased by requested quantity, `Reservation` + `ReservationItem`s persisted with status `RESERVED`.

**Acceptance Scenarios**:

1. **Given** inventories A (`stock=10, reserved=2, available=8`) and B (`stock=5, reserved=0, available=5`) and authenticated user U, **When** U creates a reservation `{items: [{inventoryId: A, quantity: 3}, {inventoryId: B, quantity: 2}]}` (expiresAt in future or omitted), **Then** the request succeeds with `201`, a `Reservation` with status `RESERVED` and 2 items is persisted, and `A.reservedAmount` becomes 5, `B.reservedAmount` becomes 2 (available updated accordingly).
2. **Given** inventory A with `available=2`, **When** U requests `quantity=3` for A, **Then** the request is rejected with `409 Conflict` (insufficient inventory) and `A.reservedAmount` is unchanged and no `Reservation` is persisted.
3. **Given** a valid request with multiple items where one item lacks sufficient `available`, **When** creation is attempted, **Then** the entire transaction rolls back (no partial reservation, no partial `reservedAmount` increment).

---

### User Story 2 — Concurrent reservations do not oversell (Priority: P1)

Two shoppers attempt to reserve the last available units of the same inventory at nearly the same time. Only one request succeeds.

**Why this priority**: This is the exit criterion for Phase 3. It proves row-level locking + deterministic ordering works.

**Independent Test**: Can be verified by a concurrency integration test: set `stock=10, reserved=8` (`available=2`), fire two concurrent `POST /reservations` requests each for `quantity=2` of the same inventory, assert exactly one `201` and one `409`, final `reservedAmount` equals 10 (not 12), and only one `Reservation` exists.

**Acceptance Scenarios**:

1. **Given** inventory X with `available=2`, **When** user A and user B concurrently request `quantity=2` of X, **Then** exactly one request succeeds (`201`) and the other fails with `409 Conflict` / insufficient inventory, and `X.reservedAmount` is increased by 2 only once.
2. **Given** inventories A and B and two concurrent reservations that claim overlapping sets (e.g., R1: `{A:1, B:1}`, R2: `{B:1, A:1}` in opposite order in the request payload), **When** both are submitted concurrently, **Then** no deadlock occurs — one or both succeed depending on availability, but inventory invariants are never violated and at least one transaction completes without a deadlock error (deterministic lock ordering).
3. **Given** an inventory with large `available`, **When** two concurrent reservations for disjoint inventories are submitted, **Then** both succeed independently (locking is per-row, not global).

---

### User Story 3 — Transaction rolls back on any failure (Priority: P2)

If any step inside the reservation transaction fails (validation, FK check, uniqueness, or inventory invariant), the whole operation is rolled back.

**Why this priority**: Guarantees no phantom `reservedAmount` increments or half-created reservations; required for reliable failure handling.

**Independent Test**: Attempt reservation creation with an invalid `inventoryId` or duplicate `inventoryId` inside the same transaction-capable path; assert rollback leaves `reservedAmount` unchanged.

**Acceptance Scenarios**:

1. **Given** inventory A exists, **When** a reservation is attempted with items `[{inventoryId: A, quantity: 1}, {inventoryId: non-existent, quantity: 1}]`, **Then** the request fails with `404` and `A.reservedAmount` is unchanged.
2. **Given** a request with duplicate `inventoryId` A twice, **When** submitted, **Then** it is rejected with `400` and `A.reservedAmount` is unchanged.
3. **Given** inventory A with `CHECK` constraint `reservedAmount <= stock`, **When** a concurrent race would cause the check to fire, **Then** the losing transaction is rolled back and surfaced as `409`, not a 500.

---

### Edge Cases

- What happens when the same `inventoryId` appears twice in one request? → Reject `400` before acquiring locks (existing Phase 2 validation); DB unique `(reservationId, inventoryId)` as safety net.
- What happens when `quantity` is 0, negative, or non-integer? → Reject `400` via DTO validation before transaction.
- What happens when `expiresAt` is in the past? → Reject `400` before transaction (Phase 2 rule).
- What happens when two reservations lock inventories in different order? → Must order locks deterministically (e.g., sort inventoryIds lexicographically) to avoid deadlocks.
- What happens when reservation creation holds locks too long (e.g., large item count)? → Transaction must be kept short: only lock, check, increment, insert; no external I/O (Redis, RabbitMQ, email) inside.
- What happens when stock is sufficient at read time but another transaction commits first? → Pessimistic `FOR UPDATE` ensures the second transaction re-reads locked row and correctly detects `available < requested` → `409`.
- What happens when requesting more than `available` for one item but not others? → Fail whole reservation; do not partially reserve.
- What happens when `available` is exactly equal to requested? → Succeed (boundary: `>=`).
- How does system handle a client that retries after `409`? → Retry is safe; `409` is a business rejection, not a transient error. Transaction already rolled back.

---

## 3. Requirements

### Functional Requirements

- **FR-001**: System MUST create a reservation atomically inside a single database transaction that includes: acquiring pessimistic write locks on all affected `Inventory` rows, checking `available = stock - reservedAmount >= requested_quantity` per item, incrementing `Inventory.reservedAmount` by requested quantity, and inserting `Reservation` + `ReservationItem` rows. If any step fails, the transaction MUST roll back and no partial state persists.

- **FR-002**: System MUST use PostgreSQL row-level pessimistic locking (`SELECT ... FOR UPDATE` / TypeORM `pessimistic_write`) on every `Inventory` row referenced by the reservation request before reading `available`. Locks MUST be acquired inside the same `EntityManager` transaction that performs the subsequent check and mutation.

- **FR-003**: System MUST acquire multiple inventory locks in a **deterministic order** (e.g., sorted by `inventoryId` ascending) to prevent deadlocks when concurrent reservations touch overlapping inventory sets in different payload orders. The ordering rule MUST be documented and enforced in code.

- **FR-004**: System MUST enforce the availability rule per inventory line item: reservation succeeds only if `available >= requested_quantity` for **every** item; otherwise the whole reservation MUST be rejected with `409 Conflict` (or `ConflictException`) indicating insufficient inventory, and the transaction rolled back. `available` is derived (`stock - reservedAmount`), never accepted from the client.

- **FR-005**: System MUST keep the reservation-creation transaction short and free of unnecessary work: no Redis, RabbitMQ, BullMQ, email, or other external I/O inside the transaction; only the lock → check → increment → insert steps. Unnecessary inventory rows MUST NOT be locked (only those in the request).

- **FR-006**: System MUST keep the existing `ReservationService.create(manager, requestingUserId, dto)` signature that accepts an `EntityManager` (Phase 2 contract) and implement locking/checking/mutation through that manager's repositories. The controller MUST continue to wrap the call in `dataSource.transaction(manager => service.create(...))`. Existing validation (future `expiresAt`, at least one item, no duplicate `inventoryId`, `orderId` FK check, `quantity > 0`) MUST remain and execute before or within the transaction, and MUST also roll back if validation fails inside the transaction.

- **FR-007**: System MUST increment `Inventory.reservedAmount` via the transactional `EntityManager` (not the global repository) inside the creation transaction. The increment MUST be performed as an entity save/update through the locked row (or `increment` on the locked row) so that the `CHECK` constraints (`stock >=0`, `reservedAmount >=0`, `reservedAmount <= stock`) are enforced by the database and any violation surfaces as a transaction rollback.

- **FR-008**: System MUST surface insufficient-inventory failures as `409 Conflict` with a message identifying the affected inventory and quantities (e.g., available vs requested). The failure MUST NOT leak as `500` and MUST NOT persist partial state. Invalid FK `inventoryId` → `404`; duplicate → `400`; validation errors → `400`; invalid state → `409`.

- **FR-009**: System MUST preserve Phase 2 behavior for reads and non-creation transitions (`findById`, `listByUser`, `complete`/`cancel`/`expire` status-only paths) — they remain out of scope for inventory mutation in this phase. Inventory effects of `complete`/`cancel`/`expire` (decrementing `reservedAmount`/`stock`) remain deferred to Phase 4. Only creation is made transaction-safe in this phase.

- **FR-010**: System MUST have tests proving transaction safety: unit tests for locking-path logic (mocked manager where sensible) and **integration/concurrency tests against real PostgreSQL** that:
  - verify `available` calculation after reservation,
  - verify rollback on insufficient inventory / invalid FK / duplicate,
  - run the critical concurrency scenario `stock=10, reserved=8, A requests 2, B requests 2` with parallel execution and assert exactly one success + one `409` and correct final `reservedAmount`,
  - verify deterministic lock ordering prevents deadlocks (concurrent opposite-order payloads).

### Key Entities

- **Inventory**: Owns `stock`, `reservedAmount`; exposes derived `available = stock - reservedAmount`. Row is locked `FOR UPDATE` during reservation creation. Constraints `stock >=0`, `reservedAmount >=0`, `reservedAmount <= stock` remain enforced.
- **Reservation**: Temporary claim (`id`, `userId`, `orderId` nullable, `status=RESERVED` on creation, `expiresAt`, timestamps). Created only inside the atomic transaction after availability passes.
- **ReservationItem**: Line item (`id`, `reservationId`, `inventoryId`, `quantity >0`, unique `(reservationId, inventoryId)`). One per inventory in the reservation.

---

## 4. Success Criteria

### Measurable Outcomes

- **SC-001**: A reservation requesting quantities within `available` succeeds and increments `reservedAmount` by exactly the requested amount; the reservation and items are queryable by id immediately after commit (verified by integration test on real PostgreSQL).

- **SC-002**: A reservation requesting more than `available` for any item is rejected with `409` and leaves `reservedAmount` unchanged and no `Reservation` persisted (verified by integration test; whole transaction rolled back).

- **SC-003**: Under the concurrency test `stock=10, reserved=8` with two parallel requests each for `quantity=2` of the same inventory, exactly one request succeeds and one is rejected with `409`, and final `reservedAmount` equals 10 (never 12) in 100% of runs (verified by concurrent integration test; no overselling in any execution).

- **SC-004**: Concurrent reservations whose payloads list the same inventories in opposite order do not deadlock — both transactions complete (one or both succeed per availability) without a database deadlock error (verified by opposite-order concurrency test).

- **SC-005**: 100% of reservation-creation failures (insufficient inventory, unknown `inventoryId`, duplicate `inventoryId`, invalid `expiresAt`/`quantity`) leave zero partial state: no `Reservation` row and no `reservedAmount` change (verified by rollback assertions in integration tests).

---

## 5. Assumptions

- **A1**: PostgreSQL is authoritative; Redis/RabbitMQ/BullMQ are not touched inside the reservation-creation transaction (per `AGENTS.md` and `docs/plan.md` architectural rule).
- **A2**: Phase 1 `Inventory` and Phase 2 `Reservation`/`ReservationItem` entities, constraints, indexes, and `ReservationService.create(manager,...)` signature already exist — this phase augments `create` with locking/availability/mutation, not replaces the module.
- **A3**: Pessimistic locking (`FOR UPDATE` / `pessimistic_write`) is the chosen concurrency primitive (matches `docs/plan.md` §3.2 and existing precedent in `products.service.ts:updateMany`). Optimistic locking is out of scope.
- **A4**: Transaction boundary is owned by the caller (`ReservationController` via `dataSource.transaction`) and all writes use the passed `EntityManager`; global repositories are not used inside the locked path.
- **A5**: Availability check uses `inventory.available` (derived `stock - reservedAmount`) read from the **locked** row; client-supplied stock/available values are never trusted.
- **A6**: Deterministic lock ordering is by `inventoryId` lexicographic sort (UUID string). Alternative stable orders (by `id` or sorted row fetch) are acceptable if documented.
- **A7**: Error mapping: insufficient inventory → `409 ConflictException`; duplicate `inventoryId` → `400 BadRequestException`; unknown FK → `404 NotFoundException`; DB check violation inside transaction → `409`.
- **A8**: `synchronize: false`; any new DB behavior uses shared seeder (`InventorySeeder`) patterns, not ad-hoc DDL. No new tables/migrations expected for Phase 3 (uses existing `Inventory`/`Reservation`/`ReservationItem`).
- **A9**: Concurrency tests run against real PostgreSQL (not mocks), consistent with project Testing Rules: DB consistency/locking must not be asserted against mocks.
- **A10**: Inventory mutation for `COMPLETE`/`CANCEL`/`EXPIRE` (stock/reservedAmount decrements) is explicitly out of scope and remains Phase 4.

---

## 6. Dependencies

- Phase 1 `Inventory` entity, `InventoryService`, constraints, `InventorySeeder` — DONE.
- Phase 2 `Reservation`/`ReservationItem` entities, `ReservationService`/`ReservationController`, state machine, indexes, migration — DONE.
- `DataSource` / `EntityManager` transactional support (TypeORM) and existing `dataSource.transaction` pattern in `ReservationController`.
- Global `ValidationPipe` and `AllExceptionsFilter` (error serialization).

---

## 7. Out of Scope (this phase)

- Reservation lifecycle inventory effects: `RESERVED → COMPLETED` (`stock -= qty; reservedAmount -= qty`), `→ CANCELLED/EXPIRED` (`reservedAmount -= qty`) — Phase 4.
- Expiration cleanup worker (scheduled/BullMQ scan) — Phase 5.
- Order integration, checkout transaction, payment, order state machine — Phases 6-8.
- Redis caching, rate limiting, async events/RabbitMQ/BullMQ, idempotency/retry — Phases 9-12.
- New entities, new migrations, new modules beyond augmenting `ReservationService.create` and `Inventory`-row locking.
- Optimistic locking / application-level retries — not required; pessimistic lock + deterministic ordering is sufficient.

---

## 8. Clarifications

### Session 2026-08-30

- None yet — spec derived from `docs/plan.md` Phase 3 with no [NEEDS CLARIFICATION] markers. Availability rule, locking primitive, deadlock ordering, and transaction shape are fully specified by `plan.md` and confirmed by existing Phase 1/2 code review.

---

## 9. Acceptance Scenarios (for planning)

1. Create reservation within available → `201`, `reservedAmount` incremented, reservation retrievable.
2. Create reservation exceeding available → `409`, rollback, no persistence.
3. Create with multiple items where one exceeds available → `409`, full rollback.
4. Concurrent `stock=10,reserved=8` + two requests `qty=2` → one `201`, one `409`, final `reserved=10`.
5. Concurrent opposite-order payloads `{A,B}` vs `{B,A}` → no deadlock.
6. Create with unknown `inventoryId` → `404`, rollback, no `reservedAmount` change.
7. Create with duplicate `inventoryId` → `400`, rollback.
8. Transaction contains only lock→check→increment→insert; no external I/O inside.

