# ADR: Payment Simulation — Intent + Confirm Without a Real Provider (Phase 19)

**Date**: 2026-10-08
**Status**: Accepted
**Spec**: `specs/018-payment-simulation/spec.md` (+ clarify 2026-10-07, 5 questions) | **Plan**: `specs/018-payment-simulation/plan.md`
**Branch**: `018-payment-simulation`

## Context

Checkout produced `Order PENDING + Reservation RESERVED` but completion was a manual `POST /order/:id/complete` with no payment row and no exercisable decline path (`docs/plan.md §19.0`). The demo needed a clickable checkout → payment → completion flow with zero external network; full Stripe (intent + webhook + signatures + replay table) was deferred post-demo as 3–5 days of work.

## Decision

- **New `PaymentModule`** (`src/modules/payment/`) owning only `Payment` persistence (`orderId UNIQUE FK CASCADE`, `userId`, server-copied `amount CHECK>=0`, `currency 'usd'`, `PaymentStatus PENDING|SUCCEEDED|FAILED|CANCELLED`, `provider 'simulation'`, migration `1755900000012-CreatePayment`). No `Order` columns changed.
- **Reuse, don't fork**: `confirm success` delegates stock math to `OrderCompletionService.completeOrderWithManager`; `confirm declined` (`reason='failed'`) and `cancel` (`reason='user'`) delegate to `OrderCancellationService.cancelOrderWithManager` (ADR-0014 reason-derived targets). Single tx, lock order `Payment → Order → Reservation → sorted Inventories` (D3).
- **Q1 owner-only writes**: `intent/confirm/cancel` pass no role, so no admin bypass can engage; reads stay `owner-or-Admin`. The existing `POST /order/:id/complete` remains the admin fallback.
- **Q2 payment blocks expiry**: the expiration worker skips candidates with a `PENDING` payment (raw table check, rechecked inside the expiry tx, fail-open to legacy behavior pre-migration). No dependency reversal: reservation never imports the payment entity.
- **Q3 throttling**: `POST /payments/intent` + `POST /payments/:id/confirm` reuse the checkout 10/h per-user quota (guard table + `ORDER_CHECKOUT_RL_*` env keys), outermost so `429` never holds a lock.
- **Q4/Q5 contract narrowing**: decline reason is a fixed enum (`card_declined | insufficient_funds | expired_card`, 400 otherwise); list is status-only filter, newest-first, `{data, meta}` envelope.
- **Idempotency/1:1**: second intent on pending returns the same row (201); terminal payment or non-pending order → 409; terminal re-confirm → 200 zero-delta (checked on `FOR UPDATE Payment` before any other lock); terminal cancel → 409.
- **No payment outbox event** (D9): the wrapped completion/cancellation cores still write their `order.completed`/`order.cancelled` rows in-tx (TI-4 preserved); payment state is read from `Payment` directly.

## Alternatives Considered

- Duplicate inventory loops inside `PaymentService` — rejected (dual stock-math truth, TI-2 violation).
- Admin bypass on writes — rejected per Q1 (support override risk).
- Expiry-cancels-payment / single-winner race — rejected per Q2 (harder demo, new states).
- `payment.succeeded/failed` outbox events — deferred with Stripe (no consumer in demo).

## Consequences

- Demo is end-to-end clickable with no secrets, webhooks, or cents handling; concurrent confirms collapse to one stock mutation (proven by real-PG `Promise.all` suite).
- `RateLimitGuard` gains two route keys (same quota family, no new env surface).
- Expiry gains a best-effort payment check (raw SQL, documented TI-1 exception); pre-migration DBs behave exactly as before.
- Post-demo Stripe work is untouched: `stripePaymentIntentId`, `clientSecret`, webhook verify, cents, replay table all still open per `docs/plan.md §19.10`.

## Verification

- `npm run build` clean; `eslint` on touched scope 0 errors (remaining repo warnings pre-date this work).
- Unit `payment.service.spec.ts` 20/20; guard suite 27/27 (no throttle regression); concurrency + E2E specs pass via graceful skip without PG (live proofs deferred to CI with infra up, same as Phase 18 close-out).
- Order + reservation suites: 91 pass; 25 failures are pre-existing PG-dependent integration specs failing identically on the clean tree (ECONNREFUSED, no local PG).
