# ADR 0014: Order Cancellation — Cancel-Before-Sale (Phase 8, Demo Scope)

**Date**: 2026-10-06
**Status**: Accepted
**Spec**: `specs/017-order-cancellation/spec.md` (+ clarify sessions, plan, tasks)
**Branch**: `017-order-cancellation` (work landed on `master` per session flow)

## Context

Phase 8 required the order cancellation state machine (statuses, per-status
inventory effects, refund behavior) with the exit bar "no double-release /
double-return". A partial `OrderCancellationService` already existed (unplanned,
no spec/tests) with two load-bearing defects found during hardening: an outbox
swallow that committed cancels without their `order.cancelled` record (TI-4
violation), and a `FOR UPDATE` + `relations` join that Postgres rejects on every
cancel with items. Controller-owned transactions also violated TI-3.

## Decision

- **Demo scope**: cancel-before-sale only. `PENDING → CANCELLED` (shopper/admin/
  expiry) and `PENDING → FAILED` (payment failure) release the hold
  (`reservedAmount -= qty`, stock untouched) in one transaction
  (`FOR UPDATE` Order → Reservation → sorted Inventories). Post-sale
  `COMPLETED → CANCELLED` refund is deferred post-demo (no `stock += qty` path).
- **Single transition authority**: `src/modules/order/order-transitions.ts` owns
  `ALLOWED_ORDER_TRANSITIONS` + `validateOrderTransition()` +
  `assertOrderOwner()` + `mapInventoryCheckViolation()`; the three drifted
  copies were replaced (F2). Cancellation additionally narrows targets to
  `CANCELLED|FAILED` by construction (reason-derived; the type system proves
  `COMPLETED` unreachable, so no dead guard remains).
- **Q2/A durability**: the outbox swallow was deleted — a failed
  `order.cancelled` INSERT propagates and the cancel rolls back, so a
  committed cancel is never silent. Same-transaction record via
  `OutboxService.createEvent` (TI-4).
- **TI-3 boundary move**: `OrderController` drops `DataSource` entirely (single
  concern: HTTP transport). `cancelOrder`/`completeOrder` own their
  transactions; `cancelOrderWithManager`/`completeOrderWithManager` cores stay
  available for composed flows (payment failure, Phase 19).
- **F5 join fix**: reservation is locked WITHOUT relations, items reloaded
  under the held lock (same pattern as ADR-0010).
- **Failed-path disposition** (clarify A): `reason=failed` → order FAILED,
  reservation CANCELLED, hold released identically to a shopper cancel.
- **Expiry path untouched** (D4): the worker keeps reservation-first ordering
  and emits the identical `order.cancelled` envelope with `reason=expired`.
  Its best-effort order auto-cancel vs user-cancel rollback is an intentional,
  documented divergence — never unify silently.
- **Response**: enriched `{id, status, total, userId, reason, reservationId}`
  (FR-012); existing keys byte-identical. Reason is NOT embedded in order
  reads (D9: no migration, no per-row outbox lookup on hot reads).
- **Env-driven sync** (same session, user-directed): `synchronize` resolves
  from `TYPEORM_SYNCHRONIZE` (explicit) else `MODE`/`NODE_ENV` (true unless
  production), with a boot warn when on. Documented in `.env.example`; local
  `.env` sets `true` for develop. Migration files remain the production DDL
  path — sync never replaces them.
- **Incidental hardening in the same slice**: dead `order.enum.ts`,
  service stubs + orphan DTOs deleted (DC-1 evidence: zero importers);
  dead `DataSource` injection removed (later re-added as tx owner, T034);
  `ORDER_CURRENCY` constant; unreachable `total < 0` guard removed;
  AGENTS.md §3 naming pass (`cancelOrder`, `checkoutUserCart`,
  `assertOrderOwner`, explicit locals); `as any` removed from touched lines;
  idempotent-skip counter parity for cancel.

## Alternatives Considered

- Keep controller-owned tx for file consistency — rejected by explicit user
  direction; uniform service-owned boundaries beat consistency with a
  known TI-3 violation.
- Route expiry through `cancelOrder(reason=expired)` — rejected; lock
  ordering differs (reservation-first vs order-first) and the worker's
  duplicate detection depends on current structure.
- Commit-cancel + retry-record on outbox failure — rejected by user (Q2/A).
- Restore cart on cancel — rejected by user (Q3/A); cart stays cleared.
- `GET /order` embedding the cancel reason — rejected (D9; migration or
  hot-path lookup cost for demo scope).

## Consequences

- Cancel-before-sale is fully proven: unit 9 + integration 6 + cancel-race 2
  + expiry-race 3 + characterization 2 on real PG, plus live curl proof
  (checkout → cancel → recancel → inventory, `order.cancelled` published).
- Two test-infra fixes were required to prove it (same slice): the expiration
  suite's `dropSchema: true` was nuking shared dev-DB tables on every run
  (now `synchronize: false` + truncates), and its EXPLAIN assertion was
  planner-fragile on tiny tables (now asserts the composite index exists).
  Residual hazard documented: inventory/auth suites still use
  `synchronize: true` (auth on separate DBs; inventory on shared DB) — a
  full-run ordering risk owned outside Phase 8.
- Pre-existing issues observed but NOT fixed (out of scope): first-ever cart
  POST for a new user returns 500 while the write succeeds (cart module);
  malformed UUID params yield 500 instead of 404 (no global ParseUUIDPipe).

## Verification

- `npm run build` clean; `npx eslint` on touched scope 0 errors.
- `npm run test -- --runInBand src/modules/order src/modules/reservation`:
  14 suites / 111 tests green (incl. `Promise.all` single-winner races).
- Live: `POST /order/checkout → POST /order/:id/cancel → 200` enriched →
  recancel `200` zero-delta → inventory `reserved 0/stock unchanged` →
  outbox `order.cancelled` published to RMQ (log proof).
