# Implementation Plan: Reliability / Idempotency — Phase 12

**Branch**: `012-reliability-idempotency` | **Date**: 2026-09-23 | **Spec**: [spec.md](./spec.md)
**Input**: Feature specification from `/specs/012-reliability-idempotency/spec.md` (Phase 12 — idempotency hardening: expiration/complete/cancel/notification, `200` standardized same-transition, poison excludes `200`/`404`, bulk `SET NX` re-scan, log + `INCR` counter, `PATCH /admin/outbox/:id/requeue` Admin-only)

## Summary

Harden all retryable paths that became at-least-once in Phase 11 (Outbox `FOR UPDATE SKIP LOCKED` `PENDING→PROCESSING→SENT/FAILED` `1s·2^n` max 5) so that re-executing the same logical operation twice leaves business state identical to once. Touch only **idempotent guards** (`SELECT ... FOR UPDATE` + `if status != RESERVED/PENDING → 200 0 delta` before any `Inventory` write) and **dedup** (`OutboxEvent.id` + Redis `SET NX notification:send:... EX 24h` + optional `NotificationLog eventId @Unique`) and **observable retry** (`FAILED` retained + `PATCH /admin/outbox/:id/requeue` `@Auth(Admin)` + `CACHE INCR idempotency:duplicate:skipped:<type>` log+counter + poison `3→quarantine 24h` excludes `200`/`404`). No new business table except the admin requeue endpoint (no schema change beyond optional `NotificationLog` unique), no `Idempotency-Key` header, no `client.emit` inside `dataSource.transaction`, `synchronize:false`, 8 SCs with real PG + real Redis `--runInBand` proofs (`stock`/`reservedAmount` single delta, `EmailProvider.send` `1` not `2`).

## Technical Context

**Language/Version**: TypeScript 5.7.3 / Node 20, NestJS 11  
**Primary Dependencies**: `@nestjs/typeorm` 11 + `typeorm` 1.1 + `pg` 8.22, `@nestjs/bullmq` 11 + `bullmq` 5 + `ioredis` 5.11 (shared `REDIS_URL`), `@nestjs/microservices` `Transport.RMQ` (`ClientProxy NOTIFICATION_SERVICE`), `@nestjs/cache-manager` + `@keyv/redis` (`CACHE_MANAGER` `SET NX`/`INCR`), `@nestjs/config` + `ConfigService`, `@nestjs/jwt` + `passport-jwt` + `bcrypt`, `class-validator`/`class-transformer`, `Jest`+`ts-jest`+`supertest`, existing `OutboxModule` (`OutboxEvent` `OutboxStatus` `FOR UPDATE SKIP LOCKED`), `ReservationTransitionBuilder`. No new dep beyond optional `NotificationLog` entity + `PATCH requeue` controller.  
**Storage**: PostgreSQL 17 via TypeORM (`synchronize:false`, migration `17559xxxxxx-CreateOutboxEvent` already authoritative — Phase 12 adds **no** new migration except optional `NotificationLog` `eventId @Unique`; `Inventory` `CHECK`s `stock>=0` `reservedAmount>=0` `reservedAmount<=stock`, `Reservation` composite `status,expiresAt` intact); Redis 8 ephemeral for `notification:send:*` `SET NX EX 24h` + `idempotency:duplicate:skipped:<type>` `INCR EX 86400` + `expiration:tick:lock` `SET NX EX 30` + `expiration:poison:count/quarantine EX 86400` + `rl:*`; RabbitMQ 4 durable `notification_queue` (no new queue).  
**Testing**: Jest unit (mocked `DataSource`/`EntityManager` + `CACHE_MANAGER` mock `set NX`/`incr` + `EmailProvider` mock + `ClientProxy` mock) + integration real PG `FOR UPDATE` + real Redis `FLUSHDB` (`--runInBand`, `EXPLAIN`) + E2E `supertest` `register→cart→checkout→expire/complete duplicate 200` `GET /admin/outbox/:id/requeue` Admin 403/404; `npm run test`, `npm run build`, `npm run lint`, `npm run test:e2e`.  
**Target Platform**: Linux server (NestJS HTTP via `docker-compose.yml`: postgres, redis, rabbitmq) — same as Phases 1-11, no frontend.  
**Project Type**: Modular monolithic backend — REST `reservation`/`order`/`outbox`/`notifications` + existing `auth`/`cart`/`products`/`inventory`; idempotency is cross-cutting hardening inside existing `DataSource.transaction` guards, not a new bounded context.  
**Performance Goals**: Idempotent guard `if status != RESERVED → return 200` adds <1ms (single `SELECT FOR UPDATE` already needed); Redis `SET NX`/`INCR` p95 <2ms (no `FOR UPDATE` extension); second `expire`/`complete` `200` response p95 <10ms; `PATCH /admin/outbox/:id/requeue` `UPDATE ... WHERE status='FAILED'` p95 <5ms; bulk `sendBulk` re-scan `10` users `SET NX` batch <20ms; `429`/`400` → zero `OutboxEvent` rows zero dedup cost.  
**Constraints**: `synchronize:false`; PG authoritative (constitution I) — `OutboxEvent.id` is dedup key, not Redis; `FOR UPDATE` ordering `Reservation → sorted Inventories → Order` deterministic to avoid deadlock; `synchronize` never re-enabled; `ValidationPipe` `whitelist/forbidNonWhitelisted` still rejects unknown fields before `200` idempotent; `AllExceptionsFilter` serializes `200`/`409`/`404`; `Logger` only (no `console.log`); `ConfigService` for `OUTBOX_*` `EXPIRATION_*` `idempotency` TTLs; `status` single-winner via `FOR UPDATE` not `optimistic_version`.  
**Scale/Scope**: Touches `src/modules/reservation/reservation.service.ts` (`cancel/expire` `200` standardized + poison exclusion), `reservation-expiration.service.ts` (poison `200` exclude + `INCR` counter), `reservation-expiration.processor.ts` (tick `SET NX`), `src/modules/order/order-completion.service.ts` (`COMPLETED→COMPLETED 200` `0` delta `INCR`), `src/modules/outbox/outbox.service.ts`/`outbox.publisher.ts` (retain `FAILED` + `PATCH requeue`), `src/modules/notifications/notifications.worker.ts` (`SET NX` + `NotificationLog` + `INCR`), `src/modules/outbox/outbox.controller.ts` **new** (admin requeue), optional `src/modules/notifications/entities/notification-log.entity.ts`; 0 business semantic changes (only hardening guards), 8 SCs map to `SC-001..008` proofs.

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-check after Phase 1 design.*

| Principle | Status | Evidence |
|-----------|--------|----------|
| **I. PostgreSQL is source of truth** | ✅ PASS | `Reservation.status`/`Order.status` guards inside `FOR UPDATE` transaction are authoritative; Redis `SET NX` is dedup cache only (fallback `NotificationLog eventId @Unique` PG); `FLUSHDB` purges Redis but `PG` `RESERVED→EXPIRED` single delta remains; `OutboxEvent.id` is dedup key persisted in PG. |
| **II. Modular monolith — no premature microservices** | ✅ PASS | Single Nest process augmentation; no new service/process; `OutboxModule` already exists, `NotificationLog` lives in `NotificationsModule`, `PATCH /admin/outbox/:id/requeue` lives in `OutboxModule`; no second `DataSource`/`ClientProxy`/`ioredis` connection. |
| **III. Inventory/Reservation separate domains, explicit lifecycle** | ✅ PASS | No domain change: `Product` no `stock`, `Inventory available` derived `CHECK`, `Reservation RESERVED→EXPIRED/COMPLETED/CANCELLED` one-way, `Order PENDING→COMPLETED/CANCELLED/FAILED`; second same-transition now `200` idempotent not `409`, cross-transition `COMPLETED→EXPIRED` remains `409`; `reservedAmount<=stock` holds after dedup fix. |
| **IV. Concurrency safety at DB level (no overselling)** | ✅ PASS | Guards are `FOR UPDATE` sorted ids + `available = stock - reservedAmount` inside same transaction; second attempt sees `status != RESERVED` before any `UPDATE Inventory`, so `reservedAmount` decremented exactly once even under `Promise.all([expire,expire])`; `SKIP LOCKED` not needed for business (only outbox), publisher stays `SKIP LOCKED`. |
| **V. Module boundaries, service-only collaboration** | ✅ PASS | `ReservationService` owns `expire/cancel` guards, `OrderCompletionService` owns `complete` guard, `NotificationWorker` injects `CACHE_MANAGER` not `@InjectRepository(Inventory)`; `OutboxModule` exports `OutboxService`; `Patch requeue` controller thin delegates to `OutboxService.requeue(manager, id)`. No cross-module `@InjectRepository` of another entity beyond `NotificationLog` inside its module. |
| **VI. Spec-driven development** | ✅ PASS | Spec `spec.md` + 5 clarifications Session 2026-09-23 (`PATCH requeue` B, `200` standardized A, poison excludes `200` A, bulk re-scan A, log+counter B) done before plan; no future phase (Email 18/Payment 19) implemented; Phase 12 is hardening, not new business. |
| **VII. Tests mandatory, DB-backed for consistency** | ✅ PASS | Integration real PG `FOR UPDATE` + real Redis `SET NX` + `INCR` with `FLUSHDB` `--runInBand` + `EXPLAIN`; unit mocks `CACHE_MANAGER` `INCR`; E2E `supertest` duplicate `POST /reservations/:id/expire` `200` `reserved 0` + duplicate `POST /order/:id/complete` `200` `stock 8` + `PATCH /admin/outbox/:id/requeue` `403`/`200`. DB for consistency not mocked. |
| **VIII. No invented APIs/payments/business rules** | ✅ PASS | `PATCH /admin/outbox/:id/requeue` is the **only** new route per spec Q1 B (Admin ops, not user contract); `INCR idempotency:duplicate:skipped:<type>` is observability not business; no `Payment`/`EmailVerificationToken`/`Idempotency-Key` header; `200` vs `409` standardization is per spec Q2, not invented business rule. |
| **IX. Documentation is part of work** | ✅ PASS | This plan + `research.md` (D1-D8), `data-model.md` (guards + dedup keys + requeue), `contracts/outbox-idempotency-contracts.md` (requeue + dedup + counter), `quickstart.md` (`psql` + duplicate `expire` + `SET NX` + `PATCH requeue`), `AGENTS.md` marker updated to this plan, `docs/architecture/reliability.md` + `docs/decisions/ADR-reliability-idempotency.md`. |

**Gate result**: **PASS** — no violations. Post-design re-check below remains **PASS** (idempotency is hardening `if status != RESERVED return 200` before `Inventory` write, not a new distributed invariant).

## Project Structure

### Documentation (this feature)

```text
specs/012-reliability-idempotency/
├── plan.md              # This file (/speckit.plan command output)
├── research.md          # Phase 0 output — decisions D1-D8 (200 vs 409, poison exclude, requeue Admin, bulk re-scan, log+counter, FOR UPDATE ordering, SET NX vs log unique, no Idempotency-Key)
├── data-model.md        # Phase 1 output — guards (Reservation/Order FOR UPDATE + status check), dedup keys (OutboxEvent.id + notification:send:* SET NX), NotificationLog optional, RetryPolicy config, requeue entity
├── quickstart.md        # Phase 1 output — setup .env OUTBOX_* EXPIRATION_*, docker-compose, manual duplicate expire → 200, duplicate notification SET NX, PATCH requeue, poison quarantine, tests
├── contracts/
│   └── outbox-idempotency-contracts.md # Phase 1 output — PATCH /admin/outbox/:id/requeue (Admin 200/404/403), notification dedup envelope (eventId version correlationId), INCR counter, bulk SET NX
├── checklists/
│   └── requirements.md  # Spec quality checklist (16/16 pass)
└── tasks.md             # Phase 2 output (/speckit.tasks — NOT created by /speckit.plan)
```

### Source Code (repository root)

```text
src/
├── modules/
│   ├── reservation/
│   │   ├── reservation.service.ts           # MODIFY — cancel/expire guard standardized to 200 idempotent (if status != RESERVED → 200 0 delta, Logger.log already terminal + INCR idempotency:duplicate:skipped:expiration, before sorted Inventories lock), Single-winner FOR UPDATE
│   │   ├── reservation-expiration.service.ts # MODIFY — per-candidate guard already, add poison exclusion (200/404 not counted), INCR counter on idempotent skip, keep poison quarantine 24h logic
│   │   ├── reservation-expiration.processor.ts # unchanged — @Processor reservation-expiration concurrency 1 repeat 30s + Redis SET NX expiration:tick:lock
│   │   ├── reservation-transition.builder.ts # verify — transitionWithInventoryInternal ordering Reservation → sorted Inventories → Order
│   │   └── reservation.controller.ts        # MODIFY — PATCH /reservations/:id/expire + cancel delegate to service, expect 200 on already terminal same-transition (Swagger 200), 409 only for conflicting
│   ├── order/
│   │   ├── order-completion.service.ts      # VERIFY/MODIFY — ensure COMPLETED→COMPLETED returns 200 0 delta before Inventory FOR UPDATE, add Logger.log + INCR idempotency:duplicate:skipped:complete on idempotent hit
│   │   ├── order.service.ts                 # unchanged (or minor helper for status check)
│   │   └── order.controller.ts              # verify — POST /order/:id/complete returns 200 idempotent (Swagger), pass correlationId
│   ├── outbox/
│   │   ├── entities/
│   │   │   └── outbox-event.entity.ts       # existing — OutboxEvent OutboxStatus (no schema change, FAILED retained)
│   │   ├── outbox.service.ts                # MODIFY — add requeue(manager, id): Promise<OutboxEvent> { SELECT FOR UPDATE WHERE id=:id AND status=FAILED → status=PENDING attempts=0 nextRetryAt=NOW() lastError=NULL } + INCR on requeue? + Logger
│   │   ├── outbox.publisher.ts              # unchanged — publishBatch already FOR UPDATE SKIP LOCKED, attempts nextRetryAt FAILED retained (no new logic)
│   │   ├── outbox.controller.ts             # NEW — OutboxAdminController @Controller('admin/outbox') @UseGuards(JwtGuard, RolesGuard) @Auth(UserRoles.Admin) PATCH ':id/requeue' → OutboxService.requeue + GET list optional
│   │   └── outbox.module.ts                 # MODIFY — import TypeOrmModule.forFeature([OutboxEvent]), controllers: [OutboxAdminController], exports: [OutboxService]
│   ├── notifications/
│   │   ├── notifications.worker.ts          # MODIFY — @EventPattern order.* reservation.expired guard: SET NX notification:send:<template>:<aggregate>:<userId> EX 24h else SET NX notification:processed:<eventId> → if 0 { Logger.log duplicate skipped + INCR idempotency:duplicate:skipped:notification + return } → EmailProvider.send → NotificationLog save → ACK
│   │   └── entities/
│   │       └── notification-log.entity.ts   # OPTIONAL NEW — NotificationLog {id, userId, template, aggregateId, eventId @Unique @Index, provider, messageId, sentAt} for fallback dedup + audit
│   └── inventory/
│       └── inventory.service.ts             # verify — decreaseStockForOrderMany/restoreStock still EntityManager-owned, not called outside guard
├── app.module.ts                        # MODIFY — import OutboxModule (already), ensure CacheModule global for SET NX/INCR
├── migration/                           # NO NEW MIGRATION required V1 (OutboxEvent already exists, NotificationLog optional if added)
├── .env/.env.example                    # verify — OUTBOX_* EXPIRATION_* already set, add optional IDEMPOTENCY_TTL=24h (already `notification:send` 86400)
└── docs/architecture/
    └── reliability.md / ADR-reliability-idempotency.md # MODIFY — Reservation FOR UPDATE → status check → 0 delta, notification SET NX + log+counter, outbox requeue Admin, poison excludes 200, bulk re-scan
```

**Structure Decision**: Single project (Option 1) — hardening inside existing `src/modules/reservation`, `order`, `outbox`, `notifications` with `FOR UPDATE` guards + Redis `SET NX`/`INCR` + admin requeue `OutboxAdminController`; no new top-level app, `synchronize:false`, single `DataSource`/`CACHE_MANAGER`/`ClientProxy` reuse per `AGENTS.md` module boundaries.

## Complexity Tracking

> Fill ONLY if Constitution Check has violations that must be justified

| Violation | Why Needed | Simpler Alternative Rejected Because |
|-----------|------------|-------------------------------------|
| — | — | — |

*No violations — all gates PASS. Idempotency is additive guard `if status != RESERVED return 200` before `Inventory` mutation + Redis `SET NX` dedup + `INCR` counter, not a new store for business truth.*

---

## Phase 0: Research (completed → research.md)

All `NEEDS CLARIFICATION` resolved (0 in Technical Context; 10 clarifications in spec §8: requeue B, 200 standardized A, poison exclude A, bulk re-scan A, log+counter B). Key decisions: D1 `200` vs `409` for same-transition idempotent, D2 poison `200`/`404` exclude, D3 `PATCH /admin/outbox/:id/requeue` Admin-only single-entity, D4 bulk re-scan `SET NX` vs cursor, D5 log+counter `INCR idempotency:duplicate:skipped:<type>`, D6 `FOR UPDATE` ordering `Reservation→sorted Inventories→Order`, D7 `SET NX` vs PG `NotificationLog` fallback, D8 no `Idempotency-Key` header. See `research.md` D1-D8 for rationale and alternatives.

## Phase 1: Design (completed)

- **Data model** → [data-model.md](./data-model.md): `Reservation`/`Order` `FOR UPDATE` guards `status==RESERVED/PENDING` else `200 0 delta`, `Inventory` `CHECK` backstop, `OutboxEvent` `FAILED` requeue `PATCH`, `Idempotency Redis Keys` `notification:send:*` `SET NX EX 24h` + `idempotency:duplicate:skipped:<type>` `INCR EX 86400`, optional `NotificationLog eventId @Unique`, `RetryPolicy` config.
- **Contracts** → [contracts/outbox-idempotency-contracts.md](./contracts/outbox-idempotency-contracts.md): `PATCH /admin/outbox/:id/requeue` (`@Auth(Admin)` `200`/`404`/`403`), notification envelope `eventId` `version` `correlationId`, `SET NX` dedup, `INCR` counter, bulk `SET NX` per user.
- **Quickstart** → [quickstart.md](./quickstart.md): `.env OUTBOX_* EXPIRATION_*`, `docker-compose up -d`, `npm run build`, `npm run migration:run`, manual `POST /reservations/:id/expire` twice `200` `reserved 0`, `POST /order/:id/complete` twice `200` `stock 8`, `PATCH /admin/outbox/:id/requeue` `Admin` `200`, poison `3→quarantine` then skip, `FLUSHDB` `SET NX` `INCR` tests.
- **Agent context** → `AGENTS.md` marker `<!-- SPECKIT START -->` … `<!-- SPECKIT END -->` updated to point to this plan (`specs/012-reliability-idempotency/plan.md`).

### Agent context update

`AGENTS.md` marker updated via script `update-agent-context.ps1` to this plan. Verify with `grep -n SPECKIT AGENTS.md`.

## Re-evaluated Constitution Check (post-design)

No new code or decisions in Phase 1 violate principles. Post-design gate remains **PASS** on all nine principles (same table as above). Idempotency hardening strengthens Principle IV (no overselling on retry) without making Redis authoritative; `PATCH requeue` is admin ops not business truth.

## Next Steps (Phase 2 — not in this command)

`/speckit.tasks` will break Phase 12 into ordered tasks (e.g.: 1) harden `ReservationService` `cancel`/`expire` `200` idempotent guard + `INCR` counter + unit `status EXPIRED 0 UPDATE`; 2) verify `OrderCompletionService` `COMPLETED→COMPLETED 200 0 delta` + `INCR`; 3) harden `ReservationExpirationService` poison excludes `200`/`404` + `INCR`; 4) harden `NotificationWorker` `SET NX` + `NotificationLog` `eventId Unique` + `INCR` log+counter; 5) add `OutboxAdminController` `PATCH /admin/outbox/:id/requeue` `@Auth(Admin)` `FOR UPDATE WHERE status=FAILED → PENDING` + `Swagger` + `403/404`; 6) concurrency `Promise.all([expire,expire])` `200+200` single `reserved-=qty` + `complete vs expire` single `stock-=qty` + `Notification duplicate SET NX 1 then 0` integration real PG `FLUSHDB`; 7) E2E `supertest` duplicate `expire` `200` `reserved 0` + duplicate `complete` `200` `stock 8` + Admin `PATCH requeue` `200` → `SENT`; 8) `quickstart` + `.env` + `docs/reliability.md`/`ADR` + `npm run lint/build/test -- --runInBand/test:e2e`).
