# Architecture — Asynchronous Events / Transactional Outbox (Phase 11)

**Date**: 2026-09-23 | **Spec**: `specs/011-async-events-notifications/spec.md` | **Plan**: `specs/011-async-events-notifications/plan.md`

## Diagram

```text
Business Transaction (PostgreSQL)
        │
        ├── Order / Reservation / Inventory / Cart state change
        └── OutboxEvent INSERT (status=PENDING, attempts=0, nextRetryAt=NOW(), payload={version:1, eventId=id, eventType, occurredAt, correlationId, ...}) — same EntityManager
        │
        ↓ COMMIT (atomic: business + outbox)
        │
Outbox Publisher (poll interval 1s OR BullMQ repeat `outbox-publish` every 1000, concurrency 1)
        │
        ├── Claim: SELECT * FROM outbox_event WHERE (status='PENDING' AND nextRetryAt<=NOW()) OR (status='PROCESSING' AND processingStartedAt < NOW()-'30s') ORDER BY createdAt ASC LIMIT 100 FOR UPDATE SKIP LOCKED → UPDATE status='PROCESSING', processingStartedAt=NOW()
        ├── Publish: persisted payload byte-equal via NOTIFICATION_SERVICE (Transport.RMQ, queue notification_queue durable) client.emit(eventType, payload) await lastValueFrom
        ├── On success: status='SENT', sentAt=NOW(), lastError=NULL
        └── On failure: attempts++, lastError=LEFT(msg,1000), nextRetryAt=NOW()+min(60000, 1000*2^(attempts-1)), status= PENDING (retry) until attempts>=5 → FAILED (retained, not deleted)
        │
        ↓ RabbitMQ (existing RABBITMQ_URL, RABBITMQ_QUEUE=notification_queue)
        │
NotificationWorker (@EventPattern order.created|completed|cancelled|reservation.expired, concurrency 5)
        │
        ├── Log: notification received <eventType> eventId=<id> correlationId=<id> (PII-free, no payload verbatim)
        ├── Lookup: usersRepository.findOne(userId) for email — payload only userId (Q2)
        └── At-least-once duplicate eventId tolerated — log duplicate eventId already processed, no Inventory/Order mutation (FR-011)
        │
        ↓ BullMQ (optional) for consumer-side retries
           BullMQ notifications queue attempts 3 separate from publisher maxAttempts 5 (FR-012)
```

## Why PostgreSQL Outbox

- **Lost event avoidance**: Prior `publish-after-commit` (Business → COMMIT → RabbitMQ emit) was at-most-once `failure → event lost`. Outbox stores event inside same `DataSource.transaction` as business mutation — invariant *commit → PENDING row*.
- **No RMQ inside transaction**: `client.emit` never inside `manager` callback (`grep client.emit inside dataSource.transaction 0` SC-007). Business `201` latency not extended by broker.
- **Durable retry**: `attempts/nextRetryAt` exponential `1s,2s,4s,8s,16s` cap `60s`, `FAILED` retained `30d` (`OUTBOX_RETENTION_DAYS`) for ops/audit/manual `PATCH /admin/outbox/:id/requeue`.
- **Crash recovery**: `processingStartedAt` lease `30s` (`OUTBOX_PROCESSING_LEASE_MS`) allows reclaim `PROCESSING AND processingStartedAt < NOW()-lease` after publisher crash before `SENT` update.

## Component Separation

| Layer | Responsibility | Tech | Retry |
|-------|---------------|------|-------|
| PostgreSQL Outbox | Durable buffering + publisher retry + lease recovery | `outbox_event` `FOR UPDATE SKIP LOCKED` batch 100 | `attempts 1..5` exponential, `FAILED` retained |
| RabbitMQ | Domain fan-out (`order.*`, `reservation.expired`) | `NOTIFICATION_SERVICE` `Transport.RMQ` `notification_queue` durable | Publisher-driven (no auto DLQ) |
| BullMQ | Scheduling + consumer retries | `reservation-expiration` repeat `30s`, `outbox-publish` repeat `1s` (optional), `notifications` consumer `attempts 3` | Separate from publisher `5` |

`OUTBOX_*` env all via `ConfigService` (clamped): `OUTBOX_BATCH_SIZE 1..200`, `OUTBOX_PROCESSING_LEASE_MS 1000..120000`, `OUTBOX_MAX_ATTEMPTS 1..10`, `OUTBOX_RETRY_BASE_MS 100..10000`, `OUTBOX_RETRY_MAX_MS 1000..120000`, `OUTBOX_RETENTION_DAYS 1..365`.

## Indexes

```sql
CREATE INDEX idx_outbox_status_next_retry_at_created ON outbox_event (status, nextRetryAt, createdAt); -- publisher
CREATE INDEX idx_outbox_eventType ON outbox_event (eventType);
CREATE INDEX idx_outbox_aggregateId ON outbox_event (aggregateId);
```

Publisher query `EXPLAIN` must use composite index, not seq scan.

## PII & Payload

`payload jsonb` contains `version:1, eventId==outbox.id, eventType, occurredAt, correlationId` (from `X-Request-Id`/`X-Correlation-Id` or `randomUUID()`) + `orderId, userId, total, currency, items[{productId,inventoryId,quantity,unit_price}], reservationId, expiresAt` — no `email`. Worker lookup `User` by `userId`. Logs prefix `eventId correlationId` only.

## Retention

`SENT`/`FAILED` retained `30d`; nightly cleanup `DELETE WHERE (status='SENT' AND sentAt < NOW()-30d) OR (status='FAILED' AND createdAt < NOW()-30d)` (not during publish). Manual requeue `PATCH /admin/outbox/:id/requeue` resets `PENDING`.

## Verification

- `POST /order/checkout → 201` + `psql SELECT * FROM outbox_event WHERE aggregateId=:orderId` `PENDING→SENT` within 2s
- RMQ down → `PENDING attempts nextRetryAt` exponential, not `SENT`, not deleted
- `FOR UPDATE SKIP LOCKED` claim `EXPLAIN` uses index, concurrent publishers disjoint
- `ReservationExpirationService` per-candidate `RESERVED→EXPIRED` + optional `PENDING→CANCELLED` inserts `reservation.expired` + conditional `order.cancelled` same transaction
- Duplicate `eventId` delivered twice → `NotificationWorker` no `Inventory` mutation
