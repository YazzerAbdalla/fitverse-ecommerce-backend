# Research: Asynchronous Events — Transactional Outbox (Phase 11)

**Feature**: `011-async-events-notifications` | **Spec**: [spec.md](./spec.md) | **Plan**: [plan.md](./plan.md) | **Date**: 2026-09-23
**Input**: Transactional Outbox refactor per `spec.md` §1–§9 (business transaction + `OutboxEvent INSERT` atomic, `OutboxPublisher` `FOR UPDATE SKIP LOCKED` batch 100, lease 30s, exponential `+1s,+2s,+4s,+8s,+16s` max 5, `FAILED` retained, at-least-once, `payload {version:1, eventId, eventType, occurredAt, correlationId, ...}` PII-free, `RABBITMQ_URL` existing `notification_queue`).

Phase 0 consolidates all `NEEDS CLARIFICATION` (0 remaining in Technical Context; 11 business clarifications §8 Session 2026-09-23 resolved) into implementation decisions.

## Decision D1: FOR UPDATE SKIP LOCKED for Claim (PostgreSQL 17)

**Decision**: Publisher claims via `QueryBuilder.setLock('pessimistic_write', undefined, {skipLocked:true})` with `SELECT ... WHERE (status='PENDING' AND nextRetryAt<=NOW()) OR (status='PROCESSING' AND processingStartedAt < NOW() - interval '30 seconds') ORDER BY createdAt ASC, id ASC LIMIT :batchSize FOR UPDATE SKIP LOCKED` then `UPDATE status='PROCESSING' processingStartedAt=NOW() WHERE id IN (:ids) RETURNING *`. Business writers never use `SKIP LOCKED` — only publisher.

**Rationale**: Native PG17 `SKIP LOCKED` gives lock-free concurrent claim for multi-pod publishers without Redis leader election; proven in `products.service.ts:updateMany` `pessimistic_write` but publisher adds `skipLocked`. Lease (`processingStartedAt`) prevents stuck `PROCESSING` after crash; reclaimed next poll.

**Alternatives considered**:
- Redis `SET NX EX` leader lock for single publisher — rejected: single point, fails if Redis down, unnecessary when `SKIP LOCKED` already serializes.
- `SELECT FOR UPDATE` without `SKIP LOCKED` — rejected: second publisher blocks on first's rows, poll latency spikes.
- Separate `outbox_claim` table — rejected: extra join, no benefit.

## Decision D2: Lease 30s + Poll 1s + Batch 100

**Decision**: `OUTBOX_BATCH_SIZE=100` (default, `ConfigService.get('OUTBOX_BATCH_SIZE')` clamp `1..200`), `OUTBOX_POLL_INTERVAL_MS=1000` (BullMQ repeat `outbox-publish` `every 1000` or `setInterval 1000` with `concurrency 1`), `OUTBOX_PROCESSING_LEASE_MS=30000` (30s). Business `DataSource.transaction` duration <50ms (lock + `INSERT outbox_event`) so publisher never contends.

**Rationale**: Batch 100 bounded by `max 200` keeps `FOR UPDATE SKIP LOCKED` short; 1s poll gives p95 visibility <2s under normal (checkout `201` not extended). Lease 30s >> typical `client.emit` latency (<100ms) so false reclaim rare; covers publisher crash.

**Alternatives**: Batch 10 (existing expiration batch) — too small for checkout burst 50 orders; `poll 30s` (expiration) — too slow for checkout; `lease 5s` — flaps under GC pause.

## Decision D3: Exponential Backoff base 1s cap 60s maxAttempts 5 → FAILED retained

**Decision**: `backoff = min( OUTBOX_RETRY_MAX_MS=60000, OUTBOX_RETRY_BASE_MS=1000 * 2^(attempts-1) )` → `attempts 1:+1s 2:+2s 3:+4s 4:+8s 5:+16s` (≈31s total). `OUTBOX_MAX_ATTEMPTS=5` then `status=FAILED lastError truncated 1000 nextRetryAt = NOW()` retained, not deleted. `OUTBOX_RETENTION_DAYS=30` cleanup `DELETE WHERE (status='SENT' AND sentAt < NOW - 30d) OR (status='FAILED' AND createdAt < NOW - 30d)` via nightly BullMQ `outbox-cleanup` or manual `PATCH /admin/outbox/:id/requeue`.

**Rationale**: Matches `reservation-expiration` poison `24h` precedent but durable; `FAILED` retention needed for ops/audit/manual replay (`UPDATE status='PENDING' attempts=0 nextRetryAt=NOW()`).

**Alternatives**: Immediate `FAILED` on first error — loses transient RMQ hiccup; infinite retry — risks table bloat.

## Decision D4: RabbitMQ for Domain Transport, BullMQ for Scheduling, PostgreSQL Outbox for Durability

**Decision**: `OutboxPublisher` publishes **persisted** `payload` (not reconstruction) via existing `ClientsModule` `NOTIFICATION_SERVICE` `Transport.RMQ` `queue: notification_queue` durable (`client.emit(eventType, envelope)` `await lastValueFrom(obs)`). `RabbitMQ` = fan-out (`order.*`, `reservation.expired` → notification/email/analytics). `BullMQ` = `reservation-expiration` repeat `30s` + optional `outbox-publish` repeat `1s` (or `setInterval`) + future `notifications` consumer `attempts 3` separate from publisher `attempts 5`. No second RMQ connection.

**Rationale**: Reuses `AppModule` singletons per `spec.md FR-009/012`; `SKIP LOCKED` already provides mutual exclusion, BullMQ leader lock optional. Previous dual-publish debate (Q1) resolved to RabbitMQ-only domain publish.

**Alternatives**: `BullMQ` `notifications` queue as primary transport — rejected: RMQ already provisioned for fan-out, `outbox_event` already durable, adding second queue duplicates.

## Decision D5: Payload Contract `{version:1, eventId, eventType, occurredAt, correlationId, ...business}` + PII-free Lookup

**Decision**: `OutboxService.createEvent(manager, {eventType, aggregateType, aggregateId, payload:{version:1, eventId: id, eventType, occurredAt: nowISO, correlationId, orderId, userId, total, currency, items, reservationId, expiresAt, ...}})` where `eventId == outbox.id` (UUID), `version:1` top-level inside `payload`, `correlationId` from controller `req.headers['x-request-id'] || req.headers['x-correlation-id'] || randomUUID()` passed through service. `payload` is `jsonb` (not `json`) with `CHECK (payload->>'version' IS NOT NULL)`. No `email`/`phone`/`Authorization` — worker does `usersRepository.findOne({where:{id:userId}})` for email (FR-001 clarification Q2).

**Rationale**: `version:1` enables additive evolution (consumer `switch(payload.version)`); `correlationId` enables E2E `Logger.log correlationId=<id> eventId=<id>` without extra header (Q5); `eventId==id` gives stable dedup key for at-least-once (consumer `if alreadyProcessed(eventId) return`).

**Alternatives**: Email in payload — rejected GDPR/leak to RMQ; `eventId` separate from `id` — rejected duplicate key.

## Decision D6: No Hard FK on aggregateId + Composite Index

**Decision**: `OutboxEvent.aggregateId` is `uuid` `@Index` without `FOREIGN KEY` to `Order`/`Reservation` (documented). Composite index `CREATE INDEX idx_outbox_status_next_retry_at_created ON outbox_event (status, nextRetryAt, createdAt)` for publisher `WHERE status IN ('PENDING','PROCESSING') AND nextRetryAt<=NOW() ORDER BY createdAt ASC, id ASC`. Additional `@Index(['eventType'])`, `@Index(['aggregateId'])`, `@Index(['createdAt'])`.

**Rationale**: Hard FK would block `DELETE FROM order` cascade vs `outbox_event` retention for audit; `outbox_event` is transient buffer, not child. Composite index matches publisher query plan `EXPLAIN` verified; single-column indexes insufficient for `status+nextRetryAt` filter.

**Alternatives**: FK `ON DELETE CASCADE` — rejected loses audit; FK `ON DELETE SET NULL` — leaves orphan `aggregateId`.

## Decision D7: Envelope = Persisted payload (no reconstruction)

**Decision**: Publisher emits `payload` byte-equal as stored (or `envelope = {eventId: outbox.id, eventType: outbox.eventType, version: payload.version, occurredAt: payload.occurredAt, correlationId: payload.correlationId, payload}` if wrapper needed, but spec `FR-009` says preserve `eventId,eventType,version,occurredAt,correlationId` — either `payload` already contains them, so `client.emit(eventType, payload)` suffices). No `SELECT Order` at publish time.

**Rationale**: State at `occurredAt` must not be rebuilt from current DB (order may have transitioned `PENDING→COMPLETED` since). Persisted `payload` freezes business snapshot.

**Alternatives**: Reconstruct from `Order` at publish — rejected race.

## Decision D8: Business Transaction Never Calls RabbitMQ

**Decision**: `grep client.emit` inside `dataSource.transaction(async manager =>` must be `0`. `OutboxService.createEvent` is `manager.getRepository(OutboxEvent).save(...)` (synchronous DB write inside transaction), `OutboxPublisher` runs in separate tick/queue after commit (`await dataSource.transaction` resolves, then return `201`). `AllExceptionsFilter` never catches publisher error as `500`; `429`/`400` before transaction → zero `outbox_event`.

**Rationale**: Keeps P0 invariant and HTTP latency `FOR UPDATE` only; publisher failure (`ECONNREFUSED`) only increments `attempts`.

## Summary of Resolved NEEDS CLARIFICATION

- Technical Context `NEEDS CLARIFICATION` 0 → all filled (Language, Primary Dependencies, Storage, Testing, Target Platform, Project Type, Performance, Constraints, Scale/Scope in `plan.md`).
- Business clarifications §8: Q1 transport RabbitMQ-only, Q2 PII lookup, Q3 poison `FAILED` retained vs drop, Q4 `version:1`, Q5 `correlationId`, outbox atomic + `BATCH_SIZE=100` + `lease 30s` + backoff `1s*2^n` max 5 — all resolved here.

No open `NEEDS CLARIFICATION` remains.

## References

- `spec.md` FR-001..016 + SC-001..008 + §5 Assumptions + §8 Clarifications (2026-09-23 outbox refactor)
- `src/modules/order/order-checkout.service.ts:44` (`dataSource.transaction` `FOR UPDATE` sortedIds)
- `src/modules/reservation/reservation-expiration.service.ts:199` (per-candidate `RESERVED→EXPIRED` `FOR UPDATE`)
- `src/app.module.ts:60` (`ClientsModule NOTIFICATION_SERVICE` + `BullModule.forRootAsync` shared `REDIS_URL`)
- PostgreSQL 17 `FOR UPDATE SKIP LOCKED` docs, TypeORM `setLock('pessimistic_write', undefined, {skipLocked:true})`
- Prior `reservation.expired` direct emit superseded
