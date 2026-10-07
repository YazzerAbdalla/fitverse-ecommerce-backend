# Research: Payment Simulation (Demo)

**Feature**: `018-payment-simulation` | **Date**: 2026-10-07
**Scope**: Resolve all plan unknowns using repo evidence (`docs/plan.md §19`, `order-transitions.ts`, `OrderCompletionService`, `OrderCancellationService`, clarify Q1–Q5). No NEEDS CLARIFICATION remains.

## D1. Success path reuses `OrderCompletionService.complete` (no forked stock math)

- **Decision**: `PaymentService.confirm(success)` runs one `dataSource.transaction` that `FOR UPDATE` locks `Payment`, then delegates the `Order + Reservation + Inventory` mutation to the existing `OrderCompletionService.completeWithManager(manager, …)` core (same core the `POST /order/:id/complete` admin fallback uses), then marks `Payment SUCCEEDED` before commit.
- **Rationale**: Single stock-math authority (`stock-=qty reserved-=qty`, `23514→409`, idempotent `COMPLETED→COMPLETED`) already proven by Phase 7 + ADR-0014; forking it would create drift.
- **Alternatives considered**: Duplicate inventory loop inside `PaymentService` — rejected (dual truth, violates TI-2 single mutation point).

## D2. Decline/cancel reuse the cancellation core with `reason=failed|cancelled`

- **Decision**: `confirm(declined)` → `Order PENDING→FAILED` + `Reservation RESERVED→CANCELLED` (`reserved-=qty` only); `cancel()` → `Order PENDING→CANCELLED` + `Reservation CANCELLED`. Both reuse `OrderCancellationService.cancelOrderWithManager(manager, …, reason)` (ADR-0014: reason-derived target, type system proves `COMPLETED` unreachable).
- **Rationale**: Pre-sale inventory effect is identical for both (hold release, stock untouched); reusing the core keeps the transition table single-sourced (`order-transitions.ts`).
- **Alternatives considered**: Separate payment-owned order mutation — rejected (transition drift).

## D3. Lock order `Payment → Order → Reservation → sorted Inventories`

- **Decision**: All payment writes lock in this fixed order inside the caller's single tx; `completeWithManager`/`cancelOrderWithManager` cores already assume `Order→Reservation→sorted Inventories` after the caller holds `Payment`.
- **Rationale**: Deterministic order prevents deadlocks between concurrent confirms and expiry (TI-6); matches ADR-0010 reservation-first vs order-first analysis — payment is order-first like user cancel, not reservation-first like the worker (documented divergence, never unified silently).
- **Alternatives considered**: Lock `Order` before `Payment` — rejected (two entry points could deadlock confirm-vs-confirm).

## D4. Owner-only writes (Q1)

- **Decision**: `intent/confirm/cancel` enforce `assertOrderOwner(order, sub)` with **no admin bypass** (`callerRole` omitted); reads (`GET :id`, `GET /`) keep `owner-or-Admin` via `assertOrderOwner(order-or-payment, sub, role)`.
- **Rationale**: Matches `§19.4` table (`confirm`/`cancel` = `owner`) and user choice; admin fallback for completion stays `POST /order/:id/complete`, not payment confirm.
- **Alternatives considered**: Admin bypass on writes — rejected per Q1 (support override risk, wider blast radius).

## D5. Pending payment blocks expiry (Q2)

- **Decision**: The expiration worker skips candidates whose `Order` has a `PENDING` payment (`WHERE NOT EXISTS (SELECT 1 FROM payment WHERE orderId = order.id AND status = 'PENDING')` in the candidate filter, or an in-tx recheck before expiring). No `Payment` status change on skip; the shopper mid-pay is never expired out.
- **Rationale**: User-chosen semantics; preserves the 60s-SLA spirit for payment-free orders while avoiding a confirm-vs-expire race class for the demo.
- **Alternatives considered**: Expiry cancels payment / single-winner race — rejected per Q2 (more states, harder demo).

## D6. Throttling reuses checkout buckets (Q3)

- **Decision**: `@UseGuards(RateLimitGuard)` outermost on `POST /payments/intent` + `POST /payments/:id/confirm`, reusing the `POST /order/checkout` 10/h per-user bucket keys (`rl:POST /order/checkout:user:<sub>`); `429` never holds a lock (guard runs before tx).
- **Rationale**: Zero new config, matches `§19.5` + `rate-limiting.md` guard-order rule; fail-open preserved.
- **Alternatives considered**: Separate payment buckets / no throttling — rejected per Q3.

## D7. Decline reason is a fixed enum (Q4)

- **Decision**: `ConfirmPaymentDto.failureReason` is optional on `success`, and when `result='declined'` must be one of `card_declined | insufficient_funds | expired_card` (`@IsIn`, validated by global pipe; unknown → 400, no state change).
- **Rationale**: Testable demo matrix without free-text sprawl; matches Q4 choice.
- **Alternatives considered**: Free text / required-always — rejected per Q4.

## D8. List is status-only filter, paginated newest-first (Q5)

- **Decision**: `GET /payments?page=&limit=&status=` (default `page=1 limit=20 max=100`), `createdAt DESC`, owner-scoped (admin may add `?userId=`); no `orderId` filter in demo.
- **Rationale**: Matches existing `GET /order` + notification-history pagination shape (`skip=(page-1)*limit`, `{data, meta}`); Q5 narrowed scope.
- **Alternatives considered**: `orderId` filter / unpaginated — rejected per Q5.

## D9. No payment outbox event in demo; order events flow unchanged

- **Decision**: Payment writes no `OutboxEvent` row of its own. The wrapped `complete/cancel` cores still insert their existing `order.completed` / `order.cancelled` (+ `reservation.expired` where applicable) rows in the same tx (TI-4 preserved); payment state is read from `Payment` directly.
- **Rationale**: Demo scope has no payment webhook consumer; adding a new event type would expand queue topology for zero demo value.
- **Alternatives considered**: `payment.succeeded/failed` events — deferred post-demo with Stripe.

## D10. Idempotency + 1:1 + validation semantics

- **Decision**: `POST /payments/intent` idempotent on same order `PENDING` (returns existing row 201); terminal payment or non-`PENDING` order → 409; missing order → 404; non-owner → 403. Terminal `confirm` → 200 already-processed zero-delta (checked on `FOR UPDATE Payment` before any `Order/Reservation/Inventory` lock). `cancel` on terminal → 409. Amount always `Order.total`, `currency='usd'`, `provider='simulation'`.
- **Rationale**: Directly implements spec FR-002/FR-004…FR-010 + `§19.9` exit criteria with the smallest new-code surface.
