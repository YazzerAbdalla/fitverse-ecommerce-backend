# ADR: Asynchronous Events — Transactional Outbox (Phase 11)

**Date**: 2026-09-23 | **Status**: Accepted | **Spec**: `specs/011-async-events-notifications/spec.md` | **Plan**: `specs/011-async-events-notifications/plan.md`

## Context

Phase 11 originally `publish-after-commit` (`Business → COMMIT → RabbitMQ emit`) was at-most-once: `COMMIT` succeeds but `emit ECONNREFUSED` → event lost, no retry, no audit. Business availability relied on fail-open `Logger.warn` but durability was lost. Requirement to refactor to **Transactional Outbox** per user directive: `Business + OutboxEvent INSERT atomic` → `COMMIT` → `OutboxPublisher FOR UPDATE SKIP LOCKED batch 100 lease 30s` → `RabbitMQ` → `NotificationWorker` at-least-once, `FAILED` retained.

## Decision

- **Outbox table** `outbox_event` (`id uuid eventId, eventType varchar, aggregateType, aggregateId uuid @Index no FK, payload jsonb {version:1, eventId, eventType, occurredAt, correlationId, ...} CHECK, status enum PENDING|PROCESSING|SENT|FAILED, attempts int, nextRetryAt, lastError 1000, processingStartedAt, createdAt, sentAt`) with composite `(status,nextRetryAt,createdAt)` + `eventType`/`aggregateId` (data-model.md).
- **OutboxService.createEvent(manager, {eventType, aggregateType, aggregateId, payload})** generates `eventId==id`, `occurredAt=NOW()`, `correlationId` from `X-Request-Id`|`X-Correlation-Id`|`randomUUID()`, inserts via `manager.getRepository(OutboxEvent).save` inside same `DataSource.transaction` as business mutation (checkout `order.created`, completion `order.completed`, cancellation `order.cancelled`, expiration `reservation.expired [+ order.cancelled]`). No `client.emit` inside transaction.
- **OutboxPublisher.poll/publishBatch** claims `(PENDING nextRetryAt<=NOW() OR PROCESSING lease expired 30s)` ordered `createdAt ASC` `LIMIT batchSize FOR UPDATE SKIP LOCKED` → `PROCESSING`, publishes persisted `payload` via `NOTIFICATION_SERVICE` `client.emit(eventType, payload)` `await lastValueFrom`, success `SENT sentAt`, failure `attempts++ lastError nextRetryAt=+base*2^n` cap `60s` (`OUTBOX_RETRY_BASE_MS=1000`, `OUTBOX_RETRY_MAX_MS=60000`) `PENDING` until `5 → FAILED` retained (not deleted, `OUTBOX_RETENTION_DAYS=30` cleanup nightly, manual `PATCH /admin/outbox/:id/requeue`).
- **Transport**: RabbitMQ `notification_queue` durable fan-out for `order.*`/`reservation.expired`; BullMQ only for `reservation-expiration` repeat `30s` + optional `outbox-publish` repeat `1s` + consumer `notifications attempts 3` separate from publisher `5`.
- **Payload**: `version:1` + `correlationId` envelope, PII-free (`userId` only, worker `usersRepository.findOne(userId)` for email).

## Alternatives Considered

- Direct `publish-after-commit` with `Logger.warn` fail-open — **rejected**: loses events on `ECONNREFUSED`.
- Outbox `SELECT FOR UPDATE` without `SKIP LOCKED` + Redis leader lock — **rejected**: publisher blocks, extra infra.
- `payload` reconstruction from current DB at publish — **rejected**: state may have changed (`PENDING→COMPLETED`), must publish stored snapshot.
- Hard FK `aggregateId → order.id` — **rejected**: `FAILED` retained after `Order DELETE` would violate FK.

## Consequences

- **Positive**: `commit → PENDING` invariant, RMQ outage `PENDING` durable retry within `~31s`, `FAILED` audit, crash lease reclaim, at-least-once consumer `NotificationWorker` duplicate `eventId` tolerated, business latency not extended.
- **Negative**: Extra `INSERT outbox_event` per business transaction (<5ms jsonb), table retention `30d` growth (cleanup job needed), `FOR UPDATE SKIP LOCKED` requires PG17.
- **Migrations**: `1755900000003-CreateOutboxEvent` (composite index) — never edit prior.
- **Verification**: `SC-001..008` (`SELECT outbox_event` atomic, `EXPLAIN` uses index, concurrent `SKIP LOCKED` disjoint, `grep client.emit inside manager 0`, `npm run test -- --runInBand` 24+ suites, `test:e2e` RMQ-down `PENDING`).

