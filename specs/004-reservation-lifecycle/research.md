# Research — Reservation Lifecycle (Phase 4)

**Branch**: `004-reservation-lifecycle` | **Date**: 2026-09-14 | **Spec**: [spec.md](./spec.md) | **Plan**: [plan.md](./plan.md)

All `NEEDS CLARIFICATION` in Technical Context were `none` (stack fully known). Spec Session 2026-09-14 resolved 5 business clarifications (Q1-Q5) that directly shape decisions below. No external technology research required beyond confirming precedent in `reservation.service.ts:create` (Phase 3) and `products.service.ts:updateMany`.

---

## D1 — Row-level pessimistic locking: lock Reservation then Inventories `FOR UPDATE`

- **Decision**: Each lifecycle transition (`complete`/`cancel`/`expire`) acquires `FOR UPDATE` on the `Reservation` row first (via `manager.findOne(Reservation, {where:{id}, lock:{mode:'pessimistic_write'}})` or `find`+lock) then on every referenced `Inventory` row `FOR UPDATE` in the same `EntityManager` transaction.
- **Rationale**: Guarantees the status check (`RESERVED` vs already terminal) is performed on the locked value, serializing concurrent `complete` vs `cancel` vs `expire` on the same reservation to a single winner (FR-008, SC-005). Locking reservation first prevents two transactions from both seeing `RESERVED` before either commits. Mirrors Phase 3 `Inventory` locking but adds the reservation lock as the primary serialization point; keep transaction short per constitution IV.
- **Alternatives considered**: (a) Lock inventories only and check status without lock → rejected: race where two `complete` both see `RESERVED`, both decrement inventory, double-sell. (b) Optimistic locking (`@VersionColumn`) → rejected: constitution mandates pessimistic row-level for inventory; adds retry logic and is not precedent in codebase. (c) Advisory locks → rejected: unnecessary; row locks are sufficient and DB-native.

## D2 — Deterministic ordering of Inventory locks (sorted `inventoryId`)

- **Decision**: When a reservation has multiple items, sort `inventoryIds` lexicographically ascending and `find(Inventory, {where:{id: In(sortedIds)}, lock:{mode:'pessimistic_write'}})` in that order.
- **Rationale**: Prevents deadlocks when two concurrent transitions touch overlapping sets in opposite payload order (same rationale as Phase 3 D2). `Inventory` lock is by `id` collection; Postgres acquires row locks in the order returned by `WHERE id IN (...)`; sorting source `sortedIds` gives a stable acquisition order. Validated by Phase 3 opposite-order concurrency test.
- **Alternatives considered**: (a) No sorting, lock in request order → rejected: opposite-order `{A,B}` vs `{B,A}` can deadlock under `FOR UPDATE`. (b) Order by `createdAt` → rejected: not stable across product creation races; `id` (UUID) sort is deterministic and cheap.

## D3 — Manual admin `expire` is immediate override — no `expiresAt <= NOW()` check (Q1: A)

- **Decision**: `PATCH /reservations/:id/expire` (admin, Phase 4) does **not** enforce `expiresAt <= NOW()`; any `RESERVED` reservation may be expired immediately. The Phase 5 automated worker will be the component that queries `WHERE status='RESERVED' AND expiresAt <= NOW()` and then calls `service.expire(manager,id)` (which itself still only checks `status==RESERVED`).
- **Rationale**: Spec clarification Session 2026-09-14 Q1 answer A: Phase 4 manual flexibility is needed so admin can force-release holds for testing/abuse without waiting 15 min. Keeps Phase 4 operable without the future scanner; Phase 5 decision is isolated and does not retroactively change the service contract for the manual path.
- **Alternatives considered**: (a) B strict check on manual expire → rejected: would make manual expire useless until `expiresAt`, contradicting admin-override intent and forcing tests to manipulate time. (b) Dual-mode service with flag → rejected: adds branch; simpler to keep service agnostic and let worker be the time-gate keeper (D7/D1).

## D4 — No service-level `stock >= qty` guard on `complete` — rely on DB `CHECK` (Q2: A)

- **Decision**: `RESERVED→COMPLETED` does **not** add `if (stock < qty) throw 409`; it directly performs `stock -= qty` and relies on `Inventory` `@Check stock>=0` to cause rollback if violated; the transaction error is mapped to `409 Conflict` per FR-007.
- **Rationale**: Per Q2 A, creation already ensured `reservedAmount <= stock` and `reservedAmount += qty` at reserve time, so at complete time `stock` should be `>= reserved >= qty` invariantly. Any violation indicates a prior bug or external stock mutation; treating it as a DB-consistency failure (rollback + `409`) is correct and avoids duplicating a check that would duplicate `reservedAmount` logic. Aligns with `available` derived invariant and keeps service minimal.
- **Alternatives considered**: (a) B explicit `stock>=qty` → rejected per user selection; would add redundant branching and error message that duplicates the `reservedAmount` path. Still valid defensively but not chosen; DB constraint is the ultimate backstop. (b) Return `500` on constraint → rejected: invariant violation surfacing as `500` would be misleading; FR-007 maps to `409`.

## D5 — `orderId` on `complete` always overwrites (Q3: A)

- **Decision**: If `dto.orderId` is supplied on `complete`, validate `Order` exists (`404` if not), then set `reservation.orderId = dto.orderId` regardless of prior value; persist via transactional repo. If not supplied, leave `orderId` as-is.
- **Rationale**: Q3 A (last write wins) gives the checkout flow flexibility to attach/correct the order late (e.g., order created after reservation). Order existence check is the only guard; order-status lifecycle is out of scope (Assumption A5). Mirrors existing `transition` helper `if (orderId) { repo.findOne ... }` in `reservation.service.ts:264-268`.
- **Alternatives considered**: (a) B reject if different → rejected: would force client to handle `409` for a benign correction; user chose overwrite. (b) C ignore new value → rejected: would silently drop checkout's intended order linkage.

## D6 — Idempotent `COMPLETED→COMPLETED` as `200`, other terminal retries as `409` (Q4: B, Q5: A)

- **Decision**: Second `complete` on already-`COMPLETED` reservation returns `200` idempotent success with current `COMPLETED` entity and **no** re-mutation of `Inventory`. All other invalid edges (`COMPLETED→CANCELLED`, `COMPLETED→EXPIRED`, `CANCELLED→COMPLETED`, `CANCELLED→CANCELLED`, `EXPIRED→COMPLETED`, `EXPIRED→EXPIRED`) remain `409 ConflictException("Invalid reservation transition: RESERVED -> X" or actual from->to)`.
- **Rationale**: Q4 B (retry-safe) acknowledges network retries/double-click on the sale path must not double-decrement `stock`/`reservedAmount` and should be observable as success; Q5 A keeps `CANCELLED`/`EXPIRED` strict because those are not revenue retries and double-release must be prevented idempotently via `409` guard. Implemented by checking `if (reservation.status === ReservationStatus.COMPLETED && to === ReservationStatus.COMPLETED)` early-return `200` (no locks/mutation) before `validateTransition`, or after `FOR UPDATE` lock detecting `COMPLETED` and requested `to==COMPLETED`. Keeps Phase 12 broader idempotency-key work out of scope.
- **Alternatives considered**: (a) All terminal retries `409` → rejected: user chose idempotent success for `COMPLETED` retry. (b) All terminal retries `200` → rejected: user chose strict for `CANCELLED`/`EXPIRED` per Q5 A. (c) Header `X-Idempotent-Replayed` → rejected: not invented per constitution VIII.

## D7 — Error mapping and service `EntityManager` pattern

- **Decision**: Keep controller `dataSource.transaction(manager => service.*(manager,...))` as ownership of boundary; service methods accept `EntityManager` and use `manager.getRepository(...)` exclusively. Map errors: invalid transition `409`, forbidden `403` via `assertOwner`, not found (`Reservation`/`Order`/`Inventory`) `404`, validation `400`, DB `CHECK` violation → `409` (catch `QueryFailedError` and rethrow as `ConflictException` if needed per FR-007).
- **Rationale**: Matches `AGENTS.md` §3 Transactions/`EntityManager` rule and Phase 3 `ReservationService.create(manager,...)` precedent (`plan.md` Tech Context). Controller stays thin; business logic stays in service. Global `AllExceptionsFilter` serializes REST/GraphQL uniformly. Keeps async events out of transaction (Phase 11).
- **Alternatives considered**: (a) Decorator `@Transaction()` → rejected: NestJS `@Transaction` is deprecated and hides manager propagation; explicit `dataSource.transaction` is codebase precedent. (b) Global repo inside service → rejected: would bypass `FOR UPDATE` locks and break atomicity.

## D8 — Keep transaction short; no Redis/RabbitMQ/BullMQ/Email inside

- **Decision**: Lifecycle transaction contains only: (1) lock `Reservation` FOR UPDATE, (2) status/ownership/orderId validation, (3) lock sorted `Inventories` FOR UPDATE, (4) `Inventory` mutation per FR-002/003, (5) `Reservation` status (+ `orderId`) save, (6) commit. Zero external I/O.
- **Rationale**: Constitution I + IV: short lock hold minimizes contention and prevents holding `FOR UPDATE` while waiting on Redis/queue. Async `ReservationCompleted` etc. events will be published post-commit in Phase 11, not inside.
- **Alternatives considered**: Publishing RabbitMQ inside transaction → rejected: async failure would not roll back business transaction (Phase 11 exit criterion); publish after commit only.

## D9 — Testing strategy: real PostgreSQL for consistency/locking

- **Decision**: Unit tests cover `validateTransition`, `assertOwner`, idempotent `COMPLETED` guard, `orderId` overwrite branch, and inventory math branches with mocked `EntityManager`. Integration tests against **real PostgreSQL** (docker, `--runInBand`) cover: `RESERVED→COMPLETED` `stock`+`reserved` decrement, `RESERVED→CANCELLED` `reserved` only decrement, `RESERVED→EXPIRED` `reserved` only decrement + admin-only, invalid transitions `409`, missing inventory `404` rollback, concurrent `complete` vs `cancel` single-winner (`409` loser, inventory mutated once), concurrent `complete` vs `complete` on same `RESERVED` (single-winner, `COMPLETED` idempotent second `200` does not re-mutate), `orderId` overwrite vs `404` rollback.
- **Rationale**: Constitution VII mandates DB-backed tests for transactions/locking; mocks cannot prove `FOR UPDATE` serializes. `--runInBand` avoids parallel Jest workers sharing one DB and polluting inventory IDs (observed in Phase 3 verification: 89/89 with `--runInBand` vs 2 flaky without). Follows `plan.md` Testing rules.
- **Alternatives considered**: SQLite in-memory → rejected: does not support `FOR UPDATE` semantics or enclosing `CHECK` constraints.

## D10 — No new migration / index in Phase 4

- **Decision**: No new table, column, index, or `@Check` in Phase 4; reuse existing `Reservation` (`@Index userId/status/expiresAt/status+expiresAt`), `ReservationItem` (`@Unique reservationId+inventoryId`, `@Check quantity>0`, indexes `reservationId`/`inventoryId`), `Inventory` (`@Unique productId`, `@Check stock>=0/reserved>=0/reserved<=stock`).
- **Rationale**: Lifecycle transitions mutate existing rows; no schema change is needed to support `FOR UPDATE` or status guards. A migration is allowed only if a lock/index is proven missing during implementation; none is anticipated.
- **Alternatives considered**: Adding advisory lock table → rejected: unnecessary complexity.

---

## Risks & Mitigations

| Risk | Mitigation |
|------|------------|
| Holding `Reservation` `FOR UPDATE` too long (multi-item reservation with many inventories) | Keep transaction D8-short; only requested inventories locked; order sortedIds asc |
| `stock - qty < 0` via external stock mutation surfaces as `500` instead of `409` | Catch `QueryFailedError` with `CHK_stock` in `transition` helper and rethrow `ConflictException` |
| `COMPLETED` idempotent path masks business bug where sale is double-triggered | Audit log `Logger` on second `200` idempotent path; no inventory change, so safe; Phase 12 will add `Idempotency-Key` if needed |
| Parallel Jest workers pollute DB across suites | Force `npm run test -- --runInBand` (documented in `quickstart.md`) |
