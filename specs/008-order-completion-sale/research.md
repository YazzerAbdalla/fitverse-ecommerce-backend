# Research: Order Completion / Sale (Phase 7)

**Branch**: `008-order-completion-sale` | **Date**: 2026-09-22 | **Spec**: [spec.md](./spec.md) | **Plan**: [plan.md](./plan.md)

All `NEEDS CLARIFICATION` from Technical Context resolved (0). Spec Session 2026-09-22 provides 8 clarifications. Research consolidates best practices and rejected alternatives for sale orchestration.

---

## D1: `COMPLETED→COMPLETED` idempotent 200 vs 409

- **Decision**: `Order PENDING→COMPLETED` supports idempotent `COMPLETED→COMPLETED → 200` with no inventory re-mutation (like `Reservation COMPLETED→COMPLETED` Phase 4 Q4). `COMPLETED→*` otherwise `409`.
- **Rationale**: Client retries (double-click, network retry, `supertest` parallel) are common; idempotent success aligns with Phase 12 reliability goal and constitution IV (no double-sale). Phase 4 already implements `Reservation COMPLETED→COMPLETED 200` with `orderId` overwrite, so Order mirroring is consistent.
- **Alternatives considered**:
  - `409 Conflict` on duplicate complete — rejected: forces client to treat retry as error, increases failure handling complexity, inconsistent with Reservation idempotency.
  - `204 No Content` on duplicate — rejected: loses the order payload that callers expect after E2E `register→complete→GET`.
  - Generic `Idempotency-Key` header (Phase 12) — rejected for Phase 7; header is out-of-scope, but idempotent 200 without header covers the same retry case cheaply.

---

## D2: Lock ordering `Order → Reservation → sorted Inventories`

- **Decision**: Inside `dataSource.transaction`: `SELECT Order WHERE id=:orderId FOR UPDATE` (assertOwner) → `SELECT Reservation WHERE orderId=:orderId FOR UPDATE` (load `items`) → `sortedIds = [...new Set(items.map(i=>inventoryId))].sort()` → `SELECT ... FOR UPDATE` on `Inventory WHERE id IN(sortedIds)`. All via `EntityManager`.
- **Rationale**: Mirrors Phase 3-4 deterministic ordering and Phase 6 checkout (`sortedIds` prevents `[A,B]` vs `[B,A]` deadlock). Locking Order first gives single-winner on `COMPLETED→COMPLETED` before touching Inventories, minimizing contention window. Reservation second ensures `RESERVED→COMPLETED` validates before Inventory mutation. Sorted Inventories last serializes shared `B` across different orders.
- **Alternatives considered**:
  - Lock Inventories first, then Order — rejected: two concurrent completes on same Order would both lock Inventories before realizing Order already `COMPLETED`, wasting lock time and increasing deadlock surface when Orders share Inventories.
  - `SELECT ... FOR UPDATE` with outer join `Order LEFT JOIN Reservation + items` — rejected: cannot lock nullable side (`SET NULL FK`) reliably; two-step lock (Order without relation, then Reservation with items) avoids `cannot lock rows in outer join` PG error already handled in `reservation.service.ts:367`.
  - Optimistic locking (`@VersionColumn`) — rejected: inventory correctness requires pessimistic row lock per constitution IV; optimistic would allow oversell under high contention before conflict detection.

---

## D3: No explicit `available >= qty` pre-check; rely on DB CHECK backstop

- **Decision**: Completion does **not** re-check `available = stock - reservedAmount >= qty` before `stock-=qty reserved-=qty`. The mutation is applied directly and `CHK_inventory_stock_non_negative` / `CHK_inventory_reserved_non_negative` / `CHK_inventory_reserved_lte_stock` (`code 23514`) is mapped to `409 Conflict`.
- **Rationale**: Same as Phase 4 Q2: availability at checkout already enforced `reservedAmount+=qty` when `available` was sufficient. Completion's `stock-=qty` cannot be validated against `available` without race — availability is stale once `FOR UPDATE` is held; DB constraints are the source of truth. Pre-check would duplicate `Inventory.available` logic and add code without safety.
- **Alternatives considered**:
  - Explicit `if (stock < qty || reservedAmount < qty) throw 409` before save — rejected: racy if admin `decreaseStock` happened concurrently (stock < qty but CHECK would catch); also duplicates constraint message; kept as service-level guard only for clearer `409` mapping but CHECK remains authoritative.
  - Map all `409`s to `400` — rejected: lifecycle and stock violations are conflicts with current state, not bad client syntax; `409` matches Phase 4 pattern.

---

## D4: Single-winner `complete vs complete` and `complete vs expire`

- **Decision**: `FOR UPDATE` on Order gives single-winner `complete vs complete` — first committer does `stock-=qty`, second sees `COMPLETED` and returns idempotent `200` with no mutation. For `complete vs expire` (worker `RESERVED→EXPIRED` + `Order CANCELLED`), winner is whichever acquires `Reservation FOR UPDATE` first; loser sees `COMPLETED`/`EXPIRED` and gets `409` (or idempotent `200` if it requested winner's terminal state). Tests use `Promise.all([complete, complete])` and `Promise.all([complete, expire])` with real PG `--runInBand`.
- **Rationale**: Reuses Phase 5 expiration worker's `FOR UPDATE` Reservation-first + sorted Inventories pattern and `ReservationTransitionBuilder`. Keeping Order first for `complete` while worker locks `Reservation` first is acceptable — the shared lock is `Reservation FOR UPDATE` (both paths lock it), so serialization is via Reservation row. No new `Order PENDING→CANCELLED` race beyond existing worker's `FOR UPDATE` on Order inside `transitionWithInventoryInternal:433`.
- **Alternatives considered**:
  - Try to lock Order and Reservation in same order for both paths (`Order` first for worker too) — rejected: worker's batch `findExpiredCandidateIds` → `transitionWithInventoryExpire` builder locks Reservation without Order (Order may not exist if reservation not yet checkout-linked); forcing Order lock for non-checkout reservations would add missing-Order branching.
  - Use advisory lock `pg_try_advisory_xact_lock(orderId)` — rejected: adds PG extension concept not used elsewhere; row-level `FOR UPDATE` already sufficient for `FOR UPDATE` single-winner.
  - Emit failure metric and retry — rejected: not needed for correctness; retry is worker's poison TTL concern, not sale path.

---

## D5: Historical price/total immutability on completion

- **Decision**: Completion **does not** re-read `Product.price`, **does not** recalculate `Order.total`, **does not** mutate `OrderItem.unit_price` or `subtotal`. `OrderItem.unit_price` remains snapshot from checkout; `subtotal` generated column `quantity*unit_price` stays.
- **Rationale**: Phase 6 FR-004 isolates historical price — `Product` price changes after checkout must not affect committed orders. Completion is an inventory movement (`stock`/`reservedAmount`), not a commerce recalculation. Keeping `total` immutable simplifies auditing; re-querying `Product.price` would risk `OrderItem` vs `ReservationItem` quantity mismatch (spec Edge Case 7).
- **Alternatives considered**:
  - Recompute `total` from current `Product.price` on completion — rejected: violates historical guarantee and creates `Order PENDING` created at `100` then completed at `999` inconsistency.
  - Add `completedAt` price delta column — rejected: no requirement in docs/plan.md; deferred to future pricing phase.

---

## D6: No Payment entity; `FAILED` guard-only

- **Decision**: Do **not** create `Payment` entity, `paymentStatus`, or webhook. Keep `OrderStatus.FAILED` in enum and enforce `validateOrderTransition` guard (`PENDING→FAILED` valid but not exercised; `FAILED→COMPLETED` `409`). No `POST /order/:id/fail` endpoint in V1.
- **Rationale**: `docs/plan.md` §7.2 explicitly “Do not invent a payment integration; Define payment state separately when payment requirements exist”. Adding a fake `Payment` now would invent business rules and complicate the minimal sale exit criterion. `FAILED` as enum value documents the future payment-failure path without code.
- **Alternatives considered**:
  - Implement `POST /order/:id/fail` → `PENDING→FAILED` + `reservedAmount-=qty` (release only) — viable stub; deferred to keep PR minimal but can be added as single-method guard test (`validateOrderTransition(PENDING,FAILED) 200`) without new route; rejected for scope but not harmful if added.
  - Add `Payment` table with `orderId` FK + `status` — rejected: requires migration, checkout linkage, and webhook verification not in spec; would invent PAYMENT domain prematurely.

---

## D7: Response payload & HTTP method alias

- **Decision**: Canonical `POST /order/:id/complete` (`200` with `{ id, status:COMPLETED, total, items:[{productId,quantity,unitPrice,subtotal}], reservationId, reservation:{id,status}, inventoriesAffected? }` or minimal `{ id,status,reservationId }` if plan chooses small payload — constitution V prefers thin controller; full payload reuses `order.service.findOne` + `reservationRepo.findOne` enrichment). Optional alias `PATCH /order/:id/complete` matching `PATCH /reservations/:id/complete` history, both idempotent.
- **Rationale**: `POST` is non-idempotent by RFC but spec explicitly makes handler idempotent for retry safety; `POST` matches `POST /order/checkout` verb consistency (both mutating Order). Alias `PATCH` costs one decorator line and aligns with existing reservation lifecycle verb, so allow but document canonical `POST`.
- **Alternatives considered**:
  - `PUT /order/:id/complete` idempotent by definition — rejected: less conventional for action-like “complete” vs resource replacement.
  - Require `Idempotency-Key` header — rejected: Phase 12 concern, not Phase 7.

---

## Risk Mitigations

- **Double-sale if idempotency guard misses**: Test `complete vs complete` asserts final `stock = initial - qty` once; code returns early on `COMPLETED→COMPLETED` before any `manager.save(Inventory)`.
- **Order without Reservation (data drift)**: `SELECT Reservation WHERE orderId FOR UPDATE` → `404` ensures rollback; no partial `Order COMPLETED` with missing `Reservation`.
- **Inventory row deleted concurrently**: `lockedInventories.length !== sortedIds.length` → `404`, rollback, `Order` stays `PENDING`.
- **Stock violated by admin decreaseStock**: `CHK` → `409` mapped, rollback preserves `PENDING`.

## Open items to verify in implementation

- Confirm `OrderModule` provides `OrderCompletionService` and `DataSource` transaction caller pattern (`dataSource.transaction(async manager => ...)`) — already used in `order-checkout.service.ts:45` and `reservation.service.ts:41`.
- Confirm `ReservationService.validateTransition` is exported and reusable (already `public`).
- Confirm `AllExceptionsFilter` serializes `409` mapping from `23514` (already done in `reservation.service.ts:484`).
