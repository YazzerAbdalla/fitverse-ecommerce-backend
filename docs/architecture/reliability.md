# Architecture — Reliability / Idempotency (Phase 12)

**Date**: 2026-09-23 | **Spec**: `specs/012-reliability-idempotency/spec.md` | **Plan**: `specs/012-reliability-idempotency/plan.md` | **Branch**: `012-reliability-idempotency`

Phase 11 made delivery durable (Outbox `PENDING→PROCESSING→SENT/FAILED` `FOR UPDATE SKIP LOCKED` `1s·2^n` max 5). Phase 12 makes execution idempotent so reprocessing twice leaves state identical.

## Guards

```text
Reservation RESERVED → EXPIRED|CANCELLED|COMPLETED
  SELECT Reservation WHERE id=:id FOR UPDATE
  if status != RESERVED → 200 already terminal (same-transition) 0 delta + INCR idempotency:duplicate:skipped:expiration/cancel + Logger.log
  else if status == RESERVED → FOR UPDATE sorted Inventories → reservedAmount-=qty → status=EXPIRED/CANCELLED → INSERT OutboxEvent only if transition → COMMIT
  Cross-transition COMPLETED→EXPIRED → 409

Order PENDING → COMPLETED
  SELECT Order WHERE id=:id FOR UPDATE
  if status == COMPLETED → 200 already COMPLETED 0 delta + INCR idempotency:duplicate:skipped:complete (before FOR UPDATE Reservation/Inventories)
  else if status != PENDING → 409
  else FOR UPDATE Reservation → FOR UPDATE sorted Inventories → stock-=qty reserved-=qty → COMPLETED

Outbox FAILED → PENDING (Admin requeue)
  PATCH /admin/outbox/:id/requeue @Auth(Admin) → SELECT OutboxEvent WHERE id=:id FOR UPDATE → if status != FAILED → 409 → else UPDATE status=PENDING attempts=0 nextRetryAt=NOW()
```

## Dedup

```text
Envelope: OutboxEvent.id == payload.eventId (uuid) + version:1 + correlationId (X-Request-Id or randomUUID())
NotificationWorker handle(eventId):
  SET NX notification:processed:<eventId> EX 86400 → if 0 → Logger.log duplicate skipped + INCR idempotency:duplicate:skipped:notification + return
  else EmailProvider.send → NotificationLog INSERT ON CONFLICT (eventId) DO NOTHING → ACK
Bulk sendBulk: re-scan full SELECT WHERE marketingOptIn + per-user SET NX notification:send:sales:<campaignId>:<userId> EX 86400 → skip sent (Q4 A)
Redis fail-open: SET NX throw → Logger.warn + first=true (availability over strict)
PG fallback: NotificationLog eventId @Unique optional
```

## Retry / Poison / Counter

```text
Layer A Outbox Publisher: PROCESSING lease 30s reclaim, attempts++ nextRetryAt base*2^(n-1) cap 60s max 5 → FAILED retained
Layer B Expiration BullMQ repeat 30s concurrency 1 + Redis SET NX expiration:tick:lock EX 30 single-winner; per-candidate FOR UPDATE → poison count only on transient 23514/ETIMEDOUT/ECONNREFUSED/500 (200/404 not counted per Q3 A) → 3 → quarantine 24h (expiration:poison:quarantined EX 86400)
Layer C Notifications BullMQ notifications attempts 3 backoff exponential; duplicate SET NX makes retry stateless
Layer D Business HTTP: no server retry, client idempotent via status guard
Counter (Q5 B): INCR idempotency:duplicate:skipped:<type> EX 86400 on every 200 idempotent + duplicate eventId skip, Redis down → warn fail-open
```

## Contracts

- `PATCH /admin/outbox/:id/requeue` `@Auth(Admin)` `200 {id,status:PENDING}` `404` not found `409` not FAILED `403` non-Admin
- `GET /admin/outbox?status=FAILED` paginated `Admin`
- `PATCH /reservations/:id/expire|cancel` `200` same-transition idempotent (Q2 A) `409` only for conflicting cross-transition
- `POST /order/:id/complete` `200` `COMPLETED→COMPLETED` idempotent already
