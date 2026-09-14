# Research: Transaction-Safe Reservation (Phase 3)

**Feature**: `003-transaction-safe-reservation` | **Date**: 2026-08-30 | **Spec**: [spec.md](./spec.md)

Phase 3 adds pessimistic row-level locking + atomic `reservedAmount` mutation to the existing Phase 2 reservation scaffolding. No new tables, no new infrastructure, no new states — only correctness under concurrency.

## 1. Unknowns Extracted from Technical Context

No `NEEDS CLARIFICATION` markers in `spec.md` (clarify phase reported 0 critical ambiguities). All required behaviors are pinned by `docs/plan.md` §§3.1-3.4, the constitution (IV), and existing precedent `products.service.ts:updateMany`. Research therefore validates prescribed choices rather than resolving unknowns.

## 2. Decisions

### D1 — Concurrency primitive: pessimistic `FOR UPDATE` (TypeORM `pessimistic_write`)

- **Decision**: Use PostgreSQL `SELECT ... FOR UPDATE` via TypeORM `lock: { mode: 'pessimistic_write' }` on every `Inventory` row referenced by the request, inside the same `EntityManager` transaction that checks `available` and increments `reservedAmount`.
- **Rationale**: Matches constitution IV and `docs/plan.md` §3.2 verbatim; already proven in `src/modules/products/products.service.ts:225` (`updateMany` acquires `pessimistic_write` on `Product` rows inside `dataSource.transaction`). Keeps the authoritative path `PostgreSQL transaction → Inventory row → Reservation` (constitution I). No application-level optimistic version column needed; avoids retry loops and ABA risks.
- **Alternatives considered**:
  - Optimistic locking (`@VersionColumn` + retry) — rejected: requires version column migration, retry policy, and still leaks oversell window between read and write; `plan.md` explicitly prescribes pessimistic.
  - Advisory locks / Redis distributed locks — rejected: violates constitution I (Redis not authoritative) and adds infrastructure without DB guarantee.
  - `SERIALIZABLE` isolation alone — rejected: heavier, more serialization failures, still needs explicit row locking for deterministic behavior.

### D2 — Deterministic lock ordering: lexicographic `inventoryId` sort

- **Decision**: Before acquiring locks, collect distinct `inventoryId`s from the request, sort them lexicographically (UUID string ascending), then fetch/lock rows in that order via `manager.find(Inventory, { where: { id: In(sortedIds) }, lock: { mode: 'pessimistic_write' } })` or per-id ordered `findOne` with `FOR UPDATE`. Enforce ordering in code and document it.
- **Rationale**: Required by `spec.md` FR-003 and `docs/plan.md` §3.2 to prevent deadlocks when concurrent reservations touch overlapping sets in different payload orders (e.g., `{A,B}` vs `{B,A}`). Lexicographic UUID sort is stable, cheap, and consistent with existing deterministic patterns; alternative numeric ordering identical effect. Tested by SC-004 (opposite-order concurrency test).
- **Alternatives considered**:
  - No ordering (acquire in payload order) — rejected: creates unnecessary deadlock risk (explicitly forbidden by plan).
  - Ordering by DB `id` numeric internal — not applicable (UUID PK); string sort is canonical.
  - Single bulk `SELECT ... FOR UPDATE` without ordering guarantee — still needs application-level sort; DB does not guarantee lock acquisition order across concurrent transactions.

### D3 — Availability check location: inside locked transaction on derived `available`

- **Decision**: Read `stock` and `reservedAmount` from the locked `Inventory` rows, compute `available = stock - reservedAmount` in memory (via entity getter `available`), and reject with `409 ConflictException` if any `available < requestedQuantity`. Never trust client-supplied `available`.
- **Rationale**: Spec FR-004 and `docs/plan.md` §3.3 define `available` as derived; checking after `FOR UPDATE` ensures the second concurrent transaction re-reads the updated `reservedAmount` and correctly fails (covers the `stock=10, reserved=8, both request 2` case). Constitution I forbids cache-derived decisions.
- **Alternatives considered**:
  - Check before locking (read-then-lock) — rejected: race window allows both to pass.
  - Check via SQL `WHERE stock - reservedAmount >= $qty` in `UPDATE` — equivalent but less explicit; entity-level check keeps DB `CHECK` as safety net and preserves existing `Inventory.available` getter pattern.

### D4 — Transaction boundary ownership: controller-owned `dataSource.transaction`, service uses passed `EntityManager`

- **Decision**: Keep existing contract `ReservationService.create(manager, requestingUserId, dto)` (Phase 2 clarification) and have `ReservationController.create` wrap it in `dataSource.transaction(manager => service.create(...))`. All reads/writes inside `create` use `manager.getRepository(...)`, never global repositories.
- **Rationale**: Established in Phase 2 and preserved by spec FR-006/A4; aligns with `products.service.ts:updateMany` and `inventory.service.ts:decreaseStockForOrderMany(manager, ...)` pattern where caller owns the transaction and callee operates via `EntityManager`. Keeps transaction short and avoids nested transactions.
- **Alternatives considered**:
  - Service owns transaction internally — rejected: would break composability with future checkout (Phase 6) that may need to reserve + create order in one transaction.
  - Using global `inventoryRepo` inside transaction — rejected: bypasses locking and snapshot isolation.

### D5 — `reservedAmount` mutation: save through locked entity via `EntityManager`

- **Decision**: Increment `lockedInventory.reservedAmount += quantity` on the locked entity and persist via `manager.save(Inventory, lockedRow)` (or `manager.increment` on the locked row). DB `CHECK` constraints (`stock >=0`, `reservedAmount >=0`, `reservedAmount <= stock`) remain the backstop; any violation rolls back and surfaces as `409` (mapped from `QueryFailedError` if needed, but normally caught by the `available` pre-check).
- **Rationale**: Spec FR-007; keeps ORM entity lifecycle, matches `InventoryService.reserve` logic but now transactional. Avoids raw SQL; keeps constraints enforced.
- **Alternatives considered**:
  - Raw `UPDATE inventory SET reserved_amount = reserved_amount + $qty` with `RETURNING` — valid but less consistent with existing TypeORM patterns; not needed for correctness.
  - `InventoryService.reserve` call inside transaction — rejected in this phase because `InventoryService.reserve` uses global repo; the transactional path must use the locked manager directly. A future refactor can expose `reserveWithManager(manager, ...)`.

### D6 — Error mapping

- **Decision**: `available < requested` → `ConflictException(409)` with message `Insufficient available inventory for ${inventoryId}. Available: ${available}, requested: ${quantity}`; unknown `inventoryId` → `NotFoundException(404)`; duplicate `inventoryId` in request → `BadRequestException(400)`; DB `CHECK` violation bubbled as `ConflictException` (409) rather than 500.
- **Rationale**: Spec FR-008/A7 and `docs/api/conventions.md` error-code table; matches existing `InventoryService.reserve` messages for consistency.

### D7 — Transaction scope and exclusions

- **Decision**: Transaction contains only: `future expiresAt` validation, duplicate check, sorted lock acquisition, `orderId` FK existence check (if supplied), availability check, `reservedAmount` increments, `Reservation` + `ReservationItem` inserts. No Redis, RabbitMQ, BullMQ, email, or other external I/O inside. Only requested `Inventory` rows are locked (FR-005).
- **Rationale**: Constitution I and spec assumptions A1/A10; keeps transaction short (constitution IV) and avoids holding row locks while waiting on network I/O.

### D8 — Tests: real PostgreSQL for concurrency, deterministic ordering verification

- **Decision**: Unit test the sorted-lock-and-check path with a mocked `EntityManager`; integration/concurrency tests run against real PostgreSQL (docker) with parallel `Promise.all` or `Promise.allSettled` over two `dataSource.transaction`-wrapped `create` calls sharing the same inventory.
- **Rationale**: Constitution VII mandates DB-backed tests for consistency/locking; mocking the DB would not prove `FOR UPDATE` semantics. SC-003/FR-010 require the exact `stock=10, reserved=8, qty=2 vs qty=2` test and an opposite-order deadlock-avoidance test (SC-004).

## 3. Best-Practice References Verified

- `src/modules/products/products.service.ts:updateMany` — pessimistic_write pattern inside `dataSource.transaction`, `In()` bulk fetch, `manager.save` pattern — reuse directly.
- `src/modules/inventory/entities/inventory.entity.ts` — `stock`/`reservedAmount` + `CHECK` + `available` getter — read via locked row, increment via manager.
- `src/modules/reservation/reservation.service.ts:46-113` — current non-transactional `create` (validations, FK checks, duplicate detection) — augment with locking/availability/mutation without changing signature.
- `src/modules/reservation/reservation.controller.ts:24-30` — transaction wrapping precedent — keep unchanged.
- TypeORM `pessimistic_write` docs: lock option only valid inside a transaction; must use `DataSource#transaction` / `EntityManager`.

## 4. Risks & Mitigations

- **Long transactions holding many locks** (many items per reservation) → Mitigated by FR-005 (only requested rows, short tx, no I/O); future phase may cap `items.length` if needed (deferred; not required for correctness).
- **Lock wait / statement timeout** under contention → PostgreSQL defaults are adequate for Phase 3; no custom `lock_timeout` needed yet. Deadlocks eliminated by deterministic ordering; contention serializes via `FOR UPDATE` queue.
- **Partial state on failure** → Mitigated by single transaction rollback; verified by SC-005 rollback assertions.

## 5. Outcome

All decisions align with `spec.md`, `docs/plan.md` Phase 3, and the constitution. No NEEDS CLARIFICATION remains. Proceed to Phase 1 design.
