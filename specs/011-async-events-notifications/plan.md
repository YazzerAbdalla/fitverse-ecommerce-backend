# Implementation Plan: Asynchronous Events — Transactional Outbox (Phase 11)

**Branch**: `011-async-events-notifications` | **Date**: 2026-09-23 | **Spec**: [spec.md](./spec.md)
**Input**: Feature specification from `/specs/011-async-events-notifications/spec.md` (Phase 11 Transactional Outbox refactor — `OutboxEvent` inside business `DataSource.transaction`, `OutboxPublisher` `FOR UPDATE SKIP LOCKED` batch 100 lease 30s exponential backoff, `FAILED` retained, at-least-once `version:1+correlationId` envelope, 11 clarifications Session 2026-09-23 including outbox supersede)

## Summary

Refactor Phase 11 from `publish-after-commit` (at-most-once, fail-open → lost event) to **Transactional Outbox** (`Business Transaction + OutboxEvent INSERT atomic → COMMIT → OutboxPublisher poll FOR UPDATE SKIP LOCKED batch 100 → RabbitMQ NOTIFICATION_SERVICE notification_queue` with lease 30s, `PENDING→PROCESSING→SENT` success or `attempts++ nextRetryAt base*2^n` cap 60s max 5 → `FAILED` retained, `OUTBOX_RETENTION_DAYS=30`, at-least-once, `payload {version:1, eventId==outbox.id, eventType, occurredAt, correlationId, ...}` PII-free lookup). Touch only `OutboxEvent` additive insert inside `OrderCheckoutService` (`order.created`), `OrderCompletionService` (`order.completed`), centralized `order.cancelled` (`reason:'user'|'failed'|'expired'`), `ReservationExpirationService` per-candidate (`reservation.expired [+ order.cancelled]`), new `OutboxService`/`OutboxPublisher` (`OutboxModule`), reuse `AppModule` `ClientsModule NOTIFICATION_SERVICE` + `BullModule` shared `REDIS_URL`, `NotificationWorker` at-least-once tolerant, no `client.emit` inside `manager`, 8 SCs with `SELECT outbox_event` proofs.

## Technical Context

**Language/Version**: TypeScript 5.7.3 / Node 20, NestJS 11  
**Primary Dependencies**: `@nestjs/typeorm` 11 + `typeorm` 1.1 + `pg` 8.22, `@nestjs/microservices` `Transport.RMQ` (`ClientProxy` `NOTIFICATION_SERVICE`), `@nestjs/bullmq` 11 + `bullmq` 5 + `ioredis` 5.11 (shared `REDIS_URL`), `@nestjs/config` + `ConfigService`, `@nestjs/jwt` + `passport-jwt` + `bcrypt`, `class-validator`/`class-transformer`, `Jest`+`ts-jest`+`supertest`, `@nestjs/cache-manager` + `@keyv/redis` existing. No new dep beyond `OutboxEvent` entity.  
**Storage**: PostgreSQL 17 via TypeORM (`synchronize:false`, migration `17559xxxxxx-CreateOutboxEvent` adds `outbox_event` `jsonb` + `OutboxStatus` enum + composite `status,nextRetryAt,createdAt` + `eventType`/`aggregateId`); Redis 8 ephemeral for BullMQ `reservation-expiration` + optional `outbox-publish` repeat + `notifications` consumer `attempts 3`; RabbitMQ 4 durable `notification_queue` fan-out (no second connection).  
**Testing**: Jest unit (mocked `DataSource`/`EntityManager` + `OutboxRepo` + `ClientProxy {emit:()=>of}`/`throwError` + `ConfigService` `OUTBOX_*` per FR-015) + integration real PG `FOR UPDATE SKIP LOCKED` + mocked `ClientProxy` + `FLUSHDB` for BullMQ (`--runInBand`, `EXPLAIN` index) + E2E `supertest` `register→cart→checkout→GET /outbox?aggregateId → SENT` & RMQ-down → `PENDING` retry; `npm run test`, `npm run build`, `npm run lint`, `npm run test:e2e`.  
**Target Platform**: Linux server (NestJS HTTP via `docker-compose.yml`: postgres, redis, rabbitmq) — same as Phases 1-10, no frontend.  
**Project Type**: Modular monolithic backend — REST `order`/`reservation`/`inventory` + existing `auth`/`cart`/`products` + new `outbox` module; `Transaction` ownership per service.  
**Performance Goals**: Outbox `INSERT` inside transaction p95 <5ms (jsonb insert, no I/O); publisher claim `FOR UPDATE SKIP LOCKED` batch 100 p95 <20ms, poll `1000ms` visibility <2s normal (checkout `201` not extended); `429`/`400` → zero `outbox_event` rows; lease `30s` >> `client.emit` latency (<100ms) so false reclaim rare; `FAILED` after `~31s` total backoff.  
**Constraints**: `synchronize:false`; PG authoritative (constitution I) — `outbox_event` is source for delivery, not business truth; `FOR UPDATE SKIP LOCKED` requires PG17; `payload` `jsonb` `CHECK version` + PII-free (`userId` only `email` via lookup `Q2`); `version:1` + `correlationId` from `X-Request-Id`/`randomUUID()` per `FR-001`; `available = stock - reservedAmount` never derived from outbox/RMQ, checkout `FOR UPDATE` stays untouched; `RateLimitGuard` outermost before `ValidationPipe` still `429` zero rows; `AllExceptionsFilter` never catches publisher.  
**Scale/Scope**: Touches `src/modules/outbox/**` (new 4 files + migration) + `src/modules/order/order-checkout.service.ts`, `order-completion.service.ts`, `reservation-expiration.service.ts`, `app.module.ts` (import `OutboxModule`), `.env/.env.example` `OUTBOX_*` 7 vars; 0 business semantic changes (only additive `INSERT`); 8 SCs map to 8+ outbox tests; `outbox_event` transient buffer retention `30d`.

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-check after Phase 1 design.*

| Principle | Status | Evidence |
|-----------|--------|----------|
| **I. PostgreSQL is source of truth** | ✅ PASS | `OutboxEvent` is PG table inside **same** `DataSource.transaction` as `Order`/`Reservation`/`Inventory` (FR-002/003/004/006, SC-001) — invariant *commit → PENDING row*. `outbox_event` is delivery buffer, not business truth; `Inventory.stock/reservedAmount`/`Order.status` never fed from RMQ/Redis. `FLUSHDB` purges Redis/BullMQ but not `outbox_event`; RMQ purge recoverable via publisher retry. |
| **II. Modular monolith — no premature microservices** | ✅ PASS | Single Nest process augmentation `OutboxModule` + `OutboxPublisher` reuse single `DataSource` + single `ClientProxy NOTIFICATION_SERVICE`; no new service/process, module exports `OutboxService` imported by `OrderModule`/`ReservationModule` only via DI. |
| **III. Inventory/Reservation separate domains, explicit lifecycle** | ✅ PASS | No domain change: `Product` no `stock`, `Inventory` `stock/reservedAmount` `CHECK`/`available` derived, `Reservation` `RESERVED→COMPLETED|EXPIRED|CANCELLED` explicit transitions (FR-006 verifies `already terminal → no event`); outbox is additive. |
| **IV. Concurrency safety at DB level (no overselling)** | ✅ PASS | Business transactions keep `FOR UPDATE` sorted `inventoryIds`, `available = stock - reservedAmount` inside transaction (FR-002). Publisher `FOR UPDATE SKIP LOCKED` is **separate** tik-tok (not inside business `FOR UPDATE`) so checkout `201` latency not extended; `SC-004` concurrent publishers `SKIP LOCKED` disjoint, not `get+set` race. |
| **V. Module boundaries, service-only collaboration** | ✅ PASS | `OutboxService` lives in `OutboxModule` `TypeOrmModule.forFeature([OutboxEvent])` `exports: [OutboxService]`; business services inject `OutboxService` (not `@InjectRepository(OutboxEvent)`); no cross-module repository leak; controllers thin. `NotificationWorker` never mutates domain. |
| **VI. Spec-driven development** | ✅ PASS | Spec `spec.md` + 11 clarifications Session 2026-09-23 (outbox atomic, RabbitMQ-only, PII lookup, `FAILED` retained, `version:1`, `correlationId`, outbox `BATCH_SIZE=100`/`lease 30s`/backoff `base 1s*2^n` max 5) done before plan; no future phase (Email Phase 18/Payment 19) implemented; outbox is Phase 11 deliverable. |
| **VII. Tests mandatory, DB-backed for consistency** | ✅ PASS | Integration real PG `FOR UPDATE SKIP LOCKED` + `EXPLAIN` index + transactional consistency `Order` & `OutboxEvent` same commit (FR-015, SC-001/004/005), unit mocks `ClientProxy` fail `ECONNREFUSED` → `attempts nextRetryAt`, E2E `supertest` `checkout→PENDING→SENT` & RMQ-down `PENDING` retry. DB for consistency not mocked. |
| **VIII. No invented APIs/payments/business rules** | ✅ PASS | No new public user routes beyond `OutboxEvent` internal buffer (optional `GET /admin/outbox`/`PATCH requeue` is admin ops, not user contract); `order.created|completed|cancelled|reservation.expired` are `docs/plan.md` §11 events, payloads `version:1` + `correlationId` are clarifications Q4/Q5, not new business state. |
| **IX. Documentation is part of work** | ✅ PASS | This plan + `research.md` (D1-D8), `data-model.md` (OutboxEvent lifecycle), `contracts/outbox-contracts.md` (envelopes + publisher/consumer + admin requeue), `quickstart.md` (`psql outbox_event` + RMQ-down + lease reclaim), `AGENTS.md` marker updated to this plan, `docs/architecture/events.md` + `docs/decisions/ADR-async-events.md`. |

**Gate result**: **PASS** — no violations. Post-design re-check below remains **PASS** (outbox is additive `INSERT` inside existing `FOR UPDATE` transaction, not a new distributed invariant).

## Project Structure

### Documentation (this feature)

```text
specs/011-async-events-notifications/
├── plan.md              # This file (/speckit.plan command output)
├── research.md          # Phase 0 output — decisions D1-D8 (SKIP LOCKED, lease 30s, batch 100, backoff 1s*2^n max 5, RMQ vs BullMQ, jsonb, envelope, no FK)
├── data-model.md        # Phase 1 output — OutboxEvent entity + OutboxStatus lifecycle + indexes + validation
├── quickstart.md        # Phase 1 output — setup .env OUTBOX_*, docker-compose, manual checkout→psql outbox_event→SENT, RMQ-down, expiration, lease reclaim, tests
├── contracts/
│   └── outbox-contracts.md # Phase 1 output — event envelopes order.created|completed|cancelled|reservation.expired (version:1+correlationId), publisher claim/publish/retry, consumer NotificationWorker, admin requeue
├── checklists/
│   └── requirements.md  # Spec quality checklist (16/16 pass after outbox refactor)
└── tasks.md             # Phase 2 output (/speckit.tasks — NOT created by /speckit.plan)
```

### Source Code (repository root)

```text
src/
├── modules/
│   ├── outbox/                          # NEW — transactional outbox
│   │   ├── entities/
│   │   │   └── outbox-event.entity.ts   # NEW — OutboxEvent (@Entity outbox_event @Index status,nextRetryAt,createdAt) + OutboxStatus enum, jsonb payload, attempts/nextRetryAt/lastError/processingStartedAt/createdAt/sentAt, JSDoc + // intent
│   │   ├── outbox.service.ts            # NEW — OutboxService.createEvent(manager, {eventType, aggregateType, aggregateId, payload}) generates eventId=uuid, payload.eventId, occurredAt=NOW(), status PENDING, attempts 0, nextRetryAt NOW(), manager.getRepository save
│   │   ├── outbox.publisher.ts          # NEW — OutboxPublisher (Injectable WorkerHost Logger) poll/publishBatch: claim PENDING/PROCESSING-lease-expired FOR UPDATE SKIP LOCKED batch 100, client.emit(eventType, payload) await lastValueFrom, SENT vs attempts++ nextRetryAt exponential cap 60s FAILED retained, ConfigService OUTBOX_* clamps
│   │   ├── outbox.module.ts             # NEW — OutboxModule TypeOrmModule.forFeature([OutboxEvent]) exports OutboxService, imports ConfigModule, optional ClientsModule NOTIFICATION_SERVICE forwardRef, BullModule.registerQueue outbox-publish if scheduled
│   │   └── test/
│   │       └── outbox.publisher.spec.ts # NEW — unit (mock DataSource/ClientProxy ConfigService) claim→PROCESSING→SENT, failed→attempts 1 nextRetryAt, max→FAILED retained, lease reclaim, SKIP LOCKED spy, duplicate
│   ├── order/
│   │   ├── order-checkout.service.ts    # MODIFY — inject OutboxService, inside dataSource.transaction after createForCheckout+clearCartForCheckout, OutboxService.createEvent(manager, {eventType:'order.created', aggregateType:'Order', aggregateId:order.id, payload:{version:1, eventType:'order.created', correlationId, ...}}), no client.emit
│   │   ├── order-completion.service.ts  # MODIFY — same inside manager after stock-=qty reserved-=qty, create order.completed (guard COMPLETED→COMPLETED no insert)
│   │   ├── order.service.ts             # MODIFY (or new order-cancellation.service.ts) — centralized cancel(manager, orderId, reason) inside manager, validate PENDING→CANCELLED|FAILED, release reservedAmount, create order.cancelled
│   │   ├── order.controller.ts          # MODIFY — extract X-Request-Id || X-Correlation-Id || randomUUID() as correlationId pass to service (or service generates), keep @Auth + ValidationPipe + RateLimitGuard outermost, Swagger async outbox note
│   │   └── order.module.ts              # MODIFY — import OutboxModule, keep DataSource
│   ├── reservation/
│   │   ├── reservation-expiration.service.ts # MODIFY — inject OutboxService, per-candidate inside DataSource.transaction after reservedAmount-=qty & Order PENDING→CANCELLED, create reservation.expired (aggregateType Reservation) + conditional order.cancelled (reason expired), no client.emit, keep poison/24h TTL for DB errors (outbox durability replaces lost-event fail-open)
│   │   ├── reservation-expiration.processor.ts # unchanged — @Processor reservation-expiration concurrency 1 repeat 30s/EXPIRATION_CRON, still calls processExpiredBatch (now inserts outbox, not emit)
│   │   └── reservation.module.ts        # MODIFY — import OutboxModule
│   ├── notifications/
│   │   └── notifications.worker.ts      # MODIFY / keep — @EventPattern order.created|completed|cancelled|reservation.expired, log notification received eventId+correlationId, no Inventory/Order mutation, at-least-once duplicate tolerant
│   └── users/                           # unchanged — lookup for future email
├── app.module.ts                        # MODIFY — import OutboxModule global or per Order/Reservation module, ClientsModule RMQ + BullModule shared REDIS_URL unchanged
├── data-source.ts                       # unchanged (synchronize:false)
├── migration/
│   └── 17559xxxxxx-CreateOutboxEvent.ts # NEW — CREATE TYPE outbox_status + TABLE outbox_event + composite status,nextRetryAt,createdAt + eventType + aggregateId + createdAt DESC + CHECK attempts>=0 + CHECK payload->>'version' IS NOT NULL
├── .env/.env.example                    # MODIFY — add OUTBOX_BATCH_SIZE=100 OUTBOX_POLL_INTERVAL_MS=1000 OUTBOX_PROCESSING_LEASE_MS=30000 OUTBOX_MAX_ATTEMPTS=5 OUTBOX_RETRY_BASE_MS=1000 OUTBOX_RETRY_MAX_MS=60000 OUTBOX_RETENTION_DAYS=30 plus existing RABBITMQ_URL REDIS_URL
└── docs/architecture/
    └── events.md / ADR-async-events.md  # MODIFY — Business Transaction → Outbox INSERT → COMMIT → OutboxPublisher SKIP LOCKED → RabbitMQ notification_queue → NotificationWorker, why PG not RMQ, at-least-once duplicate, lease, backoff, FAILED retained
```

**Structure Decision**: Single project (Option 1) — additive `src/modules/outbox/` (new bounded context `OutboxService`/`OutboxPublisher`) with atomic `INSERT` inside existing `dataSource.transaction` `FOR UPDATE` paths; no new top-level app, no `synchronize:true`, single `DataSource`/`ClientProxy` reuse per `AGENTS.md` module boundaries.

## Complexity Tracking

> Fill ONLY if Constitution Check has violations that must be justified

| Violation | Why Needed | Simpler Alternative Rejected Because |
|-----------|------------|-------------------------------------|
| — | — | — |

*No violations — all gates PASS. Outbox is an additive write inside existing transaction, not a new store for business truth.*

---

## Phase 0: Research (completed → research.md)

All `NEEDS CLARIFICATION` resolved (0 in Technical Context; 11 business clarifications §8). Key decisions: D1 `FOR UPDATE SKIP LOCKED` claim vs leader lock, D2 lease `30s` + poll `1s` + batch `100`, D3 backoff `base 1s*2^n` cap `60s` max `5` → `FAILED` retained `30d`, D4 RMQ fan-out vs BullMQ scheduling vs PG outbox durability, D5 `payload {version:1,eventId,eventType,occurredAt,correlationId}+userId` PII-free lookup, D6 no FK on `aggregateId` + composite `(status,nextRetryAt,createdAt)`, D7 persisted payload byte-equal, D8 no `client.emit` inside `manager`. See `research.md` D1-D8 for rationale and alternatives.

## Phase 1: Design (completed)

- **Data model** → [data-model.md](./data-model.md): `OutboxEvent` `id uuid eventId, eventType varchar, aggregateType varchar, aggregateId uuid @Index no FK, payload jsonb {version,eventId,eventType,occurredAt,correlationId,...} CHECK, status enum PENDING|PROCESSING|SENT|FAILED, attempts int, nextRetryAt, lastError 1000, processingStartedAt, createdAt, sentAt` + `OutboxStatus` lifecycle `PENDING→PROCESSING→SENT` / `PROCESSING→PENDING` retry → `FAILED` retained + indexes composite + `eventType`/`aggregateId`.
- **Contracts** → [contracts/outbox-contracts.md](./contracts/outbox-contracts.md): Envelopes `order.created|completed|cancelled|reservation.expired` (each `version:1+eventId+occurredAt+correlationId` + `orderId,userId,total,items,reservationId`), publisher claim `FOR UPDATE SKIP LOCKED`/`PROCESSING`→`SENT`/`attempts++ nextRetryAt`/`FAILED` retained, consumer `@EventPattern` idempotent no `Inventory` mutation, admin `GET /admin/outbox` + `PATCH requeue` ops.
- **Quickstart** → [quickstart.md](./quickstart.md): `.env OUTBOX_*`, `docker-compose up -d`, `npm run build`, `npm run migration:run`, manual `POST /order/checkout → psql SELECT outbox_event → SENT`, RMQ-down `PENDING attempts nextRetryAt`, expiration `reservation.expired+order.cancelled`, lease reclaim `PROCESSING -60s → reclaimed`, `429/400` zero rows, tests `--runInBand`.
- **Agent context** → `AGENTS.md` marker `<!-- SPECKIT START -->` … `<!-- SPECKIT END -->` updated to point to this plan (`specs/011-async-events-notifications/plan.md`).

### Agent context update

`AGENTS.md` marker updated via script `update-agent-context.ps1` to this plan. Verify with `grep -n SPECKIT AGENTS.md`.

## Re-evaluated Constitution Check (post-design)

No new code or decisions in Phase 1 violate principles. Post-design gate remains **PASS** on all nine principles (same table as above). Outbox durability strengthens Principle I without making RMQ/Redis authoritative; publisher `SKIP LOCKED` + `lease` keeps `FOR UPDATE` short and `RateLimitGuard` outermost.

## Next Steps (Phase 2 — not in this command)

`/speckit.tasks` will break Phase 11 outbox into ordered tasks (e.g.: 1) failing `OutboxEvent` entity + migration `17559xxxxxx` + `status,nextRetryAt,createdAt` `EXPLAIN`; 2) `OutboxService.createEvent(manager, ...)` unit + integration transactional consistency (`Order` & `OutboxEvent` same commit vs `409` zero rows); 3) refactor `OrderCheckoutService` checkout `order.created` atomic insert (no `client.emit`); 4) refactor `OrderCompletionService` `order.completed` + centralized `order.cancelled` + idempotent `COMPLETED→COMPLETED` no duplicate; 5) refactor `ReservationExpirationService` per-candidate `reservation.expired [+ order.cancelled]` atomic; 6) `OutboxPublisher` `publishBatch` claim `FOR UPDATE SKIP LOCKED` batch 100 lease 30s → `client.emit` persisted payload → `SENT/FAILED` exponential `1s*2^n` max 5 retained; 7) concurrent `SKIP LOCKED` disjoint + lease reclaim + RMQ-down `PENDING` retry; 8) `NotificationWorker` duplicate `eventId` idempotent + consumer `BullMQ` separate + ops `GET /admin/outbox` `PATCH requeue`; 9) contracts + quickstart + `.env OUTBOX_*` + Swagger + docs `events.md/ADR` + `npm run lint/build/test -- --runInBand/test:e2e`).

