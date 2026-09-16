# Feature Specification: Reservation Expiration Cleanup

**Feature Branch**: `006-reservation-expiration-cleanup`  
**Created**: 2026-09-16  
**Status**: Draft  
**Input**: User description: "start the next ready phase"  
**Source**: `docs/plan.md` Phase 5 — Reservation Expiration / Cleanup (§§5.1-5.4), Phase 4 lifecycle completion (2026-09-14), `docs/architecture/inventory-reservation.md`, constitution I/IV/VII

---

## 1. Overview

Phases 1-4 established inventory (`stock`, `reservedAmount`, `available = stock - reservedAmount`, CHECK constraints) and reservation (`Reservation` + `ReservationItem`, status `RESERVED|COMPLETED|EXPIRED|CANCELLED`, `validateTransition`, `assertOwner`) with transaction-safe creation (`FOR UPDATE` sorted inventories, `available` check) and lifecycle transitions (`RESERVED→COMPLETED` `stock-=qty` `reserved-=qty`; `RESERVED→CANCELLED/EXPIRED` `reserved-=qty` only; `FOR UPDATE` Reservation-first + sorted Inventories; single-winner races; idempotent `COMPLETED→COMPLETED` `200`).

Manual `PATCH /reservations/:id/expire` (admin-only, immediate override without checking `expiresAt`) is done, but there is **no automated worker** that discovers reservations whose clock has elapsed. Held inventory therefore never returns to `available` without admin action — the primary Phase 5 gap.

This feature introduces a **background expiration worker** that periodically scans `status = RESERVED AND expiresAt <= NOW()` using the existing composite index `IDX_reservation_status_expiresAt`, and for each candidate executes the same transactional lifecycle path as manual expiration: `FOR UPDATE` reservation → verify still `RESERVED` → `FOR UPDATE` sorted inventories → `reservedAmount -= qty` → `status = EXPIRED`. The authoritative expiration rule remains the DB field (`expiresAt <= NOW()`), not the worker's schedule; the worker only discovers and processes.

The feature must be safe against all concurrent races documented in `docs/plan.md` §5.3: cleanup + checkout completion + cancellation happening at the same instant on the same `RESERVED` reservation. Exactly one transition must win; the loser must detect `status != RESERVED` after acquiring the row lock and fail without double-release. Idempotency: reprocessing an already-`EXPIRED` reservation must never subtract `reservedAmount` a second time. The job infrastructure choice (BullMQ vs NestJS scheduler vs existing mechanism) is a **design decision for `plan.md`** — the spec requires a scheduled/background mechanism but does not prescribe the library; any choice must keep transactions short, avoid Redis/RabbitMQ I/O inside the transaction, and publish events only after commit.

### Goal

Expired reservations eventually release inventory and concurrent expiration/completion/cancellation cannot corrupt inventory. — `docs/plan.md` Phase 5 Exit Criteria.

---

## 2. User Scenarios & Testing

### User Story 1 — Expired reservations automatically release inventory (Priority: P1)

A shopper creates a `RESERVED` reservation (`expiresAt = now + 15m` default). Time passes beyond `expiresAt`. The background worker eventually processes the reservation without human intervention: `reservedAmount` is released and `status` becomes `EXPIRED`, making the units available for other shoppers.

**Why this priority**: This is the Phase 5 exit criterion itself. Without it, abandoned holds leak `reservedAmount` forever; manual admin expiration does not scale.

**Independent Test**: Create `RESERVED` reservation `qty 2` on `A (stock=10, reserved=2, available=8)` with `expiresAt = now - 1m` (already expired at creation via direct insert or past TTL), wait for worker tick (interval configurable, e.g., 30s-60s) or invoke worker service directly `expirationService.processExpiredBatch({limit: 10})`, assert `R.status=EXPIRED`, `A.reservedAmount=0`, `A.stock=10`, `A.available=10`, and subsequent `GET /reservations/:id` reflects `EXPIRED`.

**Acceptance Scenarios**:

1. **Given** R `RESERVED` with `expiresAt = NOW() - 5m` and items `[{A qty 2}]` where `A` is `stock=10, reserved=2`, **When** the cleanup worker runs its scan `WHERE status='RESERVED' AND expiresAt <= NOW()` and processes the candidate, **Then** `R.status=EXPIRED`, `A.reservedAmount=0`, `A.stock=10`, and the worker reports `expiredCount = 1`.
2. **Given** R `RESERVED` with `expiresAt = NOW() + 10m` (not yet expired), **When** the worker scans, **Then** R is not selected, `status` stays `RESERVED`, and inventory is unchanged.
3. **Given** three reservations R1 `expiresAt = NOW() - 10m`, R2 `expiresAt = NOW() - 2m`, R3 `expiresAt = NOW() + 5m`, all `RESERVED`, **When** worker runs with `batchSize = 10`, **Then** R1 and R2 become `EXPIRED` and release inventory, R3 remains `RESERVED` (proves `expiresAt <= NOW()` filtering, not just `status`).
4. **Given** a reservation with multiple items `A qty 1 + B qty 2` (`A stock=10 reserved=1`, `B stock=5 reserved=2`) and `expiresAt` in the past, **When** expiration cleanup processes it, **Then** both inventories are decremented atomically (`A.reserved=0, B.reserved=0`) or the whole operation rolls back; no partial release.

---

### User Story 2 — Cleanup race: single winner vs checkout/cancellation (Priority: P1)

Completion, cancellation, and automated expiration may arrive simultaneously on the same `RESERVED` reservation. Only one must win and inventory must be mutated exactly once.

**Why this priority**: Constitution IV (no overselling) and Phase 4 SC-005 already prove single-winner for manual transitions; Phase 5 must preserve the same guarantee when the worker is the third contender. Double-release would create phantom `available`.

**Independent Test**: Create `RESERVED` `qty 2` with `expiresAt = NOW() - 1m` (expired, so worker would process) but fire `PATCH /:id/complete` and `PATCH /:id/cancel` and `worker.processOne(R)` in parallel via `Promise.all` inside real `DataSource` transactions (`--runInBand`, real PostgreSQL), assert exactly one succeeds (`200` or worker `EXPIRED`) and the other two get `409`, and after settlement `reservedAmount`/`stock` reflect a single `qty` mutation.

**Acceptance Scenarios**:

1. **Given** R `RESERVED` `qty 2` (`stock=10, reserved=2`) with `expiresAt` in the past, **When** the worker attempts `RESERVED→EXPIRED` concurrently with owner calling `PATCH /:id/complete`, **Then** exactly one succeeds (either `EXPIRED` with `reserved-=2, stock unchanged` or `COMPLETED` with `reserved-=2, stock-=2`) and the loser receives `409 Invalid transition` and performs no second inventory mutation.
2. **Given** R `RESERVED` `qty 2` with future `expiresAt`, **When** worker and `PATCH /:id/complete` race, **Then** worker finds no candidate (not yet expired) or skips R, and `complete` wins (`COMPLETED`) or fails on its own validation — worker never forcibly expires a not-yet-expired reservation.
3. **Given** two cleanup workers (or repeated scheduler ticks) race on the same expired R, **When** both scan and attempt to expire, **Then** exactly one transitions `RESERVED→EXPIRED` and releases `reservedAmount` once; the second detects `status != RESERVED` after `FOR UPDATE` and does nothing (idempotent, no double-release).
4. **Given** R `RESERVED` with `expiresAt` past but already `COMPLETED` by a just-committed checkout, **When** worker processes the batch, **Then** it skips R (status check inside locked transaction) and inventory is unchanged beyond the completed sale.

---

### User Story 3 — Batch scanning, scheduling, and observability (Priority: P2)

An operator (or test) can observe that the worker runs periodically, respects batching to keep transactions short, handles empty scans without error, and logs/metrics failures without leaking inventory state.

**Why this priority**: Phase 5 §5.4 asks to use existing background-job infrastructure and not introduce infra without reason. P2 because scanning correctness is P1, but operational concerns (interval, batch size, error handling) determine production stability.

**Independent Test**: Start the NestJS app with a short schedule interval (e.g., `EXPIRATION_INTERVAL_MS=5000`) and `EXPIRATION_BATCH_SIZE=10`, create 25 expired `RESERVED` reservations across 5 inventories, wait for 2-3 ticks, assert all 25 become `EXPIRED` across multiple batches, `reservedAmount` for each inventory returns to baseline, and logs contain `reservation expiration: scanned X expired Y` without `500` errors. Stop Redis/RabbitMQ and verify scanning still succeeds (no infra dependency inside transaction).

**Acceptance Scenarios**:

1. **Given** 25 expired `RESERVED` reservations and `batchSize=10`, **When** the worker runs one batch (`processExpiredBatch(limit=10)`), **Then** at most 10 reservations are transitioned per batch invocation and a subsequent invocation processes the next 10 (or all if loop `until empty`), proving paging with deterministic ordering (`expiresAt ASC, id ASC` or `createdAt` tie-break) and composite index usage `EXPLAIN` shows `Index Scan` on `IX_reservation_status_expiresAt`.
2. **Given** the worker is configured with interval `PT30S` (configurable via env `EXPIRATION_INTERVAL_MS` or Cron expression), **When** the app is running and no reservations are expired, **Then** each tick logs/skips cleanly (`0 expired`) and no transaction is held open; errors in one batch (e.g., one reservation's inventory row missing) do not abort the entire batch — per-reservation errors are caught, logged, and the remaining candidates continue.
3. **Given** an expired R with one missing/deleted inventory row (FK set but row removed via concurrent test), **When** expiration is attempted, **Then** that single expiration rolls back (`404`/`409` logged) and other Rs in the same batch still expire correctly (no batch-wide rollback).
4. **Given** the application admin wishes to tune the worker, **When** they set `EXPIRATION_ENABLED=false` (or interval `0`), **Then** the periodic job does not schedule ticks, but manual `POST /reservations/:id/expire` (admin override) remains available per Phase 4.

---

### Edge Cases

- What happens when the worker scan returns 0 rows? → The tick completes with `0 expired`, no transaction opened beyond the initial `SELECT`, no log spam above `debug`.
- What happens when `expiresAt` equals `NOW()` exactly (boundary)? → `expiresAt <= NOW()` evaluates true; reservation is eligible (PostgreSQL `timestamptz` comparison, inclusive). Worker must use `<= NOW()` not `< NOW()`.
- What happens when a reservation `expiresAt` is in the past but status is already `EXPIRED`/`CANCELLED`/`COMPLETED`? → Not selected (`status=RESERVED` predicate filters it out); if selected before status change, the locked-transaction status check skips mutation and returns without inventory change.
- What happens when an expired reservation has 0 items (data anomaly)? → Expiration still marks `EXPIRED` without inventory mutation; invariant holds; log warning.
- What happens when `reservedAmount < quantity` at expiration time due to earlier corruption or manual DB edit? → The transition `reservedAmount -= qty` would violate `CHECK reservedAmount>=0`; transaction rolls back, logs `warn`/`error` with `reservationId`, and is retried up to `EXPIRATION_MAX_RETRIES` (default `3`) on subsequent ticks; after N failures the poison is skipped (remains `RESERVED` but excluded from auto-retry until manual fix). No negative `reservedAmount` is persisted; batch continues. Every retry is logged.
- What happens when the worker crashes mid-batch (process killed after releasing one reservation but before committing the next)? → Already-committed expirations remain; unprocessed expired reservations remain `RESERVED` and will be retried on next tick (at-least-once, idempotent via status guard — no double-release on retry).
- What happens when the worker runs inside a deployment with two app replicas? → BullMQ singleton repeat job (`jobId` + `concurrency:1`, clarified option B) ensures only one replica enqueues the tick; if singleton is bypassed or replicas race, `FOR UPDATE` on the reservation row remains the authoritative single-winner mechanism: first commits `EXPIRED`, second sees `status != RESERVED` and skips. No Redis advisory lock beyond BullMQ singleton is required.
- What happens when the transaction takes longer than the next tick? → Ticks must not overlap: use singleton job locking or skip if previous batch still running (`@Cron` with `waitForCompletion` / BullMQ concurrency 1).
- How does manual admin `PATCH /:id/expire` interact with the worker's `expiresAt <= NOW()` guard? → Manual expire remains an **immediate override** per Phase 4 clarification — it does **not** check `expiresAt`. Only the worker's batch scan filters by `expiresAt <= NOW()`. The two paths reuse the same internal `transitionWithInventory` helper but with different preconditions (worker: scan filter + status guard; manual: direct `RESERVED` + admin role).
- What happens when `GET /reservations/:id` is called during worker processing? → Reads may see `RESERVED` before commit and `EXPIRED` after commit; no stale cache is authoritative (Redis not used for reservation truth, per constitution I).
- What happens when `Inventory` constraint `reservedAmount <= stock` would be violated after release? → Release (`reserved-=qty`) only decreases `reservedAmount`, so it cannot violate `reserved<=stock`; it moves away from the boundary. No check needed beyond `reserved>=0`.

---

## 3. Requirements

### Functional Requirements

- **FR-001**: System MUST define the authoritative expiration rule as `expiresAt <= NOW()` (`timestamptz` comparison, inclusive). The database field determines expiry; the cleanup worker only **discovers** and processes candidates. The scan query MUST be `WHERE status = 'RESERVED' AND expiresAt <= NOW()` ordered deterministically (`expiresAt ASC, id ASC` or `createdAt ASC`) with `LIMIT :batchSize`, and MUST be able to use the existing composite index `IDX_reservation_status_expiresAt` (`status, expiresAt`). No cache or in-memory clock drives the eligibility decision.

- **FR-002**: System MUST provide a BullMQ-based background mechanism (clarified 2026-09-16, option B) that periodically discovers expired candidates and processes them. The BullMQ queue (`reservation-expiration` queue, repeat/cron) with `ReservationExpirationProcessor` (`@Processor`) MUST: (a) interval configurable via env (`EXPIRATION_INTERVAL_MS` or `EXPIRATION_CRON`/`BULLMQ_REPEAT`, default repeat every `30s` to meet **60s SLA** after `expiresAt` — interval may be tuned 15s-60s but MUST guarantee expiry within 60s; `EXPIRATION_BATCH_SIZE` default `10-100`), (b) `EXPIRATION_ENABLED` flag to disable scheduling without disabling manual `PATCH /:id/expire`, (c) guarantee non-overlapping ticks via BullMQ `concurrency:1` + `jobId` singleton (or `repeat` singleton + `FOR UPDATE` still guards correctness), (d) not introduce a separate daemon beyond the existing NestJS BullMQ worker.

- **FR-003**: For each candidate reservation, the expiration MUST execute inside a **single database transaction** that:
  1. `SELECT ... FOR UPDATE` the `Reservation` row (`pessimistic_write`) by `id`,
  2. verifies `status === RESERVED` after the lock — if not `RESERVED`, skip with no inventory mutation and treat as idempotent no-op (do not throw double-release),
  3. loads `ReservationItem`s for the reservation (`relations` or `manager.find`), verifies every `inventoryId` still exists,
  4. `SELECT ... FOR UPDATE` every referenced `Inventory` row in **deterministic sorted order** (`inventoryId` lexicographic ascending, `sortedIds = [...new Set(ids)].sort()`), same as Phase 3/4,
  5. for each item: `inventory.reservedAmount -= quantity` (stock unchanged) via `EntityManager`,
  6. updates `Reservation.status = EXPIRED` (`expiresAt` unchanged, `updatedAt` auto),
  7. commits; any failure rolls back entirely — no partial `reservedAmount`/`status` persistence.
  The transaction MUST NOT contain Redis, RabbitMQ, or `WhatsAppProvider` I/O; after each successful commit the worker MUST publish a RabbitMQ event `reservation.expired` (clarified 2026-09-16, option C) with `{reservationId, userId, expiredAt, inventoryIds[]}` — publish failures are logged at `error` but MUST NOT roll back the already-committed `EXPIRED` state, per constitution async pattern. Multi-replica safety is guaranteed by BullMQ singleton (`jobId` + `concurrency:1`, option B) as efficiency layer; `FOR UPDATE` row locking remains the authoritative correctness guard if singleton is bypassed.

- **FR-004**: Manual admin expiration `PATCH /reservations/:id/expire` MUST remain an **immediate admin override** that does **not** enforce `expiresAt <= NOW()` (Phase 4 clarification). The automated worker's batch scan **does** enforce `expiresAt <= NOW()`. Both paths MUST reuse the same internal transactional helper (`transitionWithInventoryInternal` or `expireWithInventory`) so inventory effects are identical (`reservedAmount -= qty` only), and both MUST remain `admin-only` for manual (`@Auth(UserRoles.Admin)`) while the worker service method is internal (no HTTP auth guard).

- **FR-005**: All state transitions in this phase remain guarded by `validateTransition`: only `RESERVED → EXPIRED` (via worker or manual) is processed here. Any attempt to expire a reservation not in `RESERVED` (already `EXPIRED`/`COMPLETED`/`CANCELLED`) MUST be rejected or skipped without inventory mutation: worker path skips idempotently (log `debug` "skip non-RESERVED"), manual path throws `409 ConflictException "Invalid reservation transition: <from> -> EXPIRED"` per Phase 4 FR-004. Reprocessing an already-`EXPIRED` reservation MUST never subtract `reservedAmount` a second time. DB `CHECK` (`reservedAmount>=0`, `stock>=0`, `reservedAmount<=stock`) is the final backstop; violating `reservedAmount - qty < 0` rolls back and is logged as error.

- **FR-006**: System MUST be safe under concurrent races among any combination of: automated expiration worker, `PATCH /:id/complete`, `PATCH /:id/cancel`, manual `PATCH /:id/expire`, and parallel worker ticks/replicas. Correctness MUST be achieved via **row-level `FOR UPDATE` locking** on `Reservation` first, then sorted `Inventory` rows. The first committer wins; the loser MUST detect `status != RESERVED` after acquiring the lock and fail/skip with `409` (for HTTP paths) or idempotent skip (for worker), without a second `reservedAmount` decrement. Single-winner is verified under real PostgreSQL concurrency, not mocked.

- **FR-007**: System MUST support batch processing. A single worker tick processes at most `batchSize` expired reservations, ordered deterministically. The tick MUST handle partial failure per-reservation: if one candidate fails (missing inventory, DB CHECK violation, concurrent winner), the tick logs the failure at `warn`/`error` with `reservationId` and continues to the next candidate; the batch tick as a whole does not roll back. For poison failures (CHECK violation / missing Inventory), the worker MUST retry up to `EXPIRATION_MAX_RETRIES` (default `3`, configurable via env, clarified 2026-09-16 custom) — log every retry — and after N failures skip the poison candidate (leave `RESERVED` but excluded from further automatic retries until manual intervention or data fix). Optionally the service exposes `processExpiredBatch(limit)` that returns `{ scanned, expired, skipped, failed, retried }`.

- **FR-008**: System MUST keep transactions short and avoid unnecessary locking. Only the candidate's `Reservation` row and its directly referenced `Inventory` rows are locked. No table-level locks. The `SELECT` scan for candidates is **outside** the per-reservation transaction (or uses `SKIP LOCKED` if the implementation does a single `FOR UPDATE SKIP LOCKED` scan variant — but the per-item locking guarantee of FR-003 must still hold). The worker MUST NOT load all expired reservations into memory unboundedly; it pages via `LIMIT` and repeats until no more candidates if the caller requests `processAll`.

- **FR-009**: System MUST provide observability without leaking secrets: each tick logs at `log` level summary `expiration tick: scanned=N expired=M skipped=K failed=F` with `Logger`, and at `debug` per-reservation `expiring reservation <id> expiresAt=<iso>` and on skip `skip reservation <id> status=<status>`. Failures log `warn` with `reservationId` and error class. After each commit, a RabbitMQ event `reservation.expired` is emitted (see FR-003); event publish is observed via logs/metrics, not via DB. No `rawToken`/payment data is involved; no PII beyond `userId` is logged beyond `debug`.

- **FR-010**: System MUST have DB-backed tests proving cleanup correctness: unit tests (mocked `EntityManager` where appropriate) for scan predicate (`expiresAt <= NOW()`), `validateTransition`, and idempotent skip; **integration tests against real PostgreSQL** for: (a) expired `RESERVED` → `EXPIRED` with `reservedAmount` release, (b) not-yet-expired `RESERVED` not selected, (c) multi-item atomic release or rollback, (d) concurrent `worker vs complete` / `worker vs cancel` / `worker vs worker` → single winner and exactly one inventory mutation, (e) reprocessing already-`EXPIRED` → no double-release (idempotency), (f) batch paging (`batchSize < total expired` processes all across ticks), (g) `reservedAmount>=0` CHECK violation rolls back single candidate without aborting batch; **E2E or service-level test** that the scheduler actually fires (fast interval) and eventually expires a just-expired reservation within the interval window.

### Key Entities

- **Reservation**: `id (uuid PK)`, `userId (FK User CASCADE)`, `orderId (FK Order SET NULL nullable)`, `status (enum RESERVED|COMPLETED|EXPIRED|CANCELLED)`, `expiresAt (timestamptz)`, `createdAt/updatedAt`, `OneToMany` `items`. Existing indexes: `@Index(['userId'])`, `@Index(['status'])`, `@Index(['expiresAt'])`, `@Index(['status','expiresAt'])` composite — the last is the required scan index. No new columns added in this phase.
- **ReservationItem**: `id (uuid PK)`, `reservationId (FK Reservation CASCADE)`, `inventoryId (FK Inventory CASCADE)`, `quantity (CHECK >0)`, `@Unique(['reservationId','inventoryId'])`. Drives `reservedAmount -= quantity` amount per expiration.
- **Inventory**: `id (uuid PK)`, `productId (FK Product CASCADE, UNIQUE)`, `stock (CHECK >=0)`, `reservedAmount (CHECK >=0, CHECK <= stock)`, derived `available = stock - reservedAmount` (not stored mutably). Mutated only via `reservedAmount -= qty` on expiration (stock unchanged).
- **ExpirationWorker / ReservationExpirationService / ReservationExpirationProcessor**: Not a DB entity; BullMQ processor (`@Processor('reservation-expiration')`) plus service that owns scanning (`expiresAt <= NOW()`), and per-reservation transactional orchestration via `DataSource`/`EntityManager`. Scheduling is via BullMQ repeat (`BULLMQ_REPEAT`/`EXPIRATION_CRON` every `30s` by default to meet 60s SLA). Config via `EXPIRATION_INTERVAL_MS`/`EXPIRATION_CRON`/`EXPIRATION_BATCH_SIZE`/`EXPIRATION_ENABLED`.

---

## 4. Success Criteria

### Measurable Outcomes

- **SC-001**: With `stock=10, reserved=2` and a `RESERVED` reservation `qty 2` whose `expiresAt = NOW() - 5m`, a single worker batch processes it to `status=EXPIRED`, `reservedAmount=0`, `stock=10`, `available=10` **within 60s of `expiresAt`** (1m SLA — tick interval `30s`), and `GET /reservations/:id` immediately returns `EXPIRED` (verified by integration test on real PostgreSQL with `expiresAt` in the past; E2E with fast interval `30s` asserts expiry within SLA).
- **SC-002**: A `RESERVED` reservation with `expiresAt = NOW() + 10m` is never selected by the scan: after a tick, its `status` remains `RESERVED` and inventory is unchanged (verifies `expiresAt <= NOW()` predicate, not merely `status`).
- **SC-003**: Multi-item expiration is atomic: a reservation `A qty1 + B qty2` (`A stock=10 reserved=1`, `B stock=5 reserved=2`) transitions `R→EXPIRED` with both `A.reserved=0` and `B.reserved=0` or the whole transaction rolls back on any failure (verified by integration test that injects a failure on one inventory save).
- **SC-004**: Concurrent `worker-expire` vs `PATCH /:id/complete` on the same `RESERVED` expired reservation resolves to exactly one success and one `409`, and inventory is mutated exactly once (`reserved-=qty` once, `stock-=qty` only if completion wins) — never double-released or double-sold (verified by parallel `Promise.all` concurrency test with real `DataSource.transaction`, `--runInBand`).
- **SC-005**: Reprocessing an already-`EXPIRED` reservation (second worker tick scanning stale read or retry) causes no second `reservedAmount` decrement and leaves `reservedAmount` at the post-first-expiration value; `reservedAmount` is decremented exactly once per reservation lifecycle (verified by `expire → assert reserved=0 → run worker again → assert still reserved=0` idempotency test).
- **SC-006**: Under concurrent parallel worker ticks (two simultaneous `processExpiredBatch(10)` calls) on 5 expired `RESERVED` reservations, exactly 5 distinct reservations become `EXPIRED` and inventory is released exactly 5 times — no reservation is expired twice and no inventory `reservedAmount` goes negative (verified by concurrent worker-vs-worker integration test).
- **SC-007**: Batch paging completes: pushing 25 expired `RESERVED` across 5 inventories with `batchSize=10` and firing the worker (or calling `processExpiredBatch` three times) eventually marks all 25 `EXPIRED` and all inventories return to `reserved=0` **within 60s per reservation of its `expiresAt`** (SLA), verified by integration test or E2E with interval `30s` and assertion after 2-3 ticks.
- **SC-008**: `EXPLAIN (ANALYZE, BUFFERS)` for `SELECT id FROM reservation WHERE status='RESERVED' AND expiresAt <= NOW() ORDER BY expiresAt ASC, id ASC LIMIT 10` shows an `Index Scan` (or `Index Only Scan`) using the composite index `IX_reservation_status_expiresAt` (`status, expiresAt`), not a sequential scan, on a table with realistic rows (≥1000) — verified in integration/benchmark test.

---

## 5. Assumptions

- **A1**: PostgreSQL is authoritative; Redis/RabbitMQ/BullMQ are never authoritative for reservation truth (constitution I). Async event `reservation.expired` via RabbitMQ **is in scope** for Phase 5 (clarified 2026-09-16, option C) and MUST be published only **after** DB commit; publish failures do not roll back. Broader Phase 11 fan-out (notifications, analytics) remains out of scope.
- **A2**: `Reservation`/`ReservationItem`/`Inventory` entities, constraints, indexes (`status`, `expiresAt`, composite `status+expiresAt`, `userId`, `orderId`), `ReservationService.create` and Phase 4 lifecycle (`complete`/`cancel`/`expire` with `FOR UPDATE` Reservation-first + sorted Inventories) all exist and are correct. No new tables or column migrations are expected; the only allowed migration is a small index/CHECK tweak if a correctness gap is proven.
- **A3**: The default TTL for new reservations remains `15 minutes` (`DEFAULT_TTL_MS = 15m`, `expiresAt = now + TTL`) per `reservation.service.ts`; the worker never mutates TTL logic, only reads `expiresAt`.
- **A4**: Transaction boundary is `dataSource.transaction(manager => service.*(manager,...))` with `EntityManager`, same pattern as Phases 3-4. Worker service reuses the same internal helper as manual expiration, so manual `PATCH /:id/expire` behavior (Phase 4 immediate override) is unchanged.
- **A5**: The worker's scan uses `NOW()` from PostgreSQL server time, not app-server time, to avoid clock skew. `expiresAt` is `timestamptz`. Boundary `expiresAt == NOW()` is eligible.
- **A6**: Error mapping keeps Phase 4 conventions: manual transition invalid → `409 ConflictException`; forbidden → `403`; unknown reservation/inventory → `404`; validation → `400`; DB CHECK violation inside expiration transaction → `409` or logged error, not `500` leak.
- **A7**: `synchronize: false`; tests that prove consistency/single-winner/idempotency must use a **real PostgreSQL** (constitution VII, `npm run test -- --runInBand` integration). Unit tests may mock `EntityManager` for guard/predicate logic. E2E `test/jest-e2e.json` remains available for full flows (`register → create reservation → expire via worker → GET`).
- **A8**: No new reservation states beyond `RESERVED|COMPLETED|EXPIRED|CANCELLED` and no new fields on `Reservation`/`Inventory`. Cancellation-after-sale (`stock += qty`) remains Phase 8 (order cancellation) and is not assumed here; this phase's expiration always does `reservedAmount -= qty` only (stock unchanged).
- **A9**: `EXPIRATION_INTERVAL_MS`/`EXPIRATION_CRON`/`EXPIRATION_BATCH_SIZE`/`EXPIRATION_ENABLED` are read via `ConfigService` from `.env`, never hardcoded. Defaults are reasonable (e.g., `interval 30s-60s`, `batchSize 10-100`). Logging via injected `Logger`, not `console.log`.
- **A10**: Optimistic locking or in-memory `available` recomputation is out of scope; pessimistic `FOR UPDATE` + deterministic ordering remains the concurrency primitive, consistent with `AGENTS.md` (§3 Transactions, Database Rules) and `docs/plan.md` §5.2-5.3.

---

## 6. Dependencies

- Phase 1 `Inventory` (`InventoryService`, constraints, `InventorySeeder`, DB checks) — DONE 2026-08-21.
- Phase 2 `Reservation`/`ReservationItem` entities, indexes (incl. composite `status+expiresAt`), `ReservationService`/`ReservationController`, `validateTransition`, `assertOwner`, migration `1755850000000` — DONE 2026-08-22.
- Phase 3 transaction-safe `ReservationService.create` (`FOR UPDATE` sorted inventories, `available` check, `reservedAmount` increment) — DONE 2026-08-30.
- Phase 4 reservation lifecycle (`complete`/`cancel`/`expire` transactional, `FOR UPDATE` Reservation+Inventories, single-winner, `COMPLETED→COMPLETED` idempotent) — DONE 2026-09-14 (`src/modules/reservation/reservation.service.ts:202-243` updated, `004-reservation-lifecycle`).
- `DataSource`/`EntityManager` transactional support, global `ValidationPipe` + `AllExceptionsFilter` (constitution).
- Background-job infrastructure: BullMQ (`@nestjs/bullmq` + Redis) selected as the repeat scheduler (clarified 2026-09-16, option B) — `reservation-expiration` queue, `concurrency:1`, `repeat` every `30s` to meet 60s SLA; `@nestjs/schedule` not used for this worker.
- `Order` entity not required for expiration (only for `complete`).

---

## 7. Out of Scope (this phase)

- Any change to `Order` integration, checkout transaction that creates `Order`+`Reservation` atomically, `Order` status machine, payment success/failure, or refund logic — Phases 6-8.
- Redis caching / product cache keys / TTL / invalidation — Phase 9; Redis must not become authoritative for reservation expiry (the DB field remains truth; Redis may back a distributed lock if chosen, but correctness must hold via `FOR UPDATE` alone).
- Rate limiting on new endpoints — Phase 10; the worker has no public HTTP throttle surface beyond internal config.
- RabbitMQ/BullMQ async event publishing for broader `ReservationExpired` notifications/analytics — Phase 11; Phase 5 **does** publish a minimal RabbitMQ `reservation.expired` domain event after commit per 2026-09-16 clarification (post-commit only, not inside the transaction). Full notification fan-out remains Phase 11.
- Idempotency/retry infrastructure beyond the per-reservation `status != RESERVED` guard and batch-continue-on-failure — Phase 12 (this phase provides idempotent skip, not a full idempotency-key framework).
- Database optimization broad index/constraint sweep — Phase 13; this phase may use the existing composite index but does not redesign the broader index set.
- Eager product/inventory caching or `available` stored column — out; `available` remains derived.
- Frontend reset links, email tokens, OTP, or auth upgrades — Phase 16 (orthogonal, `005-auth-upgrades`).
- New reservation states, new `Reservation`/`Inventory` columns, or changing `expiresAt` generation/TTL logic.
- `SKIP LOCKED` optimization that would break deterministic ordering — allowed only if it preserves per-reservation `FOR UPDATE` + sorted inventory locking.

---

## 8. Clarifications

### Session 2026-09-16

- Q: Should the cleanup worker enforce `expiresAt <= NOW()` or expire all `RESERVED` irrespective of clock? → A: Worker MUST enforce `expiresAt <= NOW()` (DB truth) as the selection predicate; manual admin `PATCH /:id/expire` is the only path that bypasses the clock (Phase 4 override). The worker is discovery-only.
- Q: What infrastructure should run the periodic cleanup (BullMQ repeated job vs NestJS `@Cron`/`@Interval` vs RabbitMQ)? → A: Deferred to **plan phase** (`research.md` decision D1) — spec requires a scheduled/background mechanism with configurable interval/batch/enabled flag and non-overlapping ticks, but does not bind to a library; any choice must keep transactions short, lock only needed rows, and not introduce a new daemon without justification per `docs/plan.md` §5.4.
- Q: How should duplicate/repeated processing of the same expired reservation be handled? → A: Idempotent skip — reprocessing an already-`EXPIRED` (or `COMPLETED`/`CANCELLED`) reservation after `FOR UPDATE` must detect `status != RESERVED` and do nothing; `reservedAmount` is decremented exactly once per reservation, never twice, per Phase 4 FR-007/FR-008 and constitution idempotency rule.
- Q: What is the required timeliness for automatic expiration after expiresAt (tick interval / SLA)? → A: Expire within 60s of expiresAt — 1m SLA (tick every ~30s, option B). Balances quick inventory return with low DB load; SC-001/SC-007 now bound to 60s.
- Q: Which background-job mechanism should run the periodic expiration tick? → A: BullMQ repeated job (option B) — persistent, distributed queue with repeat interval; `ReservationExpirationProcessor` via `@Processor` + `repeat`/`cron`.
- Q: Should the expiration worker publish an async event after each successful commit? → A: Yes — publish RabbitMQ event `reservation.expired` (option C) after DB commit with `{reservationId, userId, expiredAt}`; publish failures do not roll back DB, only log.
- Q: How should multi-replica BullMQ workers coordinate to avoid duplicate expiration? → A: BullMQ singleton repeat job (option B) — `jobId` singleton + `concurrency:1`; FOR UPDATE remains the correctness guard, singleton is efficiency optimization.
- Q: How should a poison expired reservation that fails CHECK/missing Inventory be retried? → A: Retry up to N times (configurable `EXPIRATION_MAX_RETRIES`, default `3`) and after N skip — log every retry at `warn`/`error`, batch continues to next candidate, poison remains `RESERVED` but is skipped after N failures until manual fix (custom: retry N then skip).
- No additional markers remain at spec authoring time. All business invariants are fully specified.

---

## 9. Acceptance Scenarios (for planning)

1. Expired auto-release: `RESERVED qty2 expiresAt=NOW()-5m stock10 reserved2` → worker batch → `EXPIRED reserved0 stock10`.
2. Not-yet-expired immunity: `RESERVED expiresAt=NOW()+10m` → scan skips → stays `RESERVED`.
3. Multi-item atomic: `RESERVED A1+B2 expired` → `EXPIRED` releases both or rolls back both.
4. Batch paging: 25 expired `batchSize 10` → 3 ticks or 3 calls eventually drain all 25.
5. Worker vs complete race: `RESERVED expired` + parallel `complete` → one `200`/`EXPIRED`, one `409`, single inventory mutation.
6. Worker vs cancel race: same guarantee; `reserved-=qty` once.
7. Worker vs worker double-tick: two simultaneous `processExpiredBatch(10)` on 5 expired → exactly 5 become `EXPIRED`, no double-release.
8. Idempotency: `EXPIRED` already → second worker tick on same `id` → no second `reserved-=qty`.
9. Per-candidate failure isolation: one expired candidate missing inventory → that candidate logs and `404`/`409` rolls back alone; other candidates in same batch still expire.
10. Schedule observable: short `EXPIRATION_INTERVAL_MS=5000` → creating an already-expired reservation → within interval window it becomes `EXPIRED` without manual call (or via `processExpiredBatch` direct call for determinism in tests).
11. Manual override unaffected: `RESERVED future expiresAt` → `PATCH /:id/expire` by admin → `EXPIRED` immediately (no `expiresAt` check) — proves worker vs manual predicate split.
