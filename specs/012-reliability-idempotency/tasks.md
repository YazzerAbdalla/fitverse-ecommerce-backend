---
description: "Task list for Reliability / Idempotency — Phase 12 implementation"
---

# Tasks: Reliability / Idempotency — Phase 12

**Input**: Design documents from `specs/012-reliability-idempotency/`
**Prerequisites**: plan.md, spec.md, research.md, data-model.md, contracts/outbox-idempotency-contracts.md, quickstart.md
**Branch**: `012-reliability-idempotency`
**Tests**: Included per FR-009 (unit mocked + integration real PG/Redis + E2E supertest --runInBand). Tests are REQUIRED for idempotency verification.

**Organization**: Tasks grouped by user story (P1 → P2) to enable independent implementation and testing. Foundational hardening of existing `OutboxEvent`/`Reservation` guards must complete before story-specific dedup/requeue.

## Phase 1: Setup (Shared Infrastructure)

**Purpose**: Verify tech stack and shared test infra for idempotency

- [X] T001 Verify Docker infra and shared config per quickstart.md in `docker-compose.yml` and `.env.example`
- [X] T002 [P] Verify existing `OutboxEvent` entity and migration `17559xxxxxx-CreateOutboxEvent` remain untouched in `src/modules/outbox/entities/outbox-event.entity.ts`
- [X] T003 [P] Verify `CACHE_MANAGER` (`@keyv/redis` createKeyv REDIS_URL) and `BullModule` shared `REDIS_URL` available in `src/app.module.ts`

---

## Phase 2: Foundational (Blocking Prerequisites)

**Purpose**: Core guard pattern and optional dedup audit that all stories depend on

**⚠️ CRITICAL**: No user story work can begin until this phase is complete

- [X] T004 [P] Create optional `NotificationLog` entity with `eventId @Unique` fallback dedup in `src/modules/notifications/entities/notification-log.entity.ts`
- [X] T005 [P] Ensure `ReservationTransitionBuilder` ordering `Reservation → sorted Inventories → Order` documented with JSDoc in `src/modules/reservation/reservation-transition.builder.ts`
- [X] T006 Create/verify `OutboxService.requeue` helper signature and `CACHE_MANAGER INCR` counter utility in `src/modules/outbox/outbox.service.ts` (stub for admin requeue and idempotency:duplicate:skipped:* )
- [X] T007 Configure `ConfigService` idempotency keys `IDEMPOTENCY_TTL=86400` and `OUTBOX_*`/`EXPIRATION_*` clamping in `src/modules/outbox/outbox.publisher.ts` and `src/modules/reservation/reservation-expiration.service.ts`

**Checkpoint**: Foundation ready — `FOR UPDATE` guards and dedup primitives available; user stories can now begin

---

## Phase 3: User Story 1 — Reservation Expiration Idempotent (Priority: P1) 🎯 MVP

**Goal**: Second `expire` on same `RESERVED` id `→ 200` `0` `reservedAmount` delta, never double-release

**Independent Test**: Integration real PG `Inventory stock10 reserved2` + `Reservation RESERVED qty2` → `expire` twice `supertest` sequential `200` `EXPIRED` both, `reserved 0` second `UPDATE 0`; concurrency `Promise.all([expire,expire])` single decrement. `npm run test -- --runInBand` `reservation.service.spec.ts` + `reservation.integration.spec.ts`

### Tests for User Story 1

- [X] T008 [P] [US1] Unit test expiration idempotent second `expire` returns `200` `0` `UPDATE Inventory` in `src/modules/reservation/test/reservation.service.spec.ts`
- [X] T009 [P] [US1] Integration test expiration double + concurrency `Promise.all([expire,expire])` single `reserved-=qty` with real PG `FOR UPDATE` in `src/modules/reservation/test/reservation-expiration.integration.spec.ts`
- [X] T010 [P] [US1] E2E `register→checkout→PATCH /reservations/:id/expire` twice `200` `GET /inventory reserved 0` in `test/app.e2e-spec.ts`

### Implementation for User Story 1

- [X] T011 [US1] Harden `ReservationService.cancel/expire` idempotent guard (`if status != 'RESERVED' → 200 + Logger.log already terminal + INCR idempotency:duplicate:skipped:expiration`) before `FOR UPDATE sorted Inventories` in `src/modules/reservation/reservation.service.ts`
- [X] T012 [US1] Update `ReservationController` Swagger `@ApiResponse 200 already terminal` and thin delegate to service in `src/modules/reservation/reservation.controller.ts`
- [X] T013 [US1] Ensure `ReservationExpirationService.processExpiredBatch` per-candidate guard delegates to `ReservationService` and logs `already terminal` in `src/modules/reservation/reservation-expiration.service.ts`

**Checkpoint**: US1 fully idempotent and testable independently — duplicate expire leaves `reserved 0`

---

## Phase 4: User Story 2 — Notification Jobs Idempotent (Priority: P1)

**Goal**: Duplicate `eventId` delivery skips `EmailProvider.send` via `SET NX` + `INCR` counter + optional `NotificationLog` unique

**Independent Test**: Unit mock `EmailProvider` `handle(eventId=abc)` twice → `send 1` not `2`; integration real Redis `SET NX notification:send:... EX 24h` `1` then `0` → skip; `INCR idempotency:duplicate:skipped:notification` `1` on second

### Tests for User Story 2

- [X] T014 [P] [US2] Unit test `NotificationWorker.handle` duplicate `eventId` → `send 0` `Logger duplicate skipped` + `INCR` in `src/modules/notifications/test/notifications.worker.spec.ts`
- [X] T015 [P] [US2] Integration test real Redis `SET NX notification:processed:<eventId> EX 24h` bulk `sendBulk` re-scan `10` → second retry `10` `Log` not `15` in `src/modules/notifications/test/notifications.integration.spec.ts`
- [X] T016 [P] [US2] Unit test bulk `sendBulk` re-scan full eligible with `SET NX` per user skips sent in `src/modules/notifications/notifications.worker.ts` (test helper)

### Implementation for User Story 2

- [X] T017 [US2] Implement `NotificationWorker` dedup guard `SET NX notification:processed:<eventId> EX 24h` else `notification:send:<template>:<aggregate>:<userId>` + `INCR idempotency:duplicate:skipped:notification` + `Logger.log duplicate` before `EmailProvider.send` in `src/modules/notifications/notifications.worker.ts`
- [X] T018 [US2] Implement bulk `sendBulk` re-scan full `SELECT WHERE marketingOptIn` + per-user `SET NX` skip logic per Q4 A in `src/modules/notifications/notifications.worker.ts`
- [X] T019 [P] [US2] Add `NotificationLog` fallback `INSERT ON CONFLICT (eventId) DO NOTHING` guard if entity exists in `src/modules/notifications/notifications.worker.ts`
- [X] T020 [US2] Inject `CACHE_MANAGER` and `Logger` with JSDoc and `// idempotent guard` comment in `src/modules/notifications/notifications.worker.ts`

**Checkpoint**: US2 duplicate `eventId` delivered twice → `EmailProvider.send` once, bulk re-scan skips sent

---

## Phase 5: User Story 3 — Duplicate Order Completion Idempotent (Priority: P1)

**Goal**: Second `POST /order/:id/complete` on `COMPLETED` → `200` `0` `stock` delta, zero duplicate `OutboxEvent`

**Independent Test**: Real PG `Order PENDING reserved2 stock10` → `complete` twice sequential `200` `COMPLETED` `stock 8` + concurrency `Promise.all([complete,complete])` single `stock-=qty` + `outbox count 1`

### Tests for User Story 3

- [X] T021 [P] [US3] Unit test `OrderCompletionService.complete` second `COMPLETED→COMPLETED` returns `200` `0` `UPDATE Inventory` + `INCR idempotency:duplicate:skipped:complete` in `src/modules/order/test/order-completion.service.spec.ts`
- [X] T022 [P] [US3] Integration test real PG duplicate `POST /order/:id/complete` twice `supertest` `200` `stock 8` `outbox 1` in `src/modules/order/test/order-completion.integration.spec.ts`
- [X] T023 [P] [US3] Concurrency test `Promise.all([complete,complete])` `FOR UPDATE Order` then `Reservation` then sorted `Inventories` single `stock-=qty` in `src/modules/order/test/order-completion.integration.spec.ts`

### Implementation for User Story 3

- [X] T024 [US3] Verify/harden `OrderCompletionService.complete` guard `if order.status == COMPLETED → return 200 + Logger.log + INCR idempotency:duplicate:skipped:complete` before `FOR UPDATE Reservation/Inventories` in `src/modules/order/order-completion.service.ts`
- [X] T025 [US3] Ensure `OrderController` `@ApiResponse 200 already COMPLETED idempotent` for `POST /order/:id/complete` in `src/modules/order/order.controller.ts`

**Checkpoint**: US3 second `complete` leaves `stock 8` unchanged, `OutboxEvent order.completed` count `1`

---

## Phase 6: User Story 4 — Duplicate Inventory Release Idempotent (Priority: P1)

**Goal**: `cancel` vs `expire` vs second `cancel` race → `reservedAmount` `2→0` exactly once

**Independent Test**: Real PG `RESERVED qty2 reserved2` → `cancel` then `expire` same `id` → second `200` `reserved 0`; concurrency `Promise.all([cancel,expire])` single decrement

### Tests for User Story 4

- [X] T026 [P] [US4] Integration test real PG `cancel` then `expire` same `id` second `200` `0` delta in `src/modules/reservation/test/reservation.integration.spec.ts`
- [X] T027 [P] [US4] Concurrency test `Promise.all([cancel,expire])` `FOR UPDATE Reservation` single `reserved-=qty` in `src/modules/reservation/test/reservation.integration.spec.ts`

### Implementation for User Story 4

- [X] T028 [US4] Harden `ReservationService.cancel` same guard as `expire` (`if status != RESERVED → 200` same-transition `0` delta + `INCR idempotency:duplicate:skipped:cancel`) in `src/modules/reservation/reservation.service.ts`
- [X] T029 [US4] Document cross-transition `CANCELLED→EXPIRED` `409` vs same-transition `200` with `// idempotent vs conflicting` comment in `src/modules/reservation/reservation.service.ts`

**Checkpoint**: US4 `reservedAmount` decremented exactly once regardless of `cancel`/`expire` order

---

## Phase 7: User Story 5 — Bounded Retry & Poison Exclusion (Priority: P2)

**Goal**: Transient `ECONNREFUSED`/`23514` retries `1s·2^n` cap `60s` max `5` → `FAILED` retained; `200`/`404` idempotent not counted toward poison `3→quarantine 24h`

**Independent Test**: Unit mock `OutboxPublisher.publishBatch` transient `5` times `1s 2s 4s 8s 16s` → `FAILED`; `expiration` `23514` `3` times → `quarantined`, `200` already terminal does not increment poison

### Tests for User Story 5

- [X] T030 [P] [US5] Unit test `OutboxPublisher` transient `ECONNREFUSED` attempts `1→5` `nextRetryAt +1s..+16s` → `FAILED` retained in `src/modules/outbox/test/outbox.publisher.spec.ts`
- [X] T031 [P] [US5] Unit test `ReservationExpirationService` poison excludes `200`/`404` only counts `23514`/`ETIMEDOUT`/`500` toward `3→quarantine` in `src/modules/reservation/test/reservation-expiration.service.spec.ts`
- [X] T032 [P] [US5] Integration test real PG `processExpiredBatch` `23514` `3` → `expiration:poison:quarantined` `24h` tick skipped in `src/modules/reservation/test/expiration-poison.integration.spec.ts`

### Implementation for User Story 5

- [X] T033 [US5] Implement poison exclusion logic `if status==EXPIRED|CANCELLED|COMPLETED 200 or 404 → return without INCR poison:count` in `src/modules/reservation/reservation-expiration.service.ts`
- [X] T034 [US5] Verify `OutboxPublisher` `lease 30s` reclaim `PROCESSING older than 30s` and `maxAttempts 5` retained `FAILED` not deleted in `src/modules/outbox/outbox.publisher.ts`
- [X] T035 [US5] Document retry layers `A Outbox pulisher / B expiration / C notifications / D business 200` with `// Retry Layer` comments in `src/modules/outbox/outbox.publisher.ts` and `src/modules/reservation/reservation-expiration.service.ts`

**Checkpoint**: US5 duplicate `200` does not poison-quarantine; transient `5` → `FAILED` retained

---

## Phase 8: User Story 6 — Operator Verify + Admin Requeue + Counter (Priority: P2)

**Goal**: `GET /admin/outbox?status=FAILED` + `PATCH /admin/outbox/:id/requeue` `@Auth(Admin)` `200` `PENDING` + `INCR` metric visible via `psql`/`GET`/`logs`

**Independent Test**: `supertest` `PATCH requeue` as `Customer` `403`, as `Admin` on `PENDING` `409`, on `FAILED` `200` → `GET` `PENDING` then publisher `SENT`; `INCR` counters `idempotency:duplicate:skipped:*` `1` after duplicate skips

### Tests for User Story 6

- [X] T036 [P] [US6] E2E `supertest` `PATCH /admin/outbox/:id/requeue` `403` non-Admin, `404` not found, `409` not FAILED, `200` Admin on FAILED → `PENDING` in `test/e2e/outbox-requeue.e2e-spec.ts`
- [X] T037 [P] [US6] Integration test `GET /admin/outbox?status=FAILED` paginated `createdAt DESC` Admin-only in `test/e2e/outbox-requeue.e2e-spec.ts`
- [X] T038 [P] [US6] Unit test `INCR idempotency:duplicate:skipped:*` called on each idempotent skip (`expiration`, `complete`, `notification`) mocked `CACHE_MANAGER.incr` in `src/modules/outbox/test/outbox.service.spec.ts`

### Implementation for User Story 6

- [X] T039 [US6] Implement `OutboxAdminController` `PATCH ':id/requeue'` `JwtGuard @Auth(Admin)` `FOR UPDATE WHERE status=FAILED → PENDING attempts=0 nextRetryAt=NOW()` `200` in `src/modules/outbox/outbox.controller.ts`
- [X] T040 [US6] Implement `GET /admin/outbox` list `?status,page,limit` paginated `createdAt DESC` `Admin` in `src/modules/outbox/outbox.controller.ts`
- [X] T041 [P] [US6] Register `OutboxAdminController` in `OutboxModule` `controllers` and export `OutboxService` in `src/modules/outbox/outbox.module.ts`
- [X] T042 [P] [US6] Add Swagger `@ApiOperation @ApiResponse 200/403/404/409` for `PATCH requeue` in `src/modules/outbox/outbox.controller.ts`
- [X] T043 [US6] Wire `CACHE_MANAGER INCR idempotency:duplicate:skipped:<type> EX 86400` on every idempotent skip path (expiration, complete, notification) in respective services (`reservation.service.ts`, `order-completion.service.ts`, `notifications.worker.ts`) per Q5 B

**Checkpoint**: US6 `Admin` can verify `FAILED` and requeue to `PENDING`, counters observable

---

## Phase 9: Polish & Cross-Cutting Concerns

**Purpose**: Docs, JSDoc, and quickstart validation

- [X] T044 [P] Add class-level `/** This service is responsible for ... */` and method `/** @param @returns @throws */` JSDoc + `// idempotent guard` / `// available = stock - reservedAmount` comments to all modified services in `src/modules/reservation/reservation.service.ts`, `src/modules/order/order-completion.service.ts`, `src/modules/outbox/outbox.service.ts`, `src/modules/notifications/notifications.worker.ts`
- [X] T045 [P] Update `docs/architecture/reliability.md` and `docs/decisions/ADR-reliability-idempotency.md` per plan.md decisions D1-D8 in `docs/architecture/reliability.md`
- [X] T046 Run `npm run lint`, `npm run build`, `npm run test -- --runInBand`, and E2E `PATCH requeue` + duplicate `expire`/`complete` validation per `specs/012-reliability-idempotency/quickstart.md`

---

## Dependencies & Execution Order

### Phase Dependencies
- **Setup (Phase 1)**: No dependencies — can start immediately
- **Foundational (Phase 2)**: Depends on Setup (Phase 1) — BLOCKS all stories
- **User Stories**: All depend on Foundational (Phase 2)
  - `US1` Expiration, `US2` Notification, `US3` Complete, `US4` Release are **P1** and can run in parallel once foundational done (they touch different modules: `reservation.service.ts` vs `notifications.worker.ts` vs `order-completion.service.ts`, but `US4` shares `reservation.service.ts` with `US1` — serialize `US4` after `US1` if same dev)
  - `US5` Retry/Poison and `US6` Requeue/Counter are **P2** and depend on `US1-US4` guards being in place (they observe counters on those paths)
- **Polish (Phase 9)**: Depends on all `US1-US6` complete

### User Story Dependencies
- **US1 (P1) Expiration**: No story dependencies after Foundational
- **US2 (P1) Notification**: Independent of US1 (different module `notifications.worker.ts`) — can run in parallel with US1
- **US3 (P1) Complete**: Independent of US1/US2 (module `order`) — can run in parallel
- **US4 (P1) Release**: Shares `reservation.service.ts` with US1 — run sequentially after US1 or coordinate file lock
- **US5 (P2) Retry/Poison**: Depends on US1 guards (poison exclusion needs `200` path)
- **US6 (P2) Requeue/Counter**: Depends on US5 (counter `INCR` needs duplicate paths from US1-US3)

### Within Each User Story
- Tests → Implementation → Integration
- Unit mocked `CACHE_MANAGER`/`DataSource` before integration real PG `FLUSHDB`

### Parallel Opportunities
- `T002`, `T003` parallel (Setup)
- `T004`, `T005` parallel (Foundational)
- Once Foundational done, `US1` (`T008-T013`), `US2` (`T014-T020`), `US3` (`T021-T025`) can run in parallel on different files (different owners)
- `T030-T032` parallel (US5 tests), `T036-T038` parallel (US6 tests)
- `T044`, `T045` parallel (Polish docs)

---

## Parallel Example: US1 Expiration

```bash
# Launch US1 tests together:
Task T008 "Unit test expiration idempotent" + T009 "Integration expiration double" + T010 "E2E duplicate expire"

# Launch US2 notification dedup in parallel with US1 (different files):
Task US2 T014-T017 in src/modules/notifications/  ||  Task US1 T011 in src/modules/reservation/
```

---

## Implementation Strategy

### MVP First (US1 Only)
1. Complete Phase 1 Setup + Phase 2 Foundational
2. Complete Phase 3 US1 Expiration idempotent (`200` same-transition, `INCR`)
3. **STOP and VALIDATE**: `POST /reservations/:id/expire` twice `200` `reserved 0` via `psql` + `npm run test -- --runInBand` `reservation.integration`
4. Deploy/demo if ready — core P0 `reservedAmount` double-release is now prevented

### Incremental Delivery
1. Foundational → `US1` Expiration → `US2` Notification dedup → `US3` Complete → `US4` Release → `US5` Poison → `US6` Requeue/Counter → Polish
2. Each story independently testable per **Independent Test** criteria in spec.md §2
3. Stories `US1-US3` can be delivered as `v0.1` (all P1 `reservedAmount`/`stock` hardening); `US5-US6` as `v0.2` (observability + ops)

### Parallel Team Strategy
- Developer A: `US1` Expiration + `US4` Release (same file `reservation.service.ts`)
- Developer B: `US2` Notification dedup (`notifications.worker.ts`)
- Developer C: `US3` Complete (`order-completion.service.ts`) + `US6` Requeue (`outbox.controller.ts`)
- After P1, converge on `US5` Poison + `Polish` together

---

## Notes
- `[P]` = different files, no dependency on incomplete tasks
- `[Story]` label maps to spec.md `US1-US6` for traceability
- Each story checkpoint is independentlyCompletable and testable via `quickstart.md` manual + `npm run test -- --runInBand`
- Verify `synchronize:false`, `FOR UPDATE` ordering, `Logger` only, `AllExceptionsFilter 200/409`
- Commit after each task or logical group

