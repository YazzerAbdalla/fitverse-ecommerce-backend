# Architecture — Asynchronous Events / Transactional Outbox (Phase 11)

**Date**: 2026-09-23 | **Spec**: `specs/011-async-events-notifications/spec.md` | **Plan**: `specs/011-async-events-notifications/plan.md` | **Refactored**: Corrections 1-14 (processingToken, envelope, ACK, exchange)

## Diagram

```text
Business Transaction (PostgreSQL)
        │
        ├── Order / Reservation / Inventory / Cart state change
        └── OutboxEvent INSERT (status=PENDING, attempts=0, nextRetryAt=NOW(), processingToken=NULL, payload={version:1, eventId=id, eventType, occurredAt, correlationId, data:{orderId,userId,...}}) — same EntityManager, OutboxService owns envelope
        │
        ↓ COMMIT (atomic: business + outbox)
        │
Outbox Publisher (application-managed interval every OUTBOX_POLL_INTERVAL_MS=1000, OnModuleInit → setInterval → publishBatch(), OnModuleDestroy → clearInterval; no BullMQ for outbox)
        │
        ├── Claim: SELECT * FROM outbox_event WHERE (status='PENDING' AND nextRetryAt<=NOW()) OR (status='PROCESSING' AND processingStartedAt < NOW()-'30s') ORDER BY createdAt ASC LIMIT 100 FOR UPDATE SKIP LOCKED → UPDATE status='PROCESSING', processingStartedAt=NOW(), processingToken=randomUUID() (ownership)
        ├── Publish: persisted payload byte-equal via NOTIFICATION_SERVICE (Transport.RMQ, exchange/event transport → verification queue; see Exchange vs Queue) client.emit(eventType, payload) await lastValueFrom
        ├── On success: UPDATE status='SENT', sentAt=NOW(), processingStartedAt=NULL, processingToken=NULL WHERE id=:id AND status='PROCESSING' AND processingToken=:token (token check prevents late A overwriting reclaimed B)
        └── On failure: UPDATE attempts++, lastError, nextRetryAt=NOW()+min(60000,1000*2^(attempts-1)), status=PENDING until attempts>=5 → FAILED (retained, not deleted) WHERE token matches
        │
        ↓ RabbitMQ event transport (exchange) → verification queue (queueOptions durable, noAck=false, prefetchCount 10)
        │   Future: exchange → email queue, webhook queue, in-app queue, analytics queue (not in Phase 11)
        │
EventVerificationConsumer (@EventPattern order.created|completed|cancelled|reservation.expired, noAck=false, manual ACK after log)
        │
        ├── Log: notification received <eventType> eventId=<id> correlationId=<id> (PII-free, no payload verbatim, no business mutation)
        ├── At-least-once duplicate eventId tolerated — verification consumer performs no mutation, so duplicate is harmless; persistent idempotency deferred
        └── ACK: channel.ack(originalMsg) only after log succeeds; on throw, no ACK → RabbitMQ requeue per queue config
```

## Why PostgreSQL Outbox

- **Lost event avoidance**: Prior `publish-after-commit` was at-most-once `failure → event lost`. Outbox stores event inside same `DataSource.transaction` — invariant *commit → PENDING row*.
- **SENT means published to RabbitMQ**: `SENT` indicates OutboxPublisher successfully submitted to RabbitMQ transport (exchange), NOT that email/webhook/notification was processed or that consumer ACKed. Consumer processing is future.
- **No RMQ inside transaction**: `client.emit` never inside `manager` callback (`grep client.emit inside dataSource.transaction 0` SC-007). Business `201` not extended.
- **Durable retry**: `attempts/nextRetryAt` exponential `1s,2s,4s,8s,16s` cap `60s` sum approximately `31s` before final attempt excluding polling/scheduling overhead (`OUTBOX_RETRY_MAX_MS`); `FAILED` retained `30d` (`OUTBOX_RETENTION_DAYS`) for ops/manual `PATCH /admin/outbox/:id/requeue`.
- **Crash recovery with ownership**: `processingStartedAt` lease `30s` + `processingToken` UUID allows reclaim `PROCESSING AND processingStartedAt < NOW()-lease` and prevents late publisher A overwriting B (UPDATE where token matches).

## Component Separation

| Layer | Responsibility | Tech | Retry |
|-------|---------------|------|-------|
| PostgreSQL Outbox | Durable buffering + publisher retry + lease recovery + ownership | `outbox_event` `FOR UPDATE SKIP LOCKED` batch 100, `processingToken` | `attempts 1..5` exponential `FAILED` retained |
| RabbitMQ | Domain event transport (exchange) → verification queue fan-out | `NOTIFICATION_SERVICE` `Transport.RMQ` `queue: notification_queue` durable, `noAck:false`, `prefetchCount:10` | Publisher-driven (no auto DLQ); consumer manual ACK |
| BullMQ | Background app jobs only | `reservation-expiration` repeat `30s` (unchanged) | `notifications` consumer `attempts 3` separate from publisher `5` (future) — outbox does NOT use BullMQ |

Outbox publishing is simple interval (`setInterval` `OUTBOX_POLL_INTERVAL_MS`), not BullMQ queue. `OUTBOX_*` env via `ConfigService` (clamped): `OUTBOX_BATCH_SIZE 1..200`, `OUTBOX_PROCESSING_LEASE_MS 1000..120000`, `OUTBOX_MAX_ATTEMPTS 1..10`, `OUTBOX_RETRY_BASE_MS 100..10000`, `OUTBOX_RETRY_MAX_MS 1000..120000`, `OUTBOX_RETENTION_DAYS 1..365`.

## Exchange vs Queue

Do not describe `notification_queue` as fan-out. Fan-out is via RabbitMQ **exchange** (event transport) that routes to verification queue (Phase 11). Future architecture:
```text
RabbitMQ event exchange
       ├── email queue
       ├── webhook queue
       ├── in-app queue
       └── analytics queue
```
Phase 11 only needs verification queue topology (existing `notification_queue` durable, `noAck:false`).

## Envelope Ownership

Business services provide `data` (e.g., `{orderId, userId, total, items}`) and `correlationId` (from request boundary `X-Request-Id`/`X-Correlation-Id` or `randomUUID()` for non-HTTP expiration). `OutboxService` owns envelope:
```json
{
  "version": 1,
  "eventId": "outbox.id",
  "eventType": "order.created",
  "occurredAt": "ISO",
  "correlationId": "uuid",
  "data": { "orderId": "...", "userId": "..." }
}
```
`payload.eventId === outbox_event.id` persisted and published byte-equal (no reconstruction).

## Correlation ID

HTTP controller resolves `X-Request-Id` OR `X-Correlation-Id` OR `randomUUID()` and passes `correlationId` into application service. Domain services never inspect HTTP headers. Expiration generates `randomUUID()` per operation. `OutboxService` simply persists supplied `correlationId`.

## Indexes

```sql
CREATE INDEX idx_outbox_status_next_retry_at_created ON outbox_event (status, nextRetryAt, createdAt); -- publisher
CREATE INDEX idx_outbox_eventType ON outbox_event (eventType);
CREATE INDEX idx_outbox_aggregateId ON outbox_event (aggregateId);
```

Publisher query `EXPLAIN` must use composite index, not seq scan. `processingToken` not indexed (point lookup via `id`).

## PII & Payload

`payload`/`data` contains `userId, orderId, reservationId, total, items` only — no `email`, no lookup. Future Email/Webhook consumers will resolve `email` via `userId` when implemented. Logs prefix `eventId correlationId` only.

## Retention

`SENT`/`FAILED` retained `30d`; nightly cleanup `DELETE WHERE (status='SENT' AND sentAt < NOW()-30d) OR (status='FAILED' AND createdAt < NOW()-30d)` (not during publish). Manual requeue `PATCH /admin/outbox/:id/requeue` resets `PENDING`. Phase 11 is internal infrastructure, not public `GET /outbox` dashboard; tests query `outbox_event` directly.

## Verification

- `POST /order/checkout → 201` + `psql SELECT * FROM outbox_event WHERE aggregateId=:orderId` `PENDING→SENT` within ~2s
- RMQ down → `PENDING attempts nextRetryAt` exponential ~31s sum, not `SENT`, not deleted
- `FOR UPDATE SKIP LOCKED` claim `EXPLAIN` uses index, concurrent publishers disjoint, token prevents late overwrite (A claims, B reclaims after lease, A late cannot mutate)
- `ReservationExpirationService` per-candidate `RESERVED→EXPIRED` + optional `PENDING→CANCELLED` inserts `reservation.expired` + conditional `order.cancelled` same transaction
- Duplicate `eventId` delivered twice → `EventVerificationConsumer` logs twice, no `Inventory` mutation, manual ACK semantics (`noAck=false`)

Phase 11 implements reliable asynchronous **infrastructure** using Transactional Outbox. It does **not** implement end-user notification functionality. Future phases may consume these events for Email, Webhooks, In-app, Push, SMS.

## Phase 18 Extension (2026-10-01): SENT_TO_MQ vs CONSUMED vs DELIVERED

`specs/014-email-service` (US6/US7, FR-016–FR-021, SC-009/SC-010) extends the status model without changing the publisher contract above: publisher still claims `FOR UPDATE SKIP LOCKED` with `processingToken` ownership, but success now writes `SENT_TO_MQ` (renamed `SENT`, backward-compat alias) meaning **broker accepted only**. The `NotificationsModule` consumer writes `CONSUMED` (`FOR UPDATE OutboxEvent` + dedup passed + manual `ACK` after commit) and per-channel `NotificationDelivery (eventId, channel)` rows (`PENDING → SENT → DELIVERED → FAILED`); user-visible `Notification` rows back `GET /notifications` + `unread-count` + `PATCH :id/read` + `read-all`, with `isRead/readAt` as READ (not delivery). Dispatch is `Strategy + Factory` runtime (`SYSTEM` WebSocket + `EMAIL`; `verify/reset` always both, else both-if-opted-in else system-only). `OutboxEvent` remains MQ-leg truth, `Notification/Delivery` user-leg truth, Redis only `SET NX` dedup — PG-truth, async-after-commit, and `PATCH /admin/outbox/:id/requeue` semantics unchanged.
