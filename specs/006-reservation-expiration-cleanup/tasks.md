# Tasks: Reservation Expiration Cleanup (Phase 5)

**Input**: Design documents from `specs/006-reservation-expiration-cleanup/` (spec.md 3 user stories, plan.md, research.md D1-D8, data-model.md, contracts/reservation-expiration.md, quickstart.md)
**Prerequisites**: plan.md (required), spec.md (required), research.md, data-model.md, contracts/, quickstart.md
**Tests**: Included (spec FR-010 requires unit mocked + integration real-PG concurrency + batch + EXPLAIN + RabbitMQ mock) — tests FIRST then impl

## Format: `[ID] [P?] [Story] Description`

- **[P]**: Can run in parallel (different files, no dependencies)
- **[Story]**: Which user story this task belongs to (US1, US2, US3)

## Phase 1: Setup (Shared Infrastructure)

**Purpose**: Tooling, dependencies, env, module scaffolding that all stories share

- [X] T001 Install BullMQ dependencies in `package.json` (add `bullmq` + `@nestjs/bullmq` + `ioredis` if not already via CacheModule) and update `package-lock.json`
- [X] T002 [P] Add new env keys to `.env.example` and `.env` via `ConfigService` for `EXPIRATION_INTERVAL_MS=30000`, `EXPIRATION_BATCH_SIZE=10`, `EXPIRATION_ENABLED=true`, `EXPIRATION_MAX_RETRIES=3`, `REDIS_URL`, `RABBITMQ_URL`/`RABBITMQ_QUEUE`
- [X] T003 [P] Verify `BullModule` availability and RabbitMQ `NOTIFICATION_SERVICE` (`ClientsModule` Transport.RMQ) already wired in `src/app.module.ts` (plan.md Project Structure)
- [X] T004 [P] Create `src/modules/reservation/reservation-expiration.service.ts` placeholder and `src/modules/reservation/reservation-expiration.processor.ts` placeholder exports

---

## Phase 2: Foundational (Blocking Prerequisites)

**Purpose**: DB truth, transaction helper reuse, and background infra wiring that MUST complete before ANY user story

**⚠️ CRITICAL**: No user story work can begin until this phase is complete

- [X] T005 Verify `Reservation` composite index `status+expiresAt` exists via `psql \d Reservation` (should show `IDX_reservation_status_expiresAt`) — no new PG migration expected per data-model.md §5
- [X] T006 Wire `BullModule` in `src/app.module.ts` (`BullModule.forRootAsync` via `ConfigService` REDIS_URL) and register `BullModule.registerQueue({name:'reservation-expiration'})` in `src/modules/reservation/reservation.module.ts`
- [X] T007 Register RabbitMQ `NOTIFICATION_SERVICE` reuse in `src/modules/reservation/reservation.module.ts` (inject `ClientProxy` for `reservation.expired` post-commit per contracts D5) and export `ReservationExpirationService`
- [X] T008 [P] Add `ReservationExpirationService` poison tracking scaffolding in `src/modules/reservation/reservation-expiration.service.ts` (`Map<id,count>` + `skipSet`, `EXPIRATION_MAX_RETRIES` via `ConfigService`, `Logger`)
- [X] T009 [P] Create `findExpiredCandidateIds(limit)` query helper in `src/modules/reservation/reservation-expiration.service.ts` (`SELECT id FROM reservation WHERE status='RESERVED' AND expiresAt <= NOW() ORDER BY expiresAt ASC, id ASC LIMIT :limit` — D1)
- [X] T010 Run `npm run build` + `npm run lint` to confirm no TS errors after infra wiring; verify BullMQ queue `reservation-expiration` appears in Redis `bull:reservation-expiration:*` keys

**Checkpoint**: Foundation ready — BullMQ queue registered, RabbitMQ client injectable, scan helper returns ids, `synchronize:false` intact

---

## Phase 3: User Story 1 - Expired reservations automatically release inventory (Priority: P1) 🎯 MVP

**Goal**: A `RESERVED` reservation past `expiresAt` is automatically transitioned to `EXPIRED` with `reservedAmount -= qty` (stock unchanged) within 60s SLA (30s tick), including immunity for not-yet-expired and multi-item atomicity

**Independent Test**: Create `RESERVED qty2 on A (stock=10,reserved=2)` with `expiresAt = NOW()-5m` (via `UPDATE "Reservation" SET "expiresAt"=NOW()-interval`), invoke `expirationService.processExpiredBatch(10)`, assert `R.status=EXPIRED`, `A.reservedAmount=0`, `A.stock=10`; create `RESERVED expiresAt=NOW()+10m` and assert scan skips it; create multi-item `A1+B2` expired and assert atomic or rollback

### Tests for User Story 1 ⚠️ Write FIRST, ensure FAIL before implementation

- [X] T011 [P] [US1] Unit test scan predicate `expiresAt <= NOW()` in `src/modules/reservation/reservation-expiration.service.spec.ts` (mock `DataSource` query builder asserts `status='RESERVED' AND expiresAt <= NOW() ORDER BY expiresAt ASC, id ASC LIMIT`, plus not-yet-expired skipped)
- [X] T012 [P] [US1] Unit test `expireOne` idempotent skip in `src/modules/reservation/reservation-expiration.service.spec.ts` (mock `EntityManager` returns `status=EXPIRED` after FOR UPDATE → service returns `{skipped:1}` no inventory save, `validateTransition` not called)
- [X] T013 [P] [US1] Integration test expired auto-release single-item in `src/modules/reservation/test/expiration.integration.spec.ts` (real PG: `stock10 reserved2 qty2 expiresAt past → after processExpiredBatch(10) → EXPIRED reserved0 stock10 available10` + `GET /reservations/:id` 200)
- [X] T014 [P] [US1] Integration test not-yet-expired immunity in `src/modules/reservation/test/expiration.integration.spec.ts` (real PG: `expiresAt=NOW()+10m RESERVED → processExpiredBatch(10) → still RESERVED reserved unchanged`)
- [X] T015 [US1] Integration test multi-item atomic in `src/modules/reservation/test/expiration.integration.spec.ts` (real PG: `A qty1+B qty2 expired → EXPIRED A.reserved0 B.reserved0` and inject failure on one `save` → whole tx rollback, status stays RESERVED)

### Implementation for User Story 1

- [X] T016 [US1] Implement `expireOne(manager, reservationId)` single-candidate transactional unit in `src/modules/reservation/reservation-expiration.service.ts` (delegates to `ReservationService.transitionWithInventoryInternal(manager,null,id,EXPIRED,...,false)` with `FOR UPDATE` Reservation first → verify RESERVED → sorted `FOR UPDATE` Inventories → `reservedAmount -= qty` → `status=EXPIRED` per D3)
- [X] T017 [US1] Implement `findExpiredCandidateIds(limit)` actual query in `src/modules/reservation/reservation-expiration.service.ts` using `manager.getRepository(Reservation).createQueryBuilder` or `dataSource.query` with `status='RESERVED' AND expiresAt <= NOW()` (D1, FR-001)
- [X] T018 [US1] Wire scan outside per-candidate tx and reuse `expireOne` in batch loop scaffolding (without yet full batch error mapping) in `src/modules/reservation/reservation-expiration.service.ts`
- [X] T019 [US1] Verify manual `PATCH /reservations/:id/expire` (admin immediate override, FR-004) still works and is unaffected by worker predicate (integration smoke: future `expiresAt` still `EXPIRED` via manual path)

**Checkpoint**: US1 independently testable — `npm run test -- --runInBand` T011-T015 pass, `processExpiredBatch(10)` releases single and multi-item expired, future immunity holds, 60s SLA smoke via `EXPIRATION_INTERVAL_MS=5000` fake

---

## Phase 4: User Story 2 - Cleanup race: single winner vs checkout/cancellation (Priority: P1)

**Goal**: Concurrent expiration vs `complete`/`cancel`/manual `expire`/parallel worker ticks resolves to exactly one winner and exactly one inventory mutation (no double-release, no double-sell), via `FOR UPDATE` row locking + BullMQ singleton efficiency

**Independent Test**: Create `RESERVED qty2 expiresAt past` and fire `PATCH /:id/complete` + `PATCH /:id/cancel` + `processExpiredBatch` in parallel `Promise.all` inside real `DataSource.transaction` (`--runInBand`), assert one `200`/`EXPIRED` and two `409`, inventory mutated once; repeat with two concurrent `processExpiredBatch(10)` on 5 expired R

### Tests for User Story 2 ⚠️ Write FIRST, ensure FAIL before implementation

- [X] T020 [P] [US2] Integration test `worker vs complete` single-winner in `src/modules/reservation/test/expiration.integration.spec.ts` (real PG: `RESERVED qty2 expiresAt past + concurrent complete qty2 vs expireOne` → one `200`/`EXPIRED`, one `409`, `reserved`/`stock` reflect single mutation)
- [X] T021 [P] [US2] Integration test `worker vs cancel` single-winner in `src/modules/reservation/test/expiration.integration.spec.ts` (real PG: same pattern, `cancel` vs `expireOne`)
- [X] T022 [P] [US2] Integration test `worker vs worker` single-winner in `src/modules/reservation/test/expiration.integration.spec.ts` (real PG: two simultaneous `processExpiredBatch(10)` on 5 expired → exactly 5 EXPIRED, no double-release, `reservedAmount` never negative)
- [X] T023 [P] [US2] Integration test idempotency second tick in `src/modules/reservation/test/expiration.integration.spec.ts` (real PG: `expire → assert reserved0 → run processExpiredBatch again on same id → still reserved0, status EXPIRED, no second decrement`)
- [X] T024 [US2] Integration test `worker skips already COMPLETED` in `src/modules/reservation/test/expiration.integration.spec.ts` (real PG: `RESERVED → complete stock-=qty → then worker batch → still COMPLETED, inventory unchanged beyond sale`)

### Implementation for User Story 2

- [X] T025 [US2] Ensure `expireOne` uses `FOR UPDATE` Reservation first then sorted `Inventory` locks (D3) and reuses shared helper so manual + worker share identical semantics (no duplicate logic) in `src/modules/reservation/reservation-expiration.service.ts`
- [X] T026 [US2] Add status-after-lock idempotent skip branch in `src/modules/reservation/reservation-expiration.service.ts` (`if status != RESERVED after FOR UPDATE → log debug skip, return {skipped:1}`) per FR-005/FR-006
- [X] T027 [US2] Map DB CHECK violation `23514`/`CHK_` to `409 Conflict` inside `expireOne` catch to keep poison handling consistent with `reservation.service.ts:400-412` pattern (FR-005, D7)
- [X] T028 [US2] Gate `findExpiredCandidateIds` so `expiresAt=NOW()+10m` never returned (verify scan predicate `<= NOW()` inclusive, boundary `== NOW()` eligible per Edge Cases, FR-001)

**Checkpoint**: US2 independently testable — concurrent single-winner + idempotency tests pass (`--runInBand`), no double-release under parallel worker/complete/cancel

---

## Phase 5: User Story 3 - Batch scanning, scheduling, and observability (Priority: P2)

**Goal**: Batched paging (10 per tick, deterministic `expiresAt,id` order, composite index scan), BullMQ repeat scheduling (30s to meet 60s SLA, `concurrency:1` singleton `jobId`, `EXPIRATION_ENABLED` guard, non-overlapping), RabbitMQ `reservation.expired` post-commit emit, observability logs, and poison retry `EXPIRATION_MAX_RETRIES=3`

**Independent Test**: Create 25 expired `RESERVED` across 5 inventories, `processExpiredBatch(10)` three times → all 25 `EXPIRED` (`reserved=0`); start Nest with `EXPIRATION_INTERVAL_MS=5000` short interval, wait 2-3 ticks → all drained; `EXPLAIN` shows `Index Scan` on `IDX_reservation_status_expiresAt`; mock `ClientProxy` asserts `emit('reservation.expired')` after each commit; corrupt one inventory to poison → retry 3x log every retry then skip, batch continues

### Tests for User Story 3 ⚠️ Write FIRST, ensure FAIL before implementation

- [X] T029 [P] [US3] Integration test batch paging in `src/modules/reservation/test/expiration.integration.spec.ts` (real PG: 25 expired RESERVED `batchSize 10` → `processExpiredBatch` x3 → 25 EXPIRED `reserved0`, deterministic order)
- [X] T030 [US3] Integration test `EXPLAIN` index scan in `src/modules/reservation/test/expiration.integration.spec.ts` (real PG: `EXPLAIN (ANALYZE, BUFFERS) SELECT id FROM reservation WHERE status='RESERVED' AND expiresAt <= NOW() ORDER BY expiresAt ASC, id ASC LIMIT 10` → contains `Index Scan` on `IDX_reservation_status_expiresAt`) — run after T029 or isolate DB truncation to avoid parallel pollution
- [X] T031 [P] [US3] Unit test BullMQ processor repeat and singleton in `src/modules/reservation/reservation-expiration.processor.spec.ts` (mock `ReservationExpirationService`, assert `@Processor('reservation-expiration', concurrency:1)` and `EXPIRATION_ENABLED=false` short-circuit, `processing` flag prevents overlapping, `jobId` singleton)
- [X] T032 [P] [US3] Unit test RabbitMQ post-commit emit in `src/modules/reservation/reservation-expiration.service.spec.ts` (mock `ClientProxy`, assert `client.emit('reservation.expired', expect.objectContaining({reservationId, userId, status:'EXPIRED'}))` called after commit, not inside tx, failure logged not rolled back)
- [X] T033 [US3] Integration test poison retry then skip in `src/modules/reservation/test/expiration.integration.spec.ts` (real PG: corrupt `reservedAmount=0 qty=2` → `expireOne` CHECK 409 → retry, assert 3 retries logged `warn`, 4th skip, batch other 2 expired still succeed, `EXPIRATION_ENABLED=false` case)

### Implementation for User Story 3

- [X] T034 [US3] Implement `processExpiredBatch(limit)` orchestrator in `src/modules/reservation/reservation-expiration.service.ts` (scan `findExpiredCandidateIds(limit)` outside tx, loop sequential per-candidate `dataSource.transaction(manager => expireOne)` with `try/catch`, increment `scanned/expired/skipped/failed/retried`, poison `Map<id,count>` + `skipSet` per D7, return summary, `processAll(batchSize)` helper for draining)
- [X] T035 [P] [US3] Create `ReservationExpirationProcessor` in `src/modules/reservation/reservation-expiration.processor.ts` (`@Processor('reservation-expiration', concurrency:1)`, `@Process` handleRepeat: `EXPIRATION_ENABLED` guard, `processing` flag, calls `service.processExpiredBatch(EXPIRATION_BATCH_SIZE)`, logs `expiration tick: scanned=N expired=M ...` per FR-009)
- [X] T036 [US3] Wire BullMQ repeat registration in `src/modules/reservation/reservation.module.ts` or `onModuleInit` (register repeat `30s`/`EXPIRATION_INTERVAL_MS`/`EXPIRATION_CRON` with `jobId='reservation-expiration-tick'`, D2/D6) and ensure `AppModule` `BullModule.forRootAsync` uses `REDIS_URL`/`REDIS_HOST`
- [X] T037 [US3] Add RabbitMQ publish after commit inside `processExpiredBatch` loop (inject `NOTIFICATION_SERVICE ClientProxy`, `emit('reservation.expired', payload)` after `COMMIT`, `try/catch` log `error` not rollback per D5/Q3) in `src/modules/reservation/reservation-expiration.service.ts`
- [X] T038 [US3] Add poison `EXPIRATION_MAX_RETRIES` env wiring via `ConfigService` (default `3`) and `every retry logged warn/error` branch in `src/modules/reservation/reservation-expiration.service.ts` (D7, FR-007)
- [X] T039 [US3] Add observability logs per FR-009 (`Logger.log` tick summary, `debug` per-reservation `expiring <id> expiresAt=<iso>`, `debug skip`, `warn/error` failures) and ensure `EXPIRATION_ENABLED=false` disables scheduling but leaves manual `PATCH` intact (quickstart §4.5)

**Checkpoint**: US3 independently testable — batch paging, EXPLAIN, BullMQ repeat, RabbitMQ emit, poison N-retry batch-continue all pass

---

## Phase 6: Polish & Cross-Cutting Concerns

**Purpose**: Final verification, docs, and cleanup that spans all stories

- [X] T040 [P] Verify `GET /reservations/:id` after worker `EXPIRED` reflects new status immediately and `available` recomputed (`stock - reservedAmount`) in `src/modules/inventory` / `src/modules/reservation` integration smoke
- [X] T041 [P] Ensure `PATCH /reservations/:id/expire` admin remains immediate override (no `expiresAt` check) while worker enforces `<= NOW()` — add assertion in `src/modules/reservation/test/expiration.integration.spec.ts` comparing both paths (FR-004)
- [X] T042 Run full verification: `npm run lint` + `npm run build` + `npm run test -- --runInBand` + `npm run test:e2e` — ensure no regression from Phase 4 (89 Phase-4 tests + 12-15 new) and BullMQ queue does not leak on shutdown
- [X] T043 [P] Update `docs/plan.md` backlog `NOT DONE → DONE` for Phase 5 Expiration Cleanup items and add `docs/decisions/ADR-006-expiration-cleanup.md` (record BullMQ choice, 60s SLA, singleton, RabbitMQ event, poison retry) + update `docs/architecture/modules.md` (reservation module expands with expiration service/processor)
- [X] T044 [P] Add `.env.example` entries for `EXPIRATION_INTERVAL_MS`, `EXPIRATION_BATCH_SIZE`, `EXPIRATION_ENABLED`, `EXPIRATION_MAX_RETRIES`, plus `REDIS_URL`/`RABBITMQ_URL` already present, and ensure `specs/006-reservation-expiration-cleanup/quickstart.md` validation passes per step 7 (manual curl/psql, short interval drain)
- [X] T045 [P] Remove any leftover `console.log` when touching files (replace with `Logger`), verify `grep -r console.log src/modules/reservation` →0, and confirm `AllExceptionsFilter` handles `409`/`404`/`403` for expiration paths

---

## Dependencies & Execution Order

### Phase Dependencies

- **Setup (Phase 1)**: No dependencies — can start immediately. Installs `bullmq`/`@nestjs/bullmq`, sets env, creates placeholders.
- **Foundational (Phase 2)**: Depends on Setup — BLOCKS all user stories. Requires BullMQ queue registration, RabbitMQ client reuse, scan helper scaffold, composite index verification, `build`/`lint` pass.
- **User Stories (Phase 3+)**: All depend on Foundational (Phase 2) — then can proceed sequentially or in parallel if staffed (but US2 relies on US1's `expireOne` transactional unit, so US1 should complete first for minimal rework; US3 relies on US1+US2's per-candidate correctness).
- **Polish (Phase 6)**: Depends on all desired stories (US1+US2+US3) being complete.

### User Story Dependencies

- **US1 (P1 auto-release)**: Can start after Foundational — no dependencies on other stories. Provides `expireOne` + scan predicate that US2/US3 reuse.
- **US2 (P1 race single-winner)**: Depends on US1's `expireOne` (needs per-candidate correctness) — adds idempotent skip, `FOR UPDATE` ordering, concurrent verification. Should be implemented immediately after US1.
- **US3 (P2 batch/scheduling/observability)**: Depends on US1+US2 (needs correct single-candidate + race handling) — adds batch loop, BullMQ repeat, RabbitMQ publish, poison retry.

### Within Each User Story

- Tests (if included) MUST be written and FAIL before implementation
- Scan/query helpers before per-candidate service
- Per-candidate transactional unit before batch orchestrator / processor
- Core `FOR UPDATE` logic before RabbitMQ publish / poison handling
- Story complete before moving to next priority

### Parallel Opportunities

- All Setup tasks marked [P] can run in parallel (T002, T003, T004)
- All Foundational tasks marked [P] can run in parallel (T008, T009)
- US1 tests T011, T012, T013, T014 can run in parallel (different files/mocks); T015 separate file but same phase
- US2 tests T020-T023 can run in parallel (all in same file but different `it` blocks — marked [P] for authoring)
- US3 tests T029-T032 can run in parallel; T033 depends on US1 helpers
- Implementation within US3: T035, T036 can parallelize with T034 service scaffolding if files differ
- Final Polish T040, T041, T043, T044, T045 can run in parallel (different docs/files)

---

## Parallel Example: User Story 1

```bash
# Launch all tests for User Story 1 together (fail-first):
Task: "Unit test scan predicate in reservation-expiration.service.spec.ts (T011)"
Task: "Unit test expireOne idempotent skip (T012)"
Task: "Integration test expired auto-release (T013)"
Task: "Integration test not-yet-expired immunity (T014)"

# Launch batch-related impl after tests:
Task: "Implement expireOne transactional unit (T016)"
Task: "Implement findExpiredCandidateIds query (T017)"
```

---

## Implementation Strategy

### MVP First (User Story 1 Only)

1. Complete Phase 1: Setup (bullmq deps, env)
2. Complete Phase 2: Foundational (BullMQ queue, RabbitMQ client, scan helper)
3. Complete Phase 3: US1 (scan predicate + single-candidate expireOne + multi-item atomic) — **MVP!** At this point expired reservations release within 60s when `processExpiredBatch` is called manually, even without the repeat scheduler
4. **STOP and VALIDATE**: `npm run test -- --runInBand` T011-T015 pass, manual `processExpiredBatch(10)` releases expired, future immunity holds
5. Deploy/demo if ready (worker can be invoked via ad-hoc script)

### Incremental Delivery

1. Setup + Foundational → foundation ready
2. Add US1 → test independently → deploy (manual batch MVP)
3. Add US2 → test concurrent single-winner/idempotency → deploy (race-safe)
4. Add US3 → add BullMQ repeat scheduling + batch paging + EXPLAIN + RabbitMQ + poison retry → full Phase 5 exit criteria (eventually release within 60s, single-winner, no double-release, batch drains)
5. Each story adds value without breaking previous

### Parallel Team Strategy

With multiple developers (after US1):
- Developer A: US2 concurrent races + idempotency (reservation-expiration.service.ts + expiration.integration.spec.ts)
- Developer B: US3 batch paging + EXPLAIN + poison retry (same service + test file, coordinate on `processExpiredBatch` loop)
- Developer C: US3 BullMQ processor + RabbitMQ publish (processor.ts + service publish wiring)
- Merge after US1 is stable; re-run `npm run test -- --runInBand` to verify no flaky `--runInBand`-sensitive tests

---

## Notes

- [P] tasks = different files, no dependencies
- [Story] label maps task to specific user story for traceability (US1 auto-release, US2 race, US3 batch/schedule)
- Each user story independently completable via `processExpiredBatch` — no hidden cross-story state except shared `expireOne` (US1 is prerequisite for US2/US3)
- Verify tests fail before implementing (especially T013-T015, T020-T024, T029-T033)
- Commit after each task or logical group; push to `006-reservation-expiration-cleanup`
- Stop at any checkpoint to validate story independently via `npm run test -- --runInBand` and manual `psql`/`curl` per `quickstart.md`
- Avoid: vague tasks, same file conflicts, cross-story dependencies that break independence; prefer small commits
