---
description: "Task list for Transactional Outbox (Phase 11)"
---

# Tasks: Asynchronous Events — Transactional Outbox (Phase 11)

**Input**: Design documents from `/specs/011-async-events-notifications/`
**Prerequisites**: [plan.md](./plan.md) (Tech Context, Structure), [spec.md](./spec.md) (US1-US5), [research.md](./research.md) (D1-D8), [data-model.md](./data-model.md) (OutboxEvent), [contracts/outbox-contracts.md](./contracts/outbox-contracts.md), [quickstart.md](./quickstart.md)
**Branch**: `011-async-events-notifications` | **Date**: 2026-09-23

**Tests**: Included per `spec.md` FR-015 + `AGENTS.md` Testing Rules (unit mocked + integration real PG `FOR UPDATE SKIP LOCKED` + E2E `supertest`).

**Organization**: Tasks grouped by user story (Setup → Foundational → US1 P1 MVP → US2 P1 → US3 P1 → US4 P2 → US5 P2 → Polish) for independent delivery.

## Format: `[ID] [P?] [Story] Description`

- **[P]**: Can run in parallel (different files, no dependencies)
- **[Story]**: Which user story (`[US1]` etc.) — Setup/Foundational/Polish have no label
- Include exact file path

## Phase 1: Setup (Shared Infrastructure)

**Purpose**: Verify branch/env, shared config before any code.

- [x] T001 Verify branch `011-async-events-notifications` and `FEATURE_DIR` via `powershell .specify/scripts/powershell/check-prerequisites.ps1 -Json -PathsOnly` in `D:\Projects\mini-e-commerce`
- [x] T002 Add `OUTBOX_*` env placeholders to `.env.example` (`OUTBOX_BATCH_SIZE=100`, `OUTBOX_POLL_INTERVAL_MS=1000`, `OUTBOX_PROCESSING_LEASE_MS=30000`, `OUTBOX_MAX_ATTEMPTS=5`, `OUTBOX_RETRY_BASE_MS=1000`, `OUTBOX_RETRY_MAX_MS=60000`, `OUTBOX_RETENTION_DAYS=30`) in `.env.example:1`
- [x] T003 [P] Create `src/modules/outbox/` directory scaffold (`entities/`, `test/`) in `src/modules/outbox/`

---

## Phase 2: Foundational (Blocking Prerequisites)

**Purpose**: Core outbox storage that MUST complete before ANY user story. No business logic yet.

**⚠️ CRITICAL**: No user story work can begin until this phase is complete

- [x] T004 [P] Create `OutboxStatus` enum `PENDING|PROCESSING|SENT|FAILED` in `src/modules/outbox/entities/outbox-status.enum.ts`
- [x] T005 [P] Create `OutboxEvent` entity `outbox_event` (`id uuid PK`, `eventType varchar(64) @Index`, `aggregateType varchar(32)`, `aggregateId uuid @Index`, `payload jsonb CHECK version`, `status enum default PENDING`, `attempts int CHECK>=0`, `nextRetryAt timestamptz`, `lastError varchar(1000) nullable`, `processingStartedAt nullable`, `createdAt`, `sentAt`) with composite `(@Index(['status','nextRetryAt','createdAt']))` + `@Index(['eventType'])` + `@Index(['aggregateId'])` + JSDoc `/** This entity represents ... */` in `src/modules/outbox/entities/outbox-event.entity.ts` (per `data-model.md:248`)
- [x] T006 Create migration `17559xxxxxx-CreateOutboxEvent` (`CREATE TYPE outbox_status`, `CREATE TABLE outbox_event`, `idx_outbox_status_next_retry_at_created`, `idx_outbox_event_type`, `idx_outbox_aggregate_id`, `CHECK attempts>=0`, `CHECK payload->>'version' IS NOT NULL`) via `src/migration/17559xxxxxx-CreateOutboxEvent.ts` (`synchronize:false`, never edit prior migration)
- [x] T007 Create `OutboxModule` (`TypeOrmModule.forFeature([OutboxEvent])`, `exports: [OutboxService]`) in `src/modules/outbox/outbox.module.ts` (no `ClientProxy` yet, imports `ConfigModule`)
- [x] T008 Implement `OutboxService` (`createEvent(manager: EntityManager, {eventType, aggregateType, aggregateId, payload:{version, eventType, correlationId, ...}}): Promise<OutboxEvent>`) — generates `id=randomUUID()`, sets `payload.eventId=id`, `payload.occurredAt=NOW()`, `status=PENDING`, `attempts=0`, `nextRetryAt=NOW()`, `manager.getRepository(OutboxEvent).save` in `src/modules/outbox/outbox.service.ts` (thin, `Logger`, JSDoc `/** @param @returns @throws */` per `AGENTS.md` §3)
- [x] T009 Wire `OutboxModule` into `src/app.module.ts` (global or import) and verify `npm run build` passes in `src/app.module.ts:22`
- [x] T010 Run `npm run migration:run` against dockerized PG and verify `EXPLAIN SELECT * FROM outbox_event WHERE status='PENDING' AND nextRetryAt<=NOW() ORDER BY createdAt LIMIT 100 FOR UPDATE SKIP LOCKED` uses `idx_outbox_status_next_retry_at_created` in `src/data-source.ts`

**Checkpoint**: Foundation ready — `OutboxEvent` table migrated, `OutboxService` injectable, user stories can begin in parallel

---

## Phase 3: User Story 1 — Checkout Atomically Creates Order + OutboxEvent and Survives RMQ Outage (Priority: P1) 🎯 MVP

**Goal**: `POST /order/checkout` inside one `DataSource.transaction` locks sorted `Inventory FOR UPDATE`, checks `available`, bumps `reservedAmount`, creates `Order PENDING` + `OrderItem`s + `Reservation RESERVED` + `OutboxEvent order.created PENDING {version:1, eventId==id, occurredAt, correlationId}` via same `EntityManager`; no `client.emit`; `RABBITMQ_URL` down still `201`, zero rows on `400/409`.

**Independent Test**: `curl POST /order/checkout → 201` + `psql SELECT OutboxEvent WHERE aggregateId=:orderId AND eventType='order.created' status PENDING` + `409` rollback → zero rows + `RABBITMQ_URL` absent → `PENDING` retained.

### Tests for US1 (write FIRST, ensure FAIL)

- [x] T011 [P] [US1] Unit test: `OutboxService.createEvent` sets `eventId==id`, `version:1`, `correlationId` via `manager` mock in `src/modules/outbox/test/outbox.service.spec.ts`
- [x] T012 [P] [US1] Integration test: real PG `POST /order/checkout` → `Order PENDING` + `OutboxEvent PENDING` same commit, `payload.eventId==id` `payload.correlationId` present, `client.emit` 0 inside transaction, `409` insufficient → zero rows in `src/modules/order/test/checkout-outbox.integration.spec.ts`
- [x] T013 [P] [US1] Integration test: mocked `RABBITMQ_URL` empty / `client` absent → `201` + `OutboxEvent PENDING` retained, not deleted, `GET /order/:id` `PENDING` in `src/modules/order/test/checkout-outbox-rabbitmq-down.integration.spec.ts`

### Implementation for US1

- [x] T014 [P] [US1] Update `src/modules/order/order.module.ts` to import `OutboxModule` (so `OrderCheckoutService` can inject `OutboxService`)
- [x] T015 [US1] Refactor `src/modules/order/order-checkout.service.ts:42` — inject `OutboxService` + `ConfigService`, after `createForCheckout`+`clearCartForCheckout` inside `manager` block call `outboxService.createEvent(manager, {eventType:'order.created', aggregateType:'Order', aggregateId:savedOrder.id, payload:{version:1, eventType:'order.created', correlationId, orderId:savedOrder.id, userId, total, currency:'usd', items:checkoutItems, reservationId:reservation.id, expiresAt, createdAt}})` before `return`, add `// OutboxEvent INSERT inside same transaction — no client.emit` + method JSDoc + correlationId extraction from controller
- [x] T016 [US1] Update `src/modules/order/order.controller.ts` to extract `correlationId` (`req.headers['x-request-id'] || req.headers['x-correlation-id'] || randomUUID()`) and pass to `checkout(userId, correlationId?)` (or let service generate), keep `@Auth()` + `ValidationPipe` + `RateLimitGuard` outermost, Swagger note `Async: order.created via outbox` in `src/modules/order/order.controller.ts`
- [x] T017 [US1] Verify none-broker coupling: `grep -n client.emit src/modules/order/order-checkout.service.ts` is 0 and business latency < publisher poll in `src/modules/order/order-checkout.service.ts:44`

**Checkpoint**: US1 MVP — `register→cart→checkout→SELECT OutboxEvent PENDING` independently verifiable via `quickstart.md` steps 1-5

---

## Phase 4: User Story 2 — Order Completion/Cancellation & Expiration Atomically Create One or Two Events (Priority: P1)

**Goal**: `PENDING→COMPLETED` same transaction inserts `order.completed PENDING`; centralized `PENDING→CANCELLED|FAILED` inserts `order.cancelled {reason}`; expiration per-candidate `RESERVED→EXPIRED` `reserved-=qty` (+ optional `PENDING→CANCELLED`) inserts `reservation.expired` + conditional `order.cancelled {reason:'expired'}` atomically, only on actual transition, idempotent `COMPLETED→COMPLETED` inserts none.

**Independent Test**: `POST /order/:id/complete → 200 COMPLETED` + `SELECT order.completed PENDING` + expiration batch `2 RESERVED (1 with order) → 2 reservation.expired +1 order.cancelled` + duplicate tick zero rows.

### Tests for US2

- [x] T018 [P] [US2] Unit test: `OrderCompletionService.complete(manager, ...)` spy `manager.getRepository(OutboxEvent).save` called with `order.completed {version:1, correlationId}` inside transaction, throw → zero in `src/modules/order/order-completion.service.spec.ts`
- [x] T019 [P] [US2] Integration test: `POST /order/:id/complete` idempotent `COMPLETED→COMPLETED` → no duplicate `order.completed` outbox row in `src/modules/order/test/completion-outbox.integration.spec.ts`
- [x] T020 [P] [US2] Integration test: `ReservationExpirationService.processExpiredBatch` with 2 expired `RESERVED (order+no-order)` → counts `2 reservation.expired +1 order.cancelled`, duplicate batch 0 new, `COMPLETED` order no second `order.cancelled` in `src/modules/reservation/test/expiration-outbox.integration.spec.ts`

### Implementation for US2

- [x] T021 [P] [US2] Extend `src/modules/order/order.module.ts` imports `OutboxModule` for `OrderCompletionService` and centralized cancel service
- [x] T022 [US2] Refactor `src/modules/order/order-completion.service.ts:88` — inject `OutboxService`, inside manager after `stock-=qty reserved-=qty` before saving `Order COMPLETED`+`Reservation COMPLETED` call `outboxService.createEvent(manager, {eventType:'order.completed', aggregateType:'Order', aggregateId:orderId, payload:{version:1, eventType:'order.completed', correlationId, ...}})`, guard `if (currentOrder.status===COMPLETED) return` without insert in `src/modules/order/order-completion.service.ts:114`
- [x] T023 [US2] Implement centralized `OrderCancellationService` (or extend `OrderService`) `cancel(manager, orderId, reason:'user'|'failed'|'expired', correlationId, requestingUserId?, role?)` locking `Order FOR UPDATE`, validating `PENDING→CANCELLED|FAILED`, `reservedAmount-=qty` (release), `OutboxEvent order.cancelled {reason, correlationId}` in `src/modules/order/order-cancellation.service.ts` (avoid duplicating across call sites, `docs/plan.md` Phase 8)
- [x] T024 [US2] Refactor `src/modules/reservation/reservation-expiration.service.ts:184` — inject `OutboxService`, per-candidate `BEGIN lock Reservation FOR UPDATE verify RESERVED && expiresAt<=NOW() → FOR UPDATE sorted Inventories reservedAmount-=qty status=EXPIRED → if orderId lock Order PENDING→CANCELLED → INSERT reservation.expired (aggregateType Reservation) → conditional INSERT order.cancelled (reason:'expired') COMMIT` inside `DataSource.transaction` per id, no `client.emit`, keep poison/24h TTL for DB errors only in `src/modules/reservation/reservation-expiration.service.ts:199`
- [x] T025 [US2] Ensure cancellation no-stock-add: verify `stock+=` not used (`V1 release reserved only` per `spec.md FR-005`) in `src/modules/order/order-cancellation.service.ts`

**Checkpoint**: US2 — `POST /order/:id/complete` + `expiration` atomically produce `reservation.expired` + `order.cancelled` per transition

---

## Phase 5: User Story 3 — OutboxPublisher Claims, Publishes, Retries with Lease and Never Blocks Business (Priority: P1)

**Goal**: Background `OutboxPublisher` (`FOR UPDATE SKIP LOCKED` batch 100 `status=PENDING OR (PROCESSING AND processingStartedAt < NOW()-30s)` `nextRetryAt<=NOW()` ordered `createdAt ASC` → `PROCESSING processingStartedAt=NOW()` → `client.emit(persisted payload)` → `SENT sentAt` or `attempts++ lastError nextRetryAt=+base*2^n` cap 60s → `FAILED` retained after 5, concurrent publishers disjoint, never inside business transaction, `RABBITMQ_URL` empty → `PENDING` retained.

**Independent Test**: 3 `PENDING` → `poll()` `FOR UPDATE SKIP LOCKED` → `PROCESSING` → `client.emit` 3× → `SENT` + 2 failures → `attempts 1→2 nextRetryAt +1s +2s` + `FAILED` after 5 + lease reclaim `PROCESSING -60s`.

### Tests for US3

- [x] T026 [P] [US3] Unit test: `OutboxPublisher.publishBatch(100)` claim `SET Lock SKIP LOCKED` → `PROCESSING`, `emit` with `payload.eventId==id`, `SENT` success in `src/modules/outbox/test/outbox.publisher.spec.ts`
- [x] T027 [P] [US3] Unit test: `OutboxPublisher` failed once → `attempts 1 lastError truncated 1000 nextRetryAt≈NOW()+1s status PENDING`, not `FAILED` in `src/modules/outbox/test/outbox.publisher.retry.spec.ts`
- [x] T028 [P] [US3] Unit test: max retries `5 → FAILED` retained not deleted in `src/modules/outbox/test/outbox.publisher.max-retries.spec.ts`
- [x] T029 [P] [US3] Unit test: lease reclaim `PROCESSING processingStartedAt NOW()-60s` reclaimed by next `poll()` + concurrent `2 publishers SKIP LOCKED disjoint` in `src/modules/outbox/test/outbox.publisher.lease-concurrency.spec.ts`
- [x] T030 [P] [US3] Integration test: real PG `10 PENDING poll(100) → 10 FOR UPDATE SKIP LOCKED → PROCESSING→SENT` via mocked `ClientProxy` in `src/modules/outbox/test/outbox.publisher.integration.spec.ts`
- [x] T031 [P] [US3] Integration test: `RABBITMQ_URL` empty → publisher logs `RABBITMQ_URL not set, skipping publish` → rows stay `PENDING` in `src/modules/outbox/test/outbox.publisher.no-rmq.integration.spec.ts`

### Implementation for US3

- [x] T032 [US3] Implement `OutboxPublisher` (`Injectable Logger WorkerHost`, `@Processor('outbox-publish')` or `setInterval` `1000ms` `concurrency 1`, `DataSource` + `@Optional() @Inject('NOTIFICATION_SERVICE') client: ClientProxy` + `ConfigService`) with methods `poll(batchSize?)`, `publishBatch(batchSize)` in `src/modules/outbox/outbox.publisher.ts` — eligibility `(PENDING nextRetryAt<=NOW()) OR (PROCESSING lease expired)`, claim `QueryBuilder.setLock('pessimistic_write').setOnLocked('skip_locked')`, update `PROCESSING`, `await lastValueFrom(client.emit(eventType, payload))` or `subscribe` promise wrapper, handle `RABBITMQ_URL` empty, success `SENT sentAt lastError NULL`, failure `attempts++` `nextRetryAt = NOW()+min(60000,1000*2^(attempts-1))` `PENDING` until `5→FAILED`
- [x] T033 [US3] Register publisher in `src/modules/outbox/outbox.module.ts` (add `BullModule.registerQueue({name:'outbox-publish'})` if using BullMQ repeat `every 1000`, or `ScheduleModule`/`setInterval`, keep single `DataSource`/`ClientProxy` reuse)
- [x] T034 [US3] Add config clamping in `src/modules/outbox/outbox.publisher.ts` (`OUTBOX_BATCH_SIZE 1..200`, `OUTBOX_PROCESSING_LEASE_MS 1000..120000`, `OUTBOX_MAX_ATTEMPTS 1..10`, `OUTBOX_RETRY_BASE_MS 100..10000`, `OUTBOX_RETRY_MAX_MS 1000..120000` with `Logger.warn fallback`) per `AGENTS.md` §3

**Checkpoint**: US3 — `OutboxPublisher.poll()` `FOR UPDATE SKIP LOCKED` 10 → `SENT`, `ECONNREFUSED` → `PENDING attempts nextRetryAt`, `FAILED` retained

---

## Phase 6: User Story 4 — Consumers At-Least-Once Idempotent; BullMQ Distinct from RabbitMQ Retry (Priority: P2)

**Goal**: Existing `NotificationWorker` (`@EventPattern order.created|completed|cancelled|reservation.expired`) receives envelope from `OutboxPublisher` (at-least-once duplicate `eventId` possible `publish→RMQ accept→crash before SENT→retry`) and handles with `Logger.log notification received eventType eventId correlationId` **without** mutating `Inventory`/`Order`/`Reservation`; duplicate `eventId` twice → no `Inventory` mutation; `BullMQ reservation-expiration` vs `outbox-publish` vs `notifications` consumer `attempts 3` are separate layers.

**Independent Test**: `NotificationWorker.handle` same `eventId` twice → `Inventory.update` 0, log duplicate.

### Tests for US4

- [x] T035 [P] [US4] Unit test: `NotificationWorker.handle` duplicate `eventId` `order.completed` twice → `Inventory.update` spy 0, log `duplicate eventId already processed` in `src/modules/notifications/test/notifications.worker.idempotency.spec.ts`
- [x] T036 [P] [US4] Unit test: publisher already `SENT` vs consumer `SMTP timeout` `BullMQ notifications attempts 3` independent (outbox row not reset to `PENDING`) in `src/modules/outbox/test/outbox-consumer-separation.spec.ts`

### Implementation for US4

- [x] T037 [US4] Update `src/modules/notifications/notifications.worker.ts` — ensure `@EventPattern('order.created')|('order.completed')|('order.cancelled')|('reservation.expired')` handler logs `notification received <eventType> eventId=<eventId> correlationId=<id>` (PII-free, no `payload` verbatim), performs **no** `Inventory.stock/reservedAmount` or `Order.status` mutation, add idempotency guard `// at-least-once duplicate eventId tolerated — log and return` in `src/modules/notifications/notifications.worker.ts` (keep `concurrency 5`, `BullModule queue notifications attempts 3` separate per `spec FR-012`)
- [x] T038 [US4] Document bridge (if `RabbitMQ → queue.add('notifications', envelope) → @Processor('notifications')` used) — add explicit `ACK after queue.add success` semantics comment, otherwise keep direct `@EventPattern` without bridge in `src/modules/notifications/notifications.worker.ts`

**Checkpoint**: US4 — duplicate `eventId` delivery leaves `stock` unchanged, consumer retries independent of publisher `maxAttempts 5`

---

## Phase 7: User Story 5 — Operators Verify Durability, Retry Health, No Transaction Holds RMQ (Priority: P2)

**Goal**: `npm run test -- --runInBand`, `npm run build`, Swagger lists `Async event: order.created via outbox`, `SELECT status count(*) FROM outbox_event GROUP BY status`, `EXPLAIN` uses composite index, `grep client.emit inside dataSource.transaction 0`, `FAILED` retained `30d`.

**Independent Test**: `psql SELECT ... GROUP BY status` + `EXPLAIN` index + timing `POST /order/checkout` < publisher interval.

### Tests for US5 (observability)

- [x] T039 [P] [US5] Integration test: time `POST /order/checkout 201` → `outbox_event PENDING nextRetryAt<=NOW()` < poll interval + `EXPLAIN` shows `idx_outbox_status_next_retry_at_created` in `src/modules/outbox/test/outbox.observability.integration.spec.ts`
- [x] T040 [P] [US5] E2E `supertest` full flow `register→login→cart→checkout→GET /outbox?aggregateId → PENDING → after poll SENT` + RMQ-down simulate `still 201 outbox PENDING retry` in `test/outbox.e2e-spec.ts`

### Implementation for US5

- [x] T041 [US5] Add admin ops (optional but documented): `GET /admin/outbox?status&eventType&page&limit` `200 {data,meta}` paginated `createdAt DESC` + `PATCH /admin/outbox/:id/requeue` `200` reset `PENDING attempts 0 nextRetryAt NOW()` for `FAILED` in `src/modules/outbox/outbox.controller.ts:1` (`@Auth(Admin)`), `@ApiResponse 200/404/409`, Swagger tag `outbox` (per `contracts/outbox-contracts.md:1.7`)
- [x] T042 [US5] Add nightly cleanup config (deferred timer but retained description): comment + `OUTBOX_RETENTION_DAYS` env usage in `src/modules/outbox/outbox.publisher.ts` or `src/modules/outbox/outbox-cleanup.service.ts` (`DELETE WHERE SENT sentAt< NOW-30d OR FAILED createdAt< NOW-30d`, not during publish) in `src/modules/outbox/outbox-cleanup.service.ts`
- [x] T043 [US5] Update `docs/architecture/events.md` and `docs/decisions/ADR-async-events.md` — auto-commit? Actually manually: document `Business→Outbox INSERT→Publisher SKIP LOCKED lease 30s batch 100→RabbitMQ notification_queue→NotificationWorker at-least-once`, `FAILED` retained, backoff formula, `RABBITMQ_URL` empty, PII lookup
- [x] T044 [US5] Update Swagger for `POST /order/checkout` and `POST /order/:id/complete` descriptions to `Async event: order.created|completed via transactional outbox (OutboxEvent PENDING→OutboxPublisher→RabbitMQ)` in `src/modules/order/order.controller.ts`

**Checkpoint**: US5 — operator queries `SELECT status,count(*) FROM outbox_event GROUP BY status` + docs + Swagger reflect outbox

---

## Phase 8: Polish & Cross-Cutting Concerns

**Purpose**: Cleanup, hardening, cross-story validation per `quickstart.md`.

- [x] T045 [P] Add `// Available stock excludes already-reserved units`, `// OutboxEvent INSERT inside same transaction — no client.emit`, `// PENDING→PROCESSING→SENT vs FAILED retained`, `// at-least-once duplicate eventId tolerated` intent comments for any multi-predicate `if` in modified services per `AGENTS.md` §3
- [x] T046 [P] Ensure class-level `/** This service is responsible for ... */` + method `/** @param @returns @throws */` on `OutboxService`, `OutboxPublisher`, `OrderCheckoutService`, `OrderCompletionService`, `OrderCancellationService`, `ReservationExpirationService`, `NotificationWorker`, `OutboxEvent` entity per `AGENTS.md` §3
- [x] T047 Run `quickstart.md` validation: `.env OUTBOX_*` + `docker-compose up -d` + `npm run build` + manual `POST /order/checkout → psql PENDING → SALE SENT` + `expiration reservation.expired+order.cancelled` + `lease reclaim -60s` + `429/400 zero rows` in `D:\Projects\mini-e-commerce\quickstart.md`
- [x] T048 [P] `npm run lint` fix, `npm run build` pass, `npm run test -- --runInBand` (≥24 suites including 8+ outbox unit/integration) + `npm run test:e2e` pass (`register→cart→checkout→outbox SENT→complete→SENT` + RMQ-down → `PENDING` retry) in `D:\Projects\mini-e-commerce`
- [x] T049 Remove `console.log` in `src/modules/auth/auth.service.ts` when touching auth (per `AGENTS.md` §3) + verify no `console.log` remains via `grep -r console.log src --include="*.ts"` in `src/modules/auth/auth.service.ts`
- [x] T050 [P] Verify `synchronize:false`, no committed migration edited, `grep -n client.emit src/modules/order src/modules/reservation` inside `dataSource.transaction` 0 hits in `D:\Projects\mini-e-commerce`

---

## Dependencies & Execution Order

### Phase Dependencies

- **Setup (Phase 1)**: No dependencies — can start immediately
- **Foundational (Phase 2)**: Depends on Setup — BLOCKS all user stories
- **User Stories (Phase 3+)**: All depend on Foundational
  - Can proceed in parallel if staffed (US1, US2, US3 share `OutboxService` but touch different services: checkout vs completion vs expiration vs publisher — mostly parallel after Foundational)
  - Or sequentially in priority P1→P2 (US1→US2→US3→US4→US5)
- **Polish (Phase 8)**: Depends on all desired stories

### User Story Dependencies

- **US1 (P1) Checkout atomic outbox**: Can start after Foundational — No dependencies on other stories
- **US2 (P1) Completion/cancellation/expiration atomics**: Can start after Foundational — May integrate with US1 (shares `Order` lifecycle) but independently testable via `manager` injection; expiration part independent of checkout
- **US3 (P1) Publisher claim/retry/lease**: Can start after Foundational (needs `OutboxEvent` table) — No dependency on US1/US2 at code level, but integration tests use US1/US2 rows as fixtures
- **US4 (P2) Consumer idempotency**: Depends on `NotificationWorker` existing — Can start after Foundational, but at-least-once proof needs US3 publisher producing duplicate
- **US5 (P2) Operator observability**: Depends on US1-US3 for `psql` counts and publisher health — Can start after Foundational logically, but full `EXPLAIN`/`quickstart` validation needs US1-US3 done

### Within Each User Story

- Tests MUST be written and FAIL before implementation (TDD per FR-015)
- Models before services (Foundational handles `OutboxEvent`)
- `OutboxService` before business services (Foundational provides it)
- Core `createEvent` before publisher `publishBatch`
- Story complete before next priority unless parallel

### Parallel Opportunities

- Setup T003 + Foundational T004/T005/T007 [P] different files — parallel
- US1 tests T011/T012/T013 [P] parallel — different files
- US2 tests T018/T019/T020 [P] parallel
- US3 tests T026-T031 [P] parallel (6 publisher specs different files)
- US4 tests T035/T036 [P] parallel
- US5 tests T039/T040 [P] parallel (observability + E2E)
- Cross-story parallel after Foundational: Developer A US1 (checkout), Developer B US2 (completion/expiration), Developer C US3 (publisher) — disjoint services `order-checkout.service.ts` vs `order-completion.service.ts` vs `outbox.publisher.ts`
- Polish T045/T046/T050 [P] parallel (lint vs docs vs grep)

---

## Parallel Example: User Story 1

```bash
# Launch US1 tests in parallel:
Task: "Unit test OutboxService.createEvent in src/modules/outbox/test/outbox.service.spec.ts"
Task: "Integration test checkout→OutboxEvent same commit in src/modules/order/test/checkout-outbox.integration.spec.ts"
Task: "Integration test RMQ-down retains PENDING in src/modules/order/test/checkout-outbox-rabbitmq-down.integration.spec.ts"

# Launch US3 publisher tests in parallel:
Task: "Unit claim→SENT in src/modules/outbox/test/outbox.publisher.spec.ts"
Task: "Unit failed→nextRetryAt in src/modules/outbox/test/outbox.publisher.retry.spec.ts"
Task: "Unit FAILED retained in src/modules/outbox/test/outbox.publisher.max-retries.spec.ts"
Task: "Unit lease reclaim + concurrent SKIP LOCKED in src/modules/outbox/test/outbox.publisher.lease-concurrency.spec.ts"
```

---

## Implementation Strategy

### MVP First (US1 Only)

1. Complete Setup (T001-T003) + Foundational (T004-T010) → `OutboxEvent` table + `OutboxService` + migration `EXPLAIN` verified
2. Complete US1 (T011-T017) → `POST /order/checkout` atomically creates `order.created` `PENDING` via `OutboxService` inside same `manager`, no `client.emit`
3. **STOP and VALIDATE**: `psql SELECT OutboxEvent WHERE eventType='order.created'` + `409` zero rows + `npm run test -- --runInBand src/modules/outbox src/modules/order` passes
4. Deploy/demo MVP — checkout durable without RabbitMQ (publisher not yet needed for MVP visibility but row exists)

### Incremental Delivery

1. Setup + Foundational → Foundation ready (T001-T010)
2. Add US1 → Test US1 → Deploy (MVP checkout outbox)
3. Add US2 → Test US2 → Deploy (completion/cancellation/expiration atomics, `reservation.expired+order.cancelled`)
4. Add US3 → Test US3 → Deploy (publisher `SKIP LOCKED` batch 100 → `SENT`, `FAILED` retained, RMQ-down retry)
5. Add US4 → Test US4 → Deploy (consumer at-least-once duplicate tolerant)
6. Add US5 → Test US5 → Deploy (operator `SELECT`, docs, Swagger, cleanup retention)
7. Polish → `npm run lint/build/test:e2e` → done

### Parallel Team Strategy

With multiple developers after Foundational:

1. Team completes Setup + Foundational together (T001-T010)
2. Once Foundation ready:
   - Developer A: US1 checkout (T011-T017) — `order-checkout.service.ts`
   - Developer B: US2 completion/cancellation/expiration (T018-T025) — `order-completion.service.ts`, `reservation-expiration.service.ts`
   - Developer C: US3 publisher (T026-T034) — `outbox.publisher.ts`, `outbox.module.ts`
3. Developer D/E: US4 consumer (T035-T038) + US5 ops (T039-T044) — `notifications.worker.ts`, `outbox.controller.ts`, docs
4. Sync at Phase 8 Polish (T045-T050) → `quickstart.md` validation + `npm run test:e2e`

---

## Notes

- [P] tasks = different files, no dependencies
- [Story] label maps task to user story for traceability
- Each user story independently completable and testable via `psql SELECT outbox_event WHERE aggregateId=:id`
- Verify tests fail before implementing (e.g., `T012` expects `OutboxEvent PENDING` before `T015` implements it)
- Commit after each task or logical group (`git add src/modules/outbox/entities/outbox-event.entity.ts && git commit -m "feat(outbox): add OutboxEvent entity"`)
- Stop at any checkpoint to validate story independently via `quickstart.md`
- Avoid: vague tasks, same file conflicts, cross-story dependencies that break independence; grep `client.emit` inside `dataSource.transaction` must stay 0
