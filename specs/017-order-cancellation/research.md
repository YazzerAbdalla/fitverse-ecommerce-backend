# Research: Order Cancellation (Phase 8)

**Date**: 2026-10-06 | **Spec**: `specs/017-order-cancellation/spec.md`

All unknowns resolved from code evidence + locked clarification answers. No
open NEEDS CLARIFICATION remains.

## D1 — Reuse `OrderCancellationService`, harden it (not a rewrite)

- **Decision**: Keep `src/modules/order/order-cancellation.service.ts` as the
  cancellation owner and harden it to the spec (remove outbox swallow, enrich
  response data, require the dependency, type the locks). No new service.
- **Rationale**: The file already implements the demo-scope core correctly:
  `FOR UPDATE` Order → Reservation → sorted Inventories, `reservedAmount -=
  qty` only, idempotent re-cancel, `409` on COMPLETED, `order.cancelled`
  outbox insert in the same `EntityManager` tx. Rewriting would reintroduce
  proven behavior for zero gain.
- **Alternatives considered**: Fresh `CancellationUseCase` per
  `docs/REFACTOR_PLAN.md` RP-ORDER — rejected for this phase; that refactor
  (TI-3 controller-tx removal, intent-based stores) belongs to S6, not to a
  0.5-day demo phase. The plan keeps the controller-owned tx pattern already
  used by `POST /order/:id/complete` in the same controller.

## D2 — Outbox failure rolls back the cancel (locked Q2/A)

- **Decision**: Delete the try/catch-warn around `outboxService.createEvent`
  (`order-cancellation.service.ts:167-188`). A failed `order.cancelled`
  INSERT propagates and the whole cancel transaction rolls back (TI-4).
- **Rationale**: Matches spec FR-009 and `docs/REFACTOR_PLAN.md` §13 P0-8
  (checkout swallow must-fix; the same lost-event class applies here).
- **Alternatives considered**: Commit-cancel + retry-record — rejected by
  explicit user decision (Q2/A).

## D3 — Failed-path disposition (locked clarify session 2026-10-06)

- **Decision**: `reason: 'failed'` → order PENDING → FAILED, reservation
  RESERVED → CANCELLED, hold released identically to a shopper cancel.
- **Rationale**: A failed payment means no sale, so availability must be
  restored; only the order status differs (FAILED vs CANCELLED) for audit.
- **Alternatives considered**: Reservation → EXPIRED on failure — rejected;
  EXPIRED is the expiry worker's vocabulary. Keep-release-but-hold — rejected;
  strands inventory until manual review.

## D4 — Expiry path untouched

- **Decision**: The expiration worker path (`reservation.service.ts:647-676`
  auto-cancel + `reservation-expiration.service.ts:333-364` emitting
  `order.cancelled` with `reason: 'expired'`) is NOT modified. User/failed
  cancels go through `OrderCancellationService`; expiry keeps its own path.
  Both emit the same `order.cancelled` envelope shape with different reasons.
- **Rationale**: The expiry path is proven (SC-001..008, poison/quarantine
  semantics). Touching it risks the 60s-SLA behavior for no spec benefit.
- **Alternatives considered**: Routing expiry through
  `OrderCancellationService.cancel(reason='expired')` — rejected; the
  reservation-first vs order-first lock ordering differs and the worker's
  idempotent-duplicate detection depends on current structure.

## D5 — Lock ordering and idempotency shape

- **Decision**: `FOR UPDATE` Order → `FOR UPDATE` Reservation (+items) →
  `FOR UPDATE` sorted Inventories; idempotent re-cancel (`CANCELLED→*`,
  `FAILED→*`) returns before any inventory lock; `COMPLETED` → `409`.
- **Rationale**: Mirrors `OrderCompletionService` (Order → Reservation →
  sorted Inventories), so cancel-vs-complete races serialize on the same
  first lock (the Order row) — exactly one winner, one inventory movement.
- **Alternatives considered**: Reservation-first (lifecycle style) — rejected;
  would invert the order-vs-reservation lock order between complete and
  cancel paths, reopening deadlock risk on races.

## D6 — Enriched cancel response (locked FR-012)

- **Decision**: Extend the current `{id, status, total, userId}` shape with
  `reason` and `reservationId` (nullable when no linked reservation). Existing
  keys stay byte-identical.
- **Rationale**: Both values are already in hand at cancel time (reason param,
  looked-up reservation); no new reads, traceable without a second lookup.
- **Alternatives considered**: Minimal (status only) — rejected by user
  decision; full inventory-movement details — rejected, leaks internals.

## D7 — `@Optional()` → required for `OrderCancellationService` (OD-1)

- **Decision**: Make the controller dependency required (constructor, no
  `@Optional()`, no `!` assertions, no `not available` Error branch).
- **Rationale (OD-1 record)**: Current absent-behavior is a runtime 500
  (`throw new Error('OrderCancellationService not available')`); the provider
  is registered in the same module (`order.module.ts:36`), so
  absent-forever is a wiring bug, not a mode. Post-change: missing provider
  fails at boot (DI resolution) instead of at first cancel call. Providing
  module: `OrderModule` itself. Startup test asserts controller resolves.
- **Alternatives considered**: Keep optional — rejected; silent fail-open on
  a money-path service.

## D8 — Rate limiting stays as-is

- **Decision**: Keep the existing `@UseGuards(RateLimitGuard)` on
  `POST /order/:id/cancel`; no new bucket, no exemption. Verify 429 headers
  in tests.
- **Rationale**: The route is already guarded with the shared order-write
  posture; inventing a cancel-specific bucket is out of demo scope.
