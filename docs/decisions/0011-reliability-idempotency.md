# ADR-0011: Reliability / Idempotency — Phase 12 (Hardening For Retry)

- **Date**: 2026-09-23
- **Status**: Accepted
- **Feature**: specs/012-reliability-idempotency (Phase 12)

## Context
Phase 11 Outbox made delivery at-least-once (`FOR UPDATE SKIP LOCKED` `1s·2^n` max 5). Re-delivery, worker lease reclaim, client retry after timeout can re-execute same logical operation (expire same reservation, complete same order, deliver same eventId). Without idempotency, `reservedAmount`/`stock` double-subtracted.

## Decision
- Same-transition idempotent returns `200` `0` delta before any `FOR UPDATE sorted Inventories` (Q2 A): `RESERVED→EXPIRED` second `expire` on `EXPIRED` → `200`, `CANCELLED→CANCELLED` → `200`, `COMPLETED→COMPLETED` → `200`; cross-transition `COMPLETED→EXPIRED` remains `409`.
- Dedup via `OutboxEvent.id == payload.eventId` + Redis `SET NX notification:processed:<eventId> EX 24h` (Q3 `SET NX 24h`, optional `NotificationLog eventId @Unique` fallback, D7). Bulk `sendBulk` re-scans full eligible set with per-user `SET NX` (Q4 A, no checkpoint cursor).
- Poison `3→quarantine 24h` counts only transient `23514/ETIMEDOUT/ECONNREFUSED/500`, excludes `200`/`404` idempotent (Q3 A/D2).
- Observability log + `INCR idempotency:duplicate:skipped:<type> EX 86400` on every idempotent skip (Q5 B, Redis fail-open).
- Admin `PATCH /admin/outbox/:id/requeue` `@Auth(Admin)` single-entity `FOR UPDATE WHERE status=FAILED → PENDING` (Q1 B, no bulk, no auto-requeue).

## Consequences
- Inventory invariant `stock-=qty reserved-=qty` exactly once even under `Promise.all([expire,expire])` or duplicate `POST /order/:id/complete`.
- `ReservationTransitionBuilder` ordering `Reservation → sorted Inventories → Order` preserved, `available = stock - reservedAmount` not double-applied.
- `Failed` retained 30d, requeueable via HTTP without direct psql.
- Bulk retry stateless, no `Idempotency-Key` header needed (D8).

## Alternatives Rejected
- `409` for same-transition idempotent → flaky tests.
- Bulk bulk checkpoint cursor → extra state.
- `Idempotency-Key` header table → extra migration not needed for P0.

## Verification
- `npm run build` + `npm run test -- --runInBand` 46 tasks (US1-US6) + `quickstart.md` duplicate `expire` `200` `reserved 0` and duplicate `complete` `200` `stock 8` and `PATCH requeue` `403/409/200`.
