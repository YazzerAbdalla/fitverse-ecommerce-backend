# Feature Specification: Reservation Lifecycle

**Feature Branch**: `004-reservation-lifecycle`  
**Created**: 2026-09-14  
**Status**: Draft  
**Input**: User description: "start the next not done phase in the docs/plan.md"  
**Source**: `docs/plan.md` Phase 4 — Reservation Lifecycle (§§4.1-4.5)

---

## 1. Overview

Phase 1 introduced `Inventory` (`stock`, `reservedAmount`, derived `available = stock - reservedAmount`, DB checks `stock>=0`, `reservedAmount>=0`, `reservedAmount<=stock`). Phase 2 introduced `Reservation` + `ReservationItem` (`status` enum `RESERVED|COMPLETED|EXPIRED|CANCELLED`, indexes, `validateTransition`, `assertOwner`) but without inventory side-effects beyond creation. Phase 3 made **creation** atomic and concurrency-safe (`FOR UPDATE` + deterministic lock ordering + `available >= requested` check + `reservedAmount += qty` inside `dataSource.transaction`).

This feature makes **all lifecycle transitions** explicit, transactional, and inventory-synchronized. Every transition after creation has a fixed, DB-enforced effect on `Inventory` and a strict state-machine guard. Only one terminal transition may win under concurrency; DB constraints guarantee `reservedAmount`/`stock` never go negative or inconsistent.

### Goal

Every reservation has a well-defined lifecycle and inventory remains synchronized with the reservation state. `RESERVED→COMPLETED` converts reserved units into sold units; `RESERVED→CANCELLED` and `RESERVED→EXPIRED` release reserved units. No invalid transition is ever silently accepted and no concurrent race can double-release or double-sell inventory.

---

## 2. User Scenarios & Testing

### User Story 1 — Complete a reserved sale (Priority: P1)

An owner (shopper) or admin completes a `RESERVED` reservation that represents a successful sale (e.g., after checkout/order). The system atomically converts every reserved unit into sold stock.

**Why this priority**: This is the revenue path. If completion is not transactional, stock and reservations drift — the core Phase 4 exit criterion.

**Independent Test**: Create a reservation for 1-2 inventories (`stock=10, reserved=3 → available=7`), call `PATCH /reservations/:id/complete`, assert `200`, `status=COMPLETED`, `Inventory.stock = oldStock - qty`, `Inventory.reservedAmount = oldReserved - qty`, `available` unchanged at transition moment (`stock - reserved` shifts equally), and DB row reflects the same.

**Acceptance Scenarios**:

1. **Given** reservation R in `RESERVED` with items `[{inventory A, qty 3}]` where `A` is `stock=10, reserved=3, available=7`, **When** owner calls `PATCH /reservations/:id/complete` (optionally with `orderId` that exists), **Then** response is `200 {status: COMPLETED}`, and in DB `A.stock=7, A.reservedAmount=0, A.available=7`, and `R.status=COMPLETED`.
2. **Given** reservation R with multiple items `A qty 2 + B qty 1` (A `stock=10 reserved=2`, B `stock=5 reserved=1`), **When** completed, **Then** both inventories are updated atomically (`A.stock=8,A.reserved=0`, `B.stock=4,B.reserved=0`) or the whole operation rolls back.
3. **Given** `R` already `COMPLETED`, **When** a second `complete` is attempted (retry/double-click), **Then** it returns `200` idempotent success with `status=COMPLETED` and inventory is not changed a second time (per 2026-09-14 clarification; other invalid edges like `COMPLETED→CANCELLED` remain `409`).
4. **Given** a valid `orderId` is supplied on complete, **When** the order exists, **Then** `R.orderId` is set; **When** the order does not exist, **Then** `404 NotFound` and no inventory or status change.

---

### User Story 2 — Cancel a reserved hold (Priority: P1)

An owner cancels a `RESERVED` reservation before it is sold. The held units are released back to available without touching `stock`.

**Why this priority**: Cancellation is the normal undo path (user abandons checkout). Without correct release, `reservedAmount` leaks and stock appears unavailable forever.

**Independent Test**: Create `RESERVED` reservation `qty 2` on `A (stock=10,reserved=2)`, call `PATCH /:id/cancel`, assert `CANCELLED`, `A.reservedAmount` decreased by 2, `A.stock` unchanged, `A.available` increased by 2.

**Acceptance Scenarios**:

1. **Given** R `RESERVED` with `A qty 2` (`stock=10,reserved=5,available=5`), **When** owner calls `PATCH /:id/cancel`, **Then** `200 {status: CANCELLED}`, DB `A.stock=10, A.reserved=3, A.available=7`, `R.status=CANCELLED`.
2. **Given** R already `CANCELLED`, **When** cancel is retried, **Then** `409` and no second decrement of `reservedAmount`.
3. **Given** R is `COMPLETED`, **When** cancel is attempted, **Then** `409 Invalid transition COMPLETED -> CANCELLED` and inventory unchanged.
4. **Given** non-owner non-admin requests cancel, **When** called, **Then** `403 Forbidden`.

---

### User Story 3 — Expire a stale hold (Priority: P1)

A `RESERVED` reservation whose `expiresAt` has not yet been enforced is expired (admin-only `PATCH /:id/expire` now; Phase 5 will automate via worker). Effect is identical to cancellation: `reservedAmount -= qty`, stock unchanged. Must be safe under race with concurrent `complete`/`cancel`.

**Why this priority**: Expiration is the safety valve that prevents indefinite holds. Its inventory effect must be transaction-safe even before the background worker exists.

**Independent Test**: Create `RESERVED` reservation with `expiresAt = now+15m` (default) or near-future, call admin `PATCH /:id/expire`, assert `EXPIRED`, `reservedAmount` released, `stock` unchanged.

**Acceptance Scenarios**:

1. **Given** R `RESERVED` with `A qty 1` (`stock=10,reserved=1`, `expiresAt` in future e.g. `now+15m`), **When** admin calls `PATCH /:id/expire` (even though `expiresAt > NOW()`), **Then** `200 {status: EXPIRED}`, DB `A.reserved=0, A.stock=10` — manual expire is an immediate admin override and does not check `expiresAt` (per 2026-09-14 clarification).
2. **Given** R already `EXPIRED`, **When** expire is retried, **Then** `409` and no double-decrement.
3. **Given** R is `COMPLETED` or `CANCELLED`, **When** expire is attempted, **Then** `409`.
4. **Given** non-admin attempts `PATCH /:id/expire`, **When** called, **Then** `403` (only admin may expire manually; Phase 5 worker will use service directly).

---

### User Story 4 — Reject invalid state transitions explicitly (Priority: P1)

Every status change is guarded by `validateTransition`. The only allowed transitions are `RESERVED → COMPLETED | EXPIRED | CANCELLED`. All other edges must be rejected with a clear error and without side effects.

**Why this priority**: Prevents silent corruption — the constitution principle III requires explicit transition rules.

**Independent Test**: For each invalid pair (`COMPLETED→EXPIRED`, `COMPLETED→CANCELLED`, `EXPIRED→COMPLETED`, `CANCELLED→COMPLETED`, `EXPIRED→CANCELLED`, etc.), create a reservation, force it to the `from` state, then attempt the transition and assert `409` and inventory unchanged.

**Acceptance Scenarios**:

1. **Given** R in `COMPLETED`, **When** any of `cancel` or `expire` (or second `complete`) is called, **Then** `409 Conflict "Invalid reservation transition: COMPLETED -> X"` and DB unchanged.
2. **Given** R in `EXPIRED`, **When** `complete` or `cancel` is called, **Then** `409` and `reservedAmount` not decremented again.
3. **Given** R in `CANCELLED`, **When** `complete` or `expire` is called, **Then** `409`.
4. **Given** concurrent `complete` and `cancel` arrive at the same instant for the same `RESERVED` R, **When** both execute as `dataSource.transaction(manager => service.*(manager,...))`, **Then** exactly one succeeds (`200`) and the other gets `409`, and inventory is mutated exactly once (no double `reservedAmount -= qty` and no `stock -= qty` without a matching `reservedAmount` decrement).

---

### Edge Cases

- What happens when `reservedAmount < quantity` at complete/cancel/expire time due to earlier bug or manual DB edit? → The transition must still preserve DB checks (`reservedAmount >=0`) and reject or clamp? Correct behavior: `reservedAmount -= qty` must not go negative; transaction must verify the row lock and if invariant would be violated, roll back with `409`.
- What happens when `stock < quantity` at complete time? (`stock=5, reserved=3, qty=3` → `stock - qty =2` but `reserved -=3` → final `reserved=0`, but `stock>=0` holds) — still valid; completion always reduces both by same `qty`, so `reservedAmount <= stock` remains true if it was before.
- What happens when inventory row is deleted between reservation creation and completion? → `404 Inventory not found`, transaction rolled back, status unchanged.
- What happens when `orderId` supplied on complete is not a UUID or references non-existent order? → `400` or `404` before inventory mutation.
- What happens when a reservation has multiple items and one inventory row fails the update? → Whole transaction rolls back (no partial stock/reserved changes, no partial status change).
- What happens when the same `RESERVED` reservation is completed twice due to retry/network duplication? → Second call must be `409` idempotency guard via status check inside the locked transaction (not just before it).
- What happens when creation already handled `reservedAmount += qty` but lifecycle code is called outside a transaction? → All lifecycle mutations (`complete`/`cancel`/`expire`) MUST require an `EntityManager` and be invoked inside `dataSource.transaction`; controller already does `dataSource.transaction(manager => service.complete(manager,...))` — service must use `manager`, not global repo.
- How does system handle a client that supplies no `orderId` on complete? → Allowed; `orderId` remains `null` and completion still performs `stock`/`reserved` decrement.
- What happens when stock is updated concurrently by an unrelated `increaseStock` while a cancellation is in flight? → Row-level `FOR UPDATE` on inventories serializes the two writers; last writer wins but invariant `reserved <= stock` is still enforced.

---

## 3. Requirements

### Functional Requirements

- **FR-001**: System MUST execute each lifecycle transition (`complete`, `cancel`, `expire`) inside a single database transaction that: (a) locks the `Reservation` row `FOR UPDATE`, (b) verifies the current status is `RESERVED` and `validateTransition(RESERVED -> target)` passes, (c) locks every `Inventory` row referenced by the reservation's `ReservationItem`s `FOR UPDATE` in deterministic sorted order (`inventoryId` ascending), (d) mutates inventory, (e) updates `Reservation.status` to the target state, (f) commits — or rolls back entirely on any failure. No partial inventory/status persistence is allowed.

- **FR-002**: `RESERVED → COMPLETED` MUST set `Reservation.status = COMPLETED` (and optionally `Reservation.orderId` if `dto.orderId` is supplied and exists) and for each item: `Inventory.stock -= quantity` and `Inventory.reservedAmount -= quantity` using the transactional `EntityManager`. If `orderId` is supplied, the order MUST be verified to exist (`404` if not) before any inventory mutation; `orderId` validation failure MUST roll back. **Clarified (2026-09-14)**: No service-level `stock >= qty` guard is required — rely on DB `@Check stock>=0` (and `reservedAmount>=0`) as the final safety net; if `stock - qty < 0` the transaction rolls back and surfaces as `409` per FR-007 mapping (no explicit `stock>=qty` check in code). **Clarified (2026-09-14)**: If `dto.orderId` is supplied on complete, it always overwrites `Reservation.orderId` (after existence check), even if `orderId` was already set — last write wins per user selection.

- **FR-003**: `RESERVED → CANCELLED` and `RESERVED → EXPIRED` MUST set status to `CANCELLED` / `EXPIRED` respectively and for each item: `Inventory.reservedAmount -= quantity` (stock unchanged) via the transactional `EntityManager`. They MUST NOT modify `stock`. **Clarified (2026-09-14)**: Manual admin `expire` (`PATCH /:id/expire`) in this phase MUST NOT enforce `expiresAt <= NOW()` — any `RESERVED` reservation may be expired immediately as an admin override; the Phase 5 automated worker will be the component that enforces `expiresAt <= NOW()`.

- **FR-004**: Allowed transitions are **only**: `RESERVED → COMPLETED`, `RESERVED → CANCELLED`, `RESERVED → EXPIRED`. All other transitions (`COMPLETED → *` except idempotent replay, `EXPIRED → *`, `CANCELLED → *`, `RESERVED → RESERVED`) MUST be rejected by `validateTransition` with `409 ConflictException` and MUST NOT mutate inventory or reservation state. **Clarified (2026-09-14)**: `COMPLETED → COMPLETED` (retry of complete on already-COMPLETED reservation) is an idempotent success — return `200` with current `COMPLETED` reservation and **no** inventory re-mutation, not `409`. All other `COMPLETED → CANCELLED/EXPIRED` etc. remain `409`. The controller already maps service exceptions via the global `AllExceptionsFilter`; service MUST throw `ConflictException` with message `"Invalid reservation transition: <from> -> <to>"` for true invalid edges.

- **FR-005**: Each lifecycle endpoint MUST enforce ownership/role rules via `assertOwner`: `complete` and `cancel` allow owner (`reservation.userId == requestingUserId`) or `Admin`; `expire` (`PATCH /:id/expire`) MUST remain admin-only (`@Auth(UserRoles.Admin)` already applied in `ReservationController`). Non-owner non-admin MUST receive `403 Forbidden` and no state change.

- **FR-006**: Lifecycle mutations MUST use the passed `EntityManager` (`manager.getRepository(Inventory)` / `manager.getRepository(Reservation)` etc.), never the global `DataSource` repository, and MUST be invoked from `ReservationController` inside `dataSource.transaction(manager => service.*(manager, ...))`. The service signature MUST stay compatible: `complete(manager, userId, id, dto?, role?)`, `cancel(manager, userId, id, role?)`, `expire(manager, id)`.

- **FR-007**: Inventory mutations MUST respect DB constraints and derived invariant: `stock >=0`, `reservedAmount >=0`, `reservedAmount <= stock`, `available = stock - reservedAmount` (derived). Any violation (e.g., `reservedAmount - qty < 0`) MUST cause transaction rollback and surface as `409` (or `500` mapped to `409` for invariant violation), not as a silent negative value.

- **FR-008**: Lifecycle operations MUST be safe under concurrent races (completion vs cancellation vs expiration on the same `RESERVED` reservation, or concurrent completions of the same reservation due to retries). Only the first transaction to commit its `RESERVED → X` may succeed; the loser MUST detect that `status != RESERVED` after acquiring the `FOR UPDATE` lock on the reservation row and fail with `409` — except `COMPLETED → COMPLETED` retry which returns `200` idempotent and still does not re-mutate inventory. Inventory MUST be decremented exactly once — the losing path MUST NOT execute `reservedAmount -= qty` or `stock -= qty`.

- **FR-009**: `ReservationItem` quantities are trusted as persisted values, not client-supplied at transition time. `quantity` is `>0` enforced by DB `@Check` and DTO validation at creation; lifecycle code MUST use the items loaded from the locked reservation (`relations: {items: true}`) to decide mutation amounts, not any new client payload (except `orderId` on complete).

- **FR-010**: System MUST have tests proving lifecycle correctness: unit tests (mocked `EntityManager` where appropriate) for `validateTransition`, ownership guard, and invalid-transition rejection; **integration tests against real PostgreSQL** for: (a) `RESERVED→COMPLETED` stock+reserved decrement, (b) `RESERVED→CANCELLED` reserved-only decrement, (c) `RESERVED→EXPIRED` reserved-only decrement + admin-only check, (d) invalid transitions `409`, (e) rollback on missing inventory, (f) concurrent `complete` vs `cancel` → one `200` one `409` and exactly one inventory mutation, (g) idempotent retry (second complete after first `COMPLETED` → `409` and unchanged inventory).

### Key Entities

- **Reservation**: `id`, `userId`, `orderId` nullable, `status` (`RESERVED` initial, then exactly one terminal `COMPLETED`/`CANCELLED`/`EXPIRED`), `expiresAt`, timestamps, `OneToMany` `items`. Row is locked `FOR UPDATE` during any terminal transition.
- **ReservationItem**: `id`, `reservationId`, `inventoryId`, `quantity (>0)`, unique `(reservationId, inventoryId)`. Drives how many units to `+=/-=` on `Inventory`.
- **Inventory**: `id`, `productId` (unique, FK `Product.id` cascade), `stock`, `reservedAmount`, derived `available`. Mutated under `FOR UPDATE` lock during lifecycle transitions. Constraints `stock>=0`, `reservedAmount>=0`, `reservedAmount<=stock`.
- **Order** (read-only in this phase): referenced only to validate `orderId` on `complete` (`orderId` FK `SET NULL`, lookup via `manager.getRepository(Order).findOne`). No order state machine changes in this phase.

---

## 4. Success Criteria

### Measurable Outcomes

- **SC-001**: A `RESERVED` reservation completed by owner/admin atomically results in `R.status=COMPLETED` and for every item `Inventory.stock = before.stock - qty` and `Inventory.reservedAmount = before.reservedAmount - qty` (both decrements equal qty) and the change is visible via `GET /reservations/:id` immediately after the `PATCH .../complete` returns `200` (verified by integration test on real PostgreSQL).

- **SC-002**: A `RESERVED` reservation cancelled by owner yields `R.status=CANCELLED`, `Inventory.stock` unchanged, `Inventory.reservedAmount = before.reservedAmount - qty`, and `available` increased by `qty` (verified by integration test).

- **SC-003**: A `RESERVED` reservation expired by admin yields the same inventory effect as cancellation (`reservedAmount -= qty`, `stock` unchanged) and status `EXPIRED` (verified by integration test).

- **SC-004**: Any attempt to transition a non-`RESERVED` reservation (e.g., `COMPLETED→CANCELLED`, `EXPIRED→COMPLETED`) is rejected with `409` and leaves both reservation status and all inventory rows exactly as before (verified by integration tests for each invalid edge).

- **SC-005**: Under concurrent execution of two terminal transitions on the same `RESERVED` reservation (e.g., `complete` vs `cancel` fired in parallel), exactly one succeeds and one is rejected with `409`, and inventory is mutated exactly once — i.e., after both settle, `reservedAmount` and `stock` reflect a single `qty` decrement, never double (verified by concurrent integration test; no oversell, no double-release).

---

## 5. Assumptions

- **A1**: PostgreSQL is authoritative; Redis/RabbitMQ/BullMQ are not touched inside lifecycle transactions (constitution I). Async events for `ReservationCompleted` etc. are out of scope and will be published post-commit in a later phase (Phase 11), not inside the transition transaction.
- **A2**: `Reservation` and `ReservationItem` entities, `Inventory` constraints, and `ReservationService.create` with `FOR UPDATE` sorted-lock + `available` check already exist (Phases 1-3 DONE). This phase extends `complete`/`cancel`/`expire` (currently status-only stubs in `reservation.service.ts:202-243`) to include inventory effects and proper locking; no new tables or migrations are expected, but a migration is allowed if a new index or constraint is proven needed.
- **A3**: Controller transaction boundary stays `dataSource.transaction(manager => service.*(manager,...))` as in `reservation.controller.ts:65,76,84`; service uses `EntityManager`.
- **A4**: `DEFAULT_TTL_MS = 15 min` and `expiresAt = now + TTL` for creation remain unchanged; expiration in this phase is manual admin operation (`PATCH /:id/expire`). Automated scanning/BullMQ worker is Phase 5 and deliberately out of scope — do not add it here.
- **A5**: Order state machine and payment handling are out of scope (Phases 6-8). For `complete`, `orderId` is optional; if supplied it is only validated for existence, not for order-status lifecycle. No payment provider is invented.
- **A6**: Error mapping: invalid transition → `409 ConflictException`; forbidden (owner check) → `403`; unknown reservation or order/inventory → `404`; validation error → `400`; DB invariant violation surfacing inside transaction → `409` (not `500`).
- **A7**: Pessimistic locking (`FOR UPDATE` / `pessimistic_write`) is the concurrency primitive, consistent with Phase 3 and `AGENTS.md` (§3 Transactions, Database Rules). Deterministic lock ordering is by `inventoryId` ascending (UUID lexicographic) to avoid deadlocks when multiple items are mutated.
- **A8**: `synchronize: false`; tests run against real PostgreSQL for consistency/locking (constitution VII). Concurrency/race tests must use real `DataSource` transactions, not mocks. Unit tests may mock `EntityManager` for transition-guarding logic.
- **A9**: Idempotency beyond single-transition guard (replay with same idempotency key) is Phase 12; for this phase, "idempotent" means a second `complete` on already-`COMPLETED` returns `200` idempotent success with no re-mutation (per 2026-09-14 clarification Q4), while second `cancel` on `CANCELLED` and second `expire` on `EXPIRED` remain `409` (per Q5). All other invalid transitions are `409` and never re-apply inventory.
- **A10**: `reservation.status` and `reservation.expiresAt` are already indexed (`@Index(['status'])`, composite `@Index(['status','expiresAt'])`) for future Phase 5 scanning; no index change required here.

---

## 6. Dependencies

- Phase 1 `Inventory` entity, `InventoryService`, constraints, `InventorySeeder` — DONE.
- Phase 2 `Reservation`/`ReservationItem` entities, `ReservationService`/`ReservationController`, `validateTransition`, `assertOwner`, indexes, migration `1755850000000` — DONE.
- Phase 3 transaction-safe `ReservationService.create` (`FOR UPDATE` sorted inventories, `available` check, atomic `reservedAmount` increment) — DONE.
- `DataSource` / `EntityManager` transactional support and global `ValidationPipe` + `AllExceptionsFilter`.
- `Order` entity (read-only existence check on complete).

---

## 7. Out of Scope (this phase)

- Expiration cleanup worker (scheduled/BullMQ scan for `status=RESERVED AND expiresAt <= NOW()`) — Phase 5.
- Order integration, checkout transaction that creates order+reservation atomically, order status machine, payment success/failure handling — Phases 6-8.
- Redis caching / product cache keys / TTL / invalidation — Phase 9.
- Rate limiting, RabbitMQ/BullMQ async event publishing, idempotency/retry infrastructure beyond the single-transition guard — Phases 10-12.
- Database Optimization broad index/constraint sweep — Phase 13 (this phase may add a minimal lock/transaction optimization but does not redesign the index set).
- New reservation states beyond `RESERVED|COMPLETED|EXPIRED|CANCELLED` or new fields on `Reservation`/`Inventory`.
- Optimistic locking or application-level retries — out; pessimistic `FOR UPDATE` + deterministic ordering is the spec'd mechanism.

---

## 8. Clarifications

### Session 2026-09-14

- Q: Should manual admin expire (PATCH /reservations/:id/expire) be allowed at any time, or only after expiresAt? → A: Immediate admin override — Admin can expire any RESERVED reservation immediately regardless of expiresAt (Phase 4 manual flexibility; Phase 5 worker will enforce expiresAt <= NOW()).
- Q: Should RESERVED -> COMPLETED validate that Inventory.stock >= quantity before decrementing, and what error should be returned if not? → A: No explicit check — Only rely on DB CHECK stock>=0; if stock-qty <0, transaction rolls back via DB constraint (surfaced as 409; DB is the final safety net, no service-level stock>=qty guard).
- Q: When completing a reservation that already has an orderId, should a new orderId in the complete request overwrite, be rejected, or be ignored? → A: Overwrite always — If dto.orderId supplied on complete, always overwrite Reservation.orderId (last write wins) after validating the order exists.
- Q: If a client retries complete on an already COMPLETED reservation (network retry), should the second call return 200 idempotent or 409 Conflict? → A: 200 idempotent success — Second complete on already COMPLETED returns 200 with COMPLETED state and no inventory change (retry-safe; other invalid edges like COMPLETED->CANCELLED remain 409).
- Q: If cancel is retried on already CANCELLED (or expire on EXPIRED), should it be 200 idempotent like complete, or 409? → A: 409 for all terminals — Only COMPLETED retry is idempotent (200); CANCELLED->CANCELLED and EXPIRED->EXPIRED remain 409 Conflict (strict state machine for those terminals).
- None yet — spec derived directly from `docs/plan.md` Phase 4 with no [NEEDS CLARIFICATION] markers beyond this session. Transition effects, allowed edges, and inventory arithmetic are fully specified by `plan.md` §§4.1-4.5 and the constitution (Principle III). `orderId` validation on `complete` remains existence-only; payment-related branching is deferred to Phases 7-8 and not assumed here.

---

## 9. Acceptance Scenarios (for planning)

1. Create → Complete: `stock 10 reserved 3` + `qty 3` → complete → `stock 7 reserved 0`, status `COMPLETED`.
2. Create → Cancel: `stock 10 reserved 5 qty 2` → cancel → `stock 10 reserved 3`, status `CANCELLED`.
3. Create → Expire (admin): same inventory effect as cancel → status `EXPIRED`.
4. Invalid: `COMPLETED → CANCELLED` / `EXPIRED → COMPLETED` / `CANCELLED → COMPLETED` → `409`, no inventory change.
5. Concurrent `complete` vs `cancel` on same `RESERVED` → one `200` one `409`, inventory mutated exactly once.
6. Second `complete` after `COMPLETED` (retry) → `409`, no double `stock -= qty`.
7. `complete` with valid `orderId` → `orderId` set; with missing `orderId` → `404`, rolled back.
8. Transaction rolls back if any inventory row would violate `reservedAmount>=0` / `stock>=0` / `reservedAmount<=stock`.
9. Non-owner non-admin `cancel` → `403`; non-admin `expire` → `403`.
10. Multi-item reservation complete/cancel/expire mutates all related inventories atomically or rolls back all.
