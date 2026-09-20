# ADR 006: Reservation Expiration Cleanup — BullMQ Repeat + Redis Locks + Poison TTL (Phase 5)

**Date**: 2026-09-21
**Status**: Accepted
**Feature**: 006-reservation-expiration-cleanup (Phase 5)

## Context

Phase 5 closes `docs/plan.md` §§5.1-5.4. Phases 2-4 provide `Reservation`/`ReservationItem`/`Inventory` with `status+expiresAt` composite index and `FOR UPDATE` lifecycle (`RESERVED→COMPLETED` `stock-=qty+reserved-=qty`, `RESERVED→CANCELLED/EXPIRED` `reserved-=qty` via `src/modules/reservation/reservation.service.ts:transitionWithInventoryInternal` + builder `src/modules/reservation/reservation-transition.builder.ts`). Missing: automated worker discovering `status='RESERVED' AND expiresAt <= NOW()` (Postgres `NOW()` truth, not app clock) and releasing `reservedAmount` within 60s SLA, safe under races `worker vs complete vs cancel vs worker`.

Spec `specs/006-reservation-expiration-cleanup/spec.md` (Q1-Q5 Session 2026-09-16): 60s SLA (tick every 30s), BullMQ repeat (B) over `@nestjs/schedule`, RabbitMQ `reservation.expired` post-commit (C), singleton `jobId+concurrency:1` (B) with `FOR UPDATE` as correctness backstop, poison `EXPIRATION_MAX_RETRIES=3` log-every-retry then skip.

## Decision

- **Scheduler**: BullMQ `BullModule.forRootAsync` (`src/app.module.ts:45` `REDIS_URL` precedence fixed) + `BullModule.registerQueue({name:'reservation-expiration'})` (`src/modules/reservation/reservation.module.ts:12`) + `ReservationExpirationProcessor` (`@Processor('reservation-expiration', concurrency:1)` `src/modules/reservation/reservation-expiration.processor.ts:7`). `onModuleInit` registers repeat `30s` (`EXPIRATION_INTERVAL_MS`) or `EXPIRATION_CRON` with `jobId='reservation-expiration-tick'` singleton (`processor.ts:57`), `removeOnComplete/removeOnFail true`. No new daemon, modular monolith preserved (constitution II).

- **Tick execution**: `processor.ts:70` `process()` guards `EXPIRATION_ENABLED=false`, in-memory `processing` flag, then distributed `REDIS_CLIENT SET expiration:tick:lock NX EX ttlSec` (`Math.ceil(interval/1000)+5`, `processor.ts:52`) — second replica skips with `skippedByLock`, fails open if Redis down (relies on `FOR UPDATE`). Then `service.processExpiredBatch(batchSize)` (`EXPIRATION_BATCH_SIZE` 1..100, default 10).

- **Scan + per-candidate tx**: `ReservationExpirationService.findExpiredCandidateIds` (`service.ts:49`) `WHERE status='RESERVED' AND expiresAt <= NOW() ORDER BY expiresAt,id LIMIT` (deterministic, composite index `status+expiresAt` — `EXPLAIN` shows `Index Scan`). Scan outside tx for short locks; per id `dataSource.transaction(manager=> expireOne(manager,id))` (`service.ts:108`) → `ReservationTransitionBuilder` → `transitionWithInventoryInternal` (`FOR UPDATE` Reservation first, then sorted `Inventory` `In(sortedIds)` `pessimistic_write`, `validateTransition`, `reserved-=qty` or `stock-=qty+reserved-=qty`, `CHECK 23514→409`). RabbitMQ `client.emit('reservation.expired', {reservationId,userId,expiredAt,inventoryIds})` **after** commit (`service.ts:136`), `subscribe` error logged not rolled back (FR-003).

- **Poison**: Redis-backed `expiration:poison:count:{id}` (`INCR`+`EXPIRE 86400`) + `expiration:poison:quarantine:{id}` (`SET EX 86400`) (`service.ts:19`), fallback to in-memory `Map/Set` when `REDIS_CLIENT` unavailable (tests). `Conflict Invalid transition` → `skipped` not retried + `clearPoison`; otherwise `incrementPoisonCount` → `retried`, `>=maxRetries` → `setQuarantined` + `failed` + `LOG.warn`; batch continues. `REDIS_CLIENT` provided via `ReservationModule` `ioredis` lazy (`REDIS_URL` or `REDIS_HOST/PORT`) (`reservation.module.ts:31`), shared with tick lock. Survives restarts unlike prior in-memory `Map` (24h TTL).

- **Idempotency**: Reprocessing `EXPIRED/COMPLETED/CANCELLED→EXPIRED` hits `409 Invalid transition` after `FOR UPDATE` → `skipped` no second `reserved-=qty`.

- **Config**: `EXPIRATION_INTERVAL_MS=30000`, `EXPIRATION_BATCH_SIZE=10`, `EXPIRATION_ENABLED=true`, `EXPIRATION_MAX_RETRIES=3` (`.env.example:33`, `ConfigService`), `REDIS_URL`/`RABBITMQ_URL` (`specs/006-reservation-expiration-cleanup/quickstart.md`).

- **Test infra**: `package.json:16` `test: jest --runInBand` (constitution VII) + `transformIgnorePatterns` for `@nestjs/bullmq` ESM; `expiration.integration.spec.ts` covers single/multi-item, immunity, worker vs complete/cancel/worker single-winner, idempotency, batch 25/10, EXPLAIN, poison 3→quarantine.

## Alternatives considered

- `@nestjs/schedule` `@Cron` — rejected: in-memory, loses ticks on restart, needs custom Redis lock for singleton; BullMQ provides persistent repeat + `concurrency:1`.
- `SKIP LOCKED` scan variant — deferred: correctness already via `FOR UPDATE`; Redis `SET NX` tick lock gives same efficiency (≈10 wasted txs per colliding tick) without changing scan SQL; document as efficiency-only optimization if backlog grows.
- In-memory poison `Map/Set` only — rejected: loses quarantine on restart, repeats 3 retries each deploy; Redis TTL fixes.

## Consequences

Positive: 60s SLA met (30s tick), no double-release under replicas, batch paging short txs, poison survives restarts, `reservation.expired` observable post-commit, `jest --runInBand` 20 suites 169 tests green.

Negative: Adds `REDIS_CLIENT` `ioredis` handle (lazy) — `Jest did not exit` without `--forceExit` if module imported; handled via `--runInBand --forceExit` CI.

## Related

- Spec/Plan: `specs/006-reservation-expiration-cleanup/spec.md`, `plan.md`, `research.md` D1-D8, `data-model.md`, `contracts/reservation-expiration.md`, `quickstart.md`
- Tasks: `specs/006-reservation-expiration-cleanup/tasks.md` 45 tasks
- Code: `src/modules/reservation/reservation.service.ts`, `reservation-transition.builder.ts`, `reservation-expiration.service.ts`, `reservation-expiration.processor.ts`, `reservation.module.ts`, `src/app.module.ts`
- Prior: `ADR-0010-reservation-lifecycle-transaction-pattern`, `docs/plan.md` Phase 5 `DONE`
