# ADR 0010: Reservation Lifecycle — Transactional State Transitions with Inventory Sync (Phase 4)

**Date**: 2026-09-14
**Status**: Accepted
**Feature**: 004-reservation-lifecycle (Phase 4)

## Context

Phase 4 must make every reservation lifecycle transition explicit, transactional, and inventory-synchronized (`docs/plan.md` §§4.1-4.5, `specs/004-reservation-lifecycle/spec.md` US1-4, FR-001..010). Phase 2 introduced `Reservation`/`ReservationItem` with status-only stubs (`complete`/`cancel`/`expire` merely flipped `status` without `Inventory` effects). Phase 3 made **creation** atomic (`FOR UPDATE` sorted inventories, `available>=qty`, `reserved+=qty`). The lifecycle must now handle the complementary mutations:

- `RESERVED→COMPLETED`: `stock-=qty` + `reserved-=qty` (sale converts hold to sold)
- `RESERVED→CANCELLED` / `RESERVED→EXPIRED`: `reserved-=qty` only (hold released, stock unchanged)

Five clarification decisions (Session 2026-09-14) constrain the design:
- Q1: manual admin `expire` is an immediate override — no `expiresAt<=NOW()` check (Phase 5 worker will be the time-gate)
- Q2: no service-level `stock>=qty` guard on `complete` — rely on DB `@Check stock>=0` as final safety net → `409`
- Q3: `orderId` on `complete` always overwrites (last write wins) after existence check
- Q4: `COMPLETED→COMPLETED` retry is idempotent `200` (no re-mutation), not `409`
- Q5: `CANCELLED→CANCELLED` and `EXPIRED→EXPIRED` retries remain `409` (only `COMPLETED` is idempotent)

The design must also guarantee single-winner races (`complete` vs `cancel` vs `expire` concurrently on same `RESERVED` → one `200` one `409`, inventory mutated once) and remain `synchronize:false` with no new tables (D10).

## Decision

- **Transactional helper**: Introduce private `transitionWithInventoryInternal(manager, requestingUserId, id, to, orderId, role, checkOwner)` in `src/modules/reservation/reservation.service.ts`. All three public methods delegate to it:
  - `complete(manager,userId,id,dto,role)` → `transitionWithInventory(manager,userId,id,COMPLETED,orderId,role)`
  - `cancel(manager,userId,id,role)` → `transitionWithInventory(...,CANCELLED)`
  - `expire(manager,id)` → `transitionWithInventoryExpire(manager,id)` → internal with `checkOwner=false` (admin-only at controller, worker bypasses Auth)
  - Legacy `transition()` kept as thin alias to `transitionWithInventory` for backward compat.

- **Locking order (D1/D2)**: Inside the helper, in the same `EntityManager` transaction (controller owns `dataSource.transaction`):
  1. `reservationRepo.findOne({where:{id}, lock:{mode:'pessimistic_write'}})` — lock `Reservation` row first (without `relations` to avoid `FOR UPDATE cannot be applied to nullable side of outer join`; then load with `relations:{items:true}` without lock — the `FOR UPDATE` is held for the tx duration).
  2. `assertOwner` (if `checkOwner`) → `403`
  3. Early idempotent `COMPLETED→COMPLETED` check (Q4) → `200` with optional `orderId` overwrite (Q3) and no inventory mutation, `Logger` audit.
  4. `validateTransition(from, to)` → `409` for all invalid edges (except the idempotent carve-out); `ALLOWED_TRANSITIONS` remains `{RESERVED:[COMPLETED,EXPIRED,CANCELLED]}`.
  5. If `orderId` supplied, `manager.getRepository(Order).findOne` → `404` if missing else `reservation.orderId = orderId` (overwrite per Q3).
  6. `sortedIds = [...new Set(items.map(i=>i.inventoryId))].sort()` then `manager.find(Inventory, {where:{id:In(sortedIds)}, lock:{mode:'pessimistic_write'}})` — deterministic ordering prevents deadlocks on multi-item reservations (same as Phase 3). Missing → `404`.
  7. Per item: `COMPLETED` `stock-=qty` + `reserved-=qty`; `CANCELLED`/`EXPIRED` `reserved-=qty` only; `inventoryRepo.save(inv)` inside tx. No explicit `stock>=qty` check per Q2 — DB `@Check` is final guard.
  8. `reservation.status = to; reservationRepo.save` → `Logger` `from -> to (inventory updated)` → return `reservationRepo.findOne({where:{id:saved.id}, relations:{items:true}})`.

- **Error mapping (D7)**: Catch `QueryFailedError` with `CHK_`/`check constraint`/`code 23514` inside inventory loop and rethrow as `ConflictException 409` (FR-007). Other errors propagate. Invalid transition `409`, forbidden `403`, not found `404`, validation `400` remain via Nest exceptions + `AllExceptionsFilter`.

- **No external I/O (D8)**: Transaction contains only lock→check→mutate→save; no Redis/RabbitMQ/BullMQ/email. Async events deferred to Phase 11 post-commit.

- **No DDL (D10)**: Reuse existing `Reservation`/`ReservationItem`/`Inventory`/`Order` entities, indexes (`status`, `expiresAt`, composite `status+expiresAt`), `CHECK`s, `UNIQUE`s. `synchronize:false`.

- **Idempotency carve-out (D6)**: `COMPLETED→COMPLETED` `200` without inventory re-mutation; `CANCELLED→CANCELLED` and `EXPIRED→EXPIRED` remain `409` per Q5. Other `COMPLETED→CANCELLED/EXPIRED` etc. remain `409`.

- **Controller**: Unchanged shape — `ReservationController` already wraps each write in `dataSource.transaction(manager=>service.*(manager,...))`; `complete`/`cancel` keep `@Auth(User,Admin)` + `CurrentUser` + `assertOwner`; `expire` keeps `@Auth(Admin)`. Service signature stays `complete(manager,userId,id,dto?,role?)`, `cancel(manager,userId,id,role?)`, `expire(manager,id)`.

- **Testing (D9)**: Unit `reservation.service.spec.ts` (33 tests) now covers `complete` success + `stock`/`reserved` math, `orderId` overwrite/`404`, idempotent `COMPLETED→COMPLETED`, `cancel`/`expire` guards, `validateTransition` matrix, ownership. Integration `reservation.integration.spec.ts` (real PG, `--runInBand`) covers `RESERVED→COMPLETED` multi-item atomic, idempotent retry `200`, `orderId` overwrite/`404`, `RESERVED→CANCELLED` `reserved` only, `RESERVED→EXPIRED` immediate override even with future `expiresAt`, invalid edges `409`, rollback on missing inventory, concurrent `complete` vs `cancel` single-winner, `CHECK` backstop. Manual `verify-phase4-simple.ts` exercises complete/cancel/expire/concurrent/orderId flows. All 89 tests pass (`--runInBand`), `build` and `lint` (0 errors) green.

## Consequences

**Positive**
- Single-winner guarantee for lifecycle races via `FOR UPDATE` Reservation-first ordering; deterministic Inventory ordering prevents deadlocks.
- Inventory correctly synchronized: sale converts hold to sold, cancellation/expiration releases hold without touching stock; `available = stock - reserved` stays consistent.
- Clarified business semantics (Q1-Q5) are now code-enforced and tested, unblocking Phase 5 worker (which can reuse `service.expire(manager,id)` as time-gated caller).
- No new infra or migrations; modular monolith preserved (constitution II).

**Negative / Trade-offs**
- Two `reservationRepo.findOne` round-trips (lock without relations + load with relations) add one extra query per transition vs single `findOne` with join — accepted to avoid `FOR UPDATE` + outer join error and keep lock held.
- No service-level `stock>=qty` guard means external stock mutations that cause `stock-qty<0` surface as `409` via `CHECK` rather than a precise `stock insufficient` message — acceptable per Q2; DB is final safety net.

**Alternatives considered**
- Lock `Reservation` with `relations` + `FOR UPDATE` in one query — rejected: Postgres error `FOR UPDATE cannot be applied to nullable side of outer join`.
- Optimistic locking (`@VersionColumn`) — rejected: constitution IV mandates pessimistic row-level for inventory.
- Separate `ReservationLifecycleService` — rejected: single service with `EntityManager` param is simpler and preserves Phase 2 `transition()` contract.
- Service-level `stock>=qty` pre-check — rejected per Q2 A: DB `CHECK` is sufficient.

## Related

- Spec: `specs/004-reservation-lifecycle/spec.md` (US1-4, FR-001..010, SC-001..005, Q1-Q5)
- Plan: `specs/004-reservation-lifecycle/plan.md`, `research.md` D1-D10, `data-model.md`, `contracts/reservation-lifecycle-api.md`, `quickstart.md`
- Tasks: `specs/004-reservation-lifecycle/tasks.md` (41 tasks, T015/T021/T026 core)
- Code: `src/modules/reservation/reservation.service.ts` (`transitionWithInventoryInternal`), `reservation.controller.ts`, `src/modules/inventory/entities/inventory.entity.ts`
- Prior ADRs: `0009-reservation-entity-manager` (Phase 2 manager pattern), `0007-inventory-reservation` (domain separation)
