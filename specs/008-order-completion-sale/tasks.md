---
description: "Task list for Order Completion / Sale (Phase 7)"
---

# Tasks: Order Completion / Sale

**Input**: Design documents from `/specs/008-order-completion-sale/`
**Prerequisites**: plan.md (required), spec.md (required), research.md, data-model.md, contracts/
**Branch**: `008-order-completion-sale` | **Spec**: [spec.md](./spec.md) | **Plan**: [plan.md](./plan.md)

**Tests**: FR-010 mandates unit + integration (real PostgreSQL, `--runInBand`, `FOR UPDATE` single-winner) + E2e (`supertest`). Test tasks are included and MUST be written to fail before implementation (TDD).

**Organization**: Tasks grouped by user story to enable independent implementation and testing of each story.

## Format: `[ID] [P?] [Story] Description`

- **[P]**: Can run in parallel (different files, no dependencies)
- **[Story]**: Which user story this task belongs to (e.g., US1, US2, US3)
- Include exact file paths in descriptions

## Path Conventions

- **Single project**: `src/` at repository root, per `plan.md` structure

---

## Phase 1: Setup (Shared Infrastructure)

**Purpose**: Project initialization and baseline verification — no new infrastructure

- [X] T001 Verify tooling and baseline `npm run build` + `npm run lint` green in specs/008-order-completion-sale/plan.md:Technical Context
- [X] T002 [P] Ensure docker infra `docker-compose up -d` and `data-source.ts` `synchronize:false` plus existing migrations verified via `npm run test -- --runInBand` baseline
- [X] T003 [P] Create `specs/008-order-completion-sale/` branch guard `git branch --show-current` is `008-order-completion-sale` and `AGENTS.md` marker points to `specs/008-order-completion-sale/plan.md`

---

## Phase 2: Foundational (Blocking Prerequisites)

**Purpose**: Core guard and DTO that MUST be complete before ANY user story can be implemented — blocks all US1/US2/US3

**⚠️ CRITICAL**: No user story work can begin until this phase is complete

- [X] T004 [P] Create empty `CompleteOrderDto` in `src/modules/order/dto/complete-order.dto.ts` (no fields, `@ApiProperty` none, global `ValidationPipe` `forbidNonWhitelisted` will reject any extra field with 400)
- [X] T005 Implement `validateOrderTransition(from: OrderStatus, to: OrderStatus)` + `ALLOWED_ORDER_TRANSITIONS` in `src/modules/order/order.service.ts` (or `order-completion.service.ts` shared helper) mirroring `src/modules/reservation/reservation.service.ts:21-30` — throw `ConflictException` on invalid (`COMPLETED→*`, `CANCELLED→COMPLETED`, `FAILED→COMPLETED`), allow `PENDING→COMPLETED|CANCELLED|FAILED` + idempotent `COMPLETED→COMPLETED`
- [X] T006 [P] Add `assertOwner` helper for `Order` in `src/modules/order/order.service.ts` (owner-or-Admin, throw `ForbiddenException`, like `reservation.service.ts:543`) if not already exported, with JSDoc `/** ... @param @returns @throws */` per `AGENTS.md` §3
- [X] T007 Create `OrderCompletionService` skeleton `src/modules/order/order-completion.service.ts` (class JSDoc `/** This service is responsible for order sale domain ... */`, inject `DataSource` + `ReservationService`, method `complete(manager: EntityManager, requestingUserId: string, orderId: string, role: UserRoles)` stub throwing `NotImplemented` — real logic filled in US1)

**Checkpoint**: Foundation ready — `CompleteOrderDto` 400 on extra fields, `validateOrderTransition` 409, `assertOwner` 403, skeleton compiles — user story implementation can now begin

---

## Phase 3: User Story 1 — Owner completes own PENDING order → sale recorded (Priority: P1) 🎯 MVP

**Goal**: Authenticated owner `POST /order/:id/complete` atomically `Order PENDING→COMPLETED` + `Reservation RESERVED→COMPLETED` + `Inventory stock-=qty reserved-=qty` per `ReservationItem`, observable via `GET /order/:id` + `GET /reservations/:id` + `GET /inventory/:productId` (SC-001). Historical `unit_price`/`total` frozen.

**Independent Test**: Seed products A(price100) B(price50) with `A stock10 reserved0`, `B stock5 reserved0`, user U1 `POST /cart/items` A2 B1 → `POST /order/checkout` → `GET /order/:id` is `PENDING` `total250` + `Reservation RESERVED` `A reserved2`. `POST /order/:id/complete` as U1 → `200 {status:COMPLETED, reservation:{status:COMPLETED}}`. `GET /order/:id` → `COMPLETED` `reservationId` link, `GET /inventory/A` → `stock 8 reserved 0 available 8`, `GET /inventory/B` → `stock 4 reserved 0 available 4`, `total 250` and `items[*].unit_price 100/50` unchanged. Single-item A `qty1` case still `stock10→9 reserved1→0`.

### Tests for User Story 1 (write FIRST, ensure FAIL before implementation)

- [X] T008 [P] [US1] Unit test for `validateOrderTransition` in `src/modules/order/order.service.spec.ts` (or `order-completion.service.spec.ts`) — `PENDING→COMPLETED` pass, `COMPLETED→COMPLETED` idempotent pass, `CANCELLED→COMPLETED`/`FAILED→COMPLETED`/`EXPIRED` `409`, empty DTO `CompleteOrderDto` extra-field validation `400`
- [X] T009 [P] [US1] Contract test for `POST /order/:id/complete` owner `200` + `GET /order/:id` + `GET /inventory/:productId` in `src/modules/order/test/order-complete.integration.spec.ts` (real PG, `--runInBand`) — seed checkout, call complete, assert `Order COMPLETED` + `Reservation COMPLETED` + `A stock10→8 reserved2→0`, `total 250` unchanged
- [X] T010 [P] [US1] Integration test for single-item sale + missing Reservation `404` in `src/modules/order/test/order-complete.integration.spec.ts` — single `A qty1` `stock10→9`, and case where `Reservation` missing for `orderId` → `404 Reservation for order <id> not found` rollback leaves `Order PENDING`

### Implementation for User Story 1

- [X] T011 [P] [US1] Implement `OrderCompletionService.complete` lock phase in `src/modules/order/order-completion.service.ts` — `SELECT Order WHERE id=:orderId FOR UPDATE` via `manager.findOne(Order, {where:{id}, lock:{mode:'pessimistic_write'}})` + `404` + `assertOwner(order, requestingUserId, role)` + idempotent `if (order.status===COMPLETED) return enriched` + `validateOrderTransition`
- [X] T012 [P] [US1] Implement Reservation lock + validation in `src/modules/order/order-completion.service.ts` — `SELECT Reservation WHERE orderId=:orderId FOR UPDATE` (no outer join) + `404` + `ReservationService.validateTransition(RESERVED, COMPLETED)` + handle `COMPLETED→COMPLETED` at reservation level, handle `items.length===0` edge
- [X] T013 [US1] Implement sorted Inventory lock + arithmetic + save in `src/modules/order/order-completion.service.ts` — `sortedIds = [...new Set(items.map(i=>inventoryId))].sort()` → `manager.find(Inventory, {where:{id:In(sortedIds)}, lock:{mode:'pessimistic_write'}})` → `404` if any missing → per-item `inventory.stock -= qty; inventory.reservedAmount -= qty; await manager.save(inventory)` with `catch 23514/CHK_inventory_* → 409 Conflict`, then `reservation.status=COMPLETED` `order.status=COMPLETED` `manager.save` both
- [X] T014 [US1] Add thin `POST /order/:id/complete` route (+ optional `PATCH` alias) in `src/modules/order/order.controller.ts` — `@Post(':id/complete') @Auth() @ApiBearerAuth @ApiOperation/@ApiResponse`, `@CurrentUser('sub') userId, @CurrentUser('role') role, @Param('id') id, @Body() dto: CompleteOrderDto`, wrap `dataSource.transaction(manager => orderCompletionService.complete(manager, userId, id, role))`, return enriched `{id,status,total,reservationId,reservation,items,inventoriesAffected?}` (reuse `OrderService.findOne` enrichment or direct)
- [X] T015 [US1] Wire `OrderCompletionService` in `src/modules/order/order.module.ts` — add to `providers` + `exports`, ensure `TypeOrmModule.forFeature([Order, OrderItem])` + `ReservationModule` + `InventoryModule` already imported, no new migration, add class/method JSDoc per `AGENTS.md` §3
- [X] T016 [US1] Add historical price isolation assertion in `src/modules/order/test/order-complete.integration.spec.ts` — complete → update `Product.price 100→999` → `GET /order/:id` `unit_price` still `100` `total 250`; new checkout snapshots `999`
- [X] T017 [US1] Validate quickstart scenario `POST /order/checkout` → `POST /order/:id/complete` per `specs/008-order-completion-sale/quickstart.md:1` and ensure `npm run lint` + `npm run build` pass

**Checkpoint**: At this point, User Story 1 should be fully functional and testable independently — `POST /order/:id/complete` as owner decrements stock once, idempotent path short-circuits, invalid transitions 409

---

## Phase 4: User Story 2 — Concurrent completion race: single winner + idempotent retry (Priority: P1)

**Goal**: Concurrent `complete vs complete` on same Order is single-winner idempotent (only one `stock-=qty`/`reserved-=qty`, both callers `200` `COMPLETED`, final `A stock8 reserved0` not `6/-2`); `complete vs expire` (worker `RESERVED→EXPIRED` + `Order PENDING→CANCELLED`) is also single-winner via `FOR UPDATE` (SC-003/SC-006).

**Independent Test**: Seed `Order PENDING` + `Reservation RESERVED` `A stock10 reserved2 qty2`. `Promise.all([complete(orderId), complete(orderId)])` via `dataSource.transaction` real PG `--runInBand` → exactly one `stock 10→8 reserved2→0` + both `200 COMPLETED`, never double-decrement. `Promise.all([complete(orderId), reservationService.expire(manager, reservationId)])` → single winner `COMPLETED` (`stock-=qty`) vs `CANCELLED` (`reserved-=qty`), loser `409` (or idempotent `200` if already winner's state), inventory changed exactly once. `[A,B]` vs `[B,A]` concurrent completes on overlapping `B` do not deadlock.

### Tests for User Story 2 (write FIRST, ensure FAIL before implementation)

- [X] T018 [P] [US2] Concurrency test `complete vs complete` same Order in `src/modules/order/test/order-complete.concurrency.spec.ts` — `A stock10 reserved2`, `Promise.all` two `POST /order/:id/complete`, assert one decrement, both `200`, `A stock8 reserved0`, `--runInBand`
- [X] T019 [P] [US2] Concurrency test `complete vs expire` race in `src/modules/order/test/order-complete.concurrency.spec.ts` — `Promise.all([orderCompletionService.complete, reservationExpirationService expire-or-direct-expire])` with real PG, assert single-winner `COMPLETED` vs `CANCELLED` + `409`/idempotent, inventory once
- [X] T020 [P] [US2] Concurrency test no-deadlock `complete [A,B]` vs `complete [B,A]` with shared `B` in `src/modules/order/test/order-complete.concurrency.spec.ts` — opposite-order sortedIds, assert both serialize without `lock timeout`

### Implementation for User Story 2

- [X] T021 [US2] Harden idempotent `COMPLETED→COMPLETED` short-circuit in `src/modules/order/order-completion.service.ts` — ensure early return occurs **before** any `Inventory.save` and returns enriched order with current `Reservation`, add `// Idempotent COMPLETED→COMPLETED (spec D1) — no inventory re-mutation` inline comment
- [X] T022 [US2] Verify `FOR UPDATE` ordering + row-level lock via `EXPLAIN` in `src/modules/order/test/order-complete.integration.spec.ts` — `EXPLAIN` for `SELECT Order FOR UPDATE` + `Reservation FOR UPDATE` + `Inventory In(sortedIds) FOR UPDATE` shows `Lock Rows` on PK/index, no table lock; smoke timing hold <100ms logged, no deadlock on disjoint inventories
- [X] T023 [US2] Add `COMPLETED` retry no-re-mutation assertion in `src/modules/order/test/order-complete.integration.spec.ts` — `POST complete` twice sequentially, assert second `200` and `stock 8 reserved 0` unchanged (covers spec Acceptance Scenario 2)

**Checkpoint**: At this point, User Stories 1 AND 2 should both work independently — sale + single-winner concurrency + idempotent retry verified on real PG

---

## Phase 5: User Story 3 — Ownership, visibility, and invalid transitions (Priority: P2)

**Goal**: `User` can complete only own orders (`403`), `Admin` can complete any (`200`); invalid `CANCELLED/FAILED/EXPIRED` → `409`; missing `Inventory`→`404` rollback; `GET /order/:id` + `GET /order?status=COMPLETED` remain owner-scoped with correct historical price (SC-004/SC-005/SC-007).

**Independent Test**: Create U1 `PENDING`, U2 `PENDING`, one `EXPIRED` (`Order CANCELLED` + `Reservation EXPIRED` via worker). As U2 `POST /order/U1-order-id/complete` → `403`; as Admin → `200`. As owner `POST .../complete` on `CANCELLED`/`FAILED` → `409` no inventory change; missing `Reservation` for order → `404`; already `COMPLETED` retry → `200` idempotent; deleted `Inventory` concurrently → `404` rollback `PENDING`.

### Tests for User Story 3 (write FIRST, ensure FAIL before implementation)

- [X] T024 [P] [US3] Ownership test `403` vs Admin `200` in `src/modules/order/test/order-complete.integration.spec.ts` — U1 `PENDING`, U2 attempt `POST /order/U1-id/complete` → `403`, Admin `200`, no DB mutation for `403`
- [X] T025 [P] [US3] Invalid transition `409` test in `src/modules/order/test/order-complete.integration.spec.ts` — `CANCELLED` (expired), `FAILED` (insert `FAILED` row), `Reservation EXPIRED` → `409 Invalid order transition: CANCELLED -> COMPLETED`, inventory `stock`/`reservedAmount` unchanged after rollback
- [X] T026 [P] [US3] Missing/Deleted Inventory `404` + empty-body `400` test in `src/modules/order/test/order-complete.integration.spec.ts` + `src/modules/order/order.controller.spec.ts` — missing `Reservation` `404`, `Inventory` deleted after checkout → `404`, body `{paymentId:1}` or `{items:[]}` `400` via `CompleteOrderDto` `forbidNonWhitelisted`
- [X] T027 [P] [US3] Visibility + historical price test in `src/modules/order/test/order-complete.integration.spec.ts` — `GET /order?status=COMPLETED&limit=10` paginated `meta` + `GET /order/:id` as owner `200` with `reservationId`, as other user `403`, after `Product.price 100→999` `unit_price` still `100`

### Implementation for User Story 3

- [X] T028 [US3] Enforce `assertOwner` + error mapping in `src/modules/order/order-completion.service.ts` + `src/modules/order/order.controller.ts` — `403` for owner mismatch, `404` for `Order`/`Reservation`/`Inventory` missing, `409` for `validateOrderTransition` + `validateTransition` + `23514/CHK_inventory_* → ConflictException`, inline comments `// Owner-scoped (User) vs Admin bypass per spec FR-008` and `// DB CHECK backstop (spec D3) → 409`
- [X] T029 [US3] Ensure `GET /order` + `GET /order/:id` enrichment still links `reservationId` after `COMPLETED` in `src/modules/order/order.service.ts` — verify `reservationRepo.findOne({where:{orderId}})` returns `COMPLETED`, add JSDoc `/** ... @throws ForbiddenException */`
- [X] T030 [US3] Run quickstart edge validations per `specs/008-order-completion-sale/quickstart.md:2` — curl checks: other-user `403`, extra body `400`, idempotent retry `200`, paginated `GET /order?status=COMPLETED` returns `COMPLETED` with `meta`

**Checkpoint**: All user stories should now be independently functional — sale + concurrency + ownership/visibility + invalid transitions all green

---

## Phase 6: Polish & Cross-Cutting Concerns

**Purpose**: Improvements that affect multiple user stories — no new user-facing scope beyond spec's Out-of-Scope deferrals

- [X] T031 [P] Add class-level `/** This service is responsible for order sale domain ... */` and method-level `/** ... @param @returns @throws */` JSDoc to `src/modules/order/order-completion.service.ts` + `src/modules/order/order.controller.ts:complete` + `src/modules/order/dto/complete-order.dto.ts` per `AGENTS.md` §3; add inline comments for `sortedIds`, lock ordering, `available` invariant, `CHK` mapping
- [X] T032 [P] Run `quickstart.md` full validation per `specs/008-order-completion-sale/quickstart.md` — `register → add to cart → checkout → POST /order/:id/complete → GET /order/:id COMPLETED → update product price → GET /order/:id still 100` + concurrent harness instructions, ensure `docker-compose up -d` remains required
- [X] T033 [P] Ensure `src/modules/order/order.controller.ts` has Swagger `@ApiOperation`/`@ApiResponse 200/403/404/409` for `POST /order/:id/complete` (+ optional `PATCH` alias) per `specs/008-order-completion-sale/contracts/order-complete.md:1.1`
- [X] T034 Verify no new migration needed (`synchronize:false`) via `npm run build` + `EXPLAIN` row-level `Lock Rows` smoke check logged, and `npm run lint` + `npm run test -- --runInBand` + `npm run test:e2e -- --runInBand` (E2E `register→add→checkout→complete→GET order→price isolation`) all pass
- [X] T035 Update `docs/plan.md` Phase 7 exit criterion to **MET** with this feature's evidence (`T009` SC-001 + `T018`/`T019` single-winner + `npm run build` + `lint` + `test --runInBand`) and ensure `AGENTS.md` marker still points to `specs/008-order-completion-sale/plan.md`

---

## Dependencies & Execution Order

### Phase Dependencies

- **Setup (Phase 1)**: No dependencies — can start immediately
- **Foundational (Phase 2)**: Depends on Setup (Phase 1) — **BLOCKS** all user stories (validateOrderTransition + CompleteOrderDto + skeleton)
- **User Stories (Phase 3+)**: All depend on Foundational (Phase 2)
  - US1 (P1) can start immediately after Foundational — no dependencies on other stories, **MVP**
  - US2 (P1) depends on US1 implementation (T011-T015) for `OrderCompletionService.complete` to exist, but tests can be drafted in parallel
  - US3 (P2) depends on US1 core — can start after US1 `POST` works, parallelizable for owned tests
  - Or sequentially in priority order: US1 → US2 → US3
- **Polish (Phase 6)**: Depends on all desired user stories being complete (US1 minimum for MVP)

### User Story Dependencies

- **User Story 1 (P1)**: Can start after Foundational (Phase 2) — No dependencies on other stories. Delivers exit criterion: single `PENDING→COMPLETED` sale with `stock-=qty`.
- **User Story 2 (P1)**: Can start after Foundational — **Depends on US1** core (`OrderCompletionService.complete` exists) to test concurrency, but independently testable once US1 is functional. Tests `complete vs complete` and `complete vs expire` single-winner.
- **User Story 3 (P2)**: Can start after Foundational — **Depends on US1** core — independently testable for ownership/invalid transitions once US1 route exists. No dependency on US2.

### Within Each User Story

- Tests (if included) MUST be written and FAIL before implementation
- DTO/guard `validateOrderTransition` before service
- Service locks (`Order→Reservation→Inventories`) before controller thin route
- Core implementation before integration/concurrency no-deadlock checks
- Story complete before moving to next priority

### Parallel Opportunities

- All Setup tasks marked [P] (T002, T003) can run in parallel
- Foundational T004 (DTO) and T006 (assertOwner) can run in parallel; T005 depends on OrderStatus enum read; T007 skeleton after T004-T006
- Once Foundational completes, US1 tests T008, T009, T010 can run in parallel (different files/suites)
- US1 models T011 and T012 can run in parallel (different sections of same file but no cross-dependence) — or sequentially as they share file
- US2 tests T018, T019, T020 can run in parallel (same spec file but independent cases — parallelizable by file is marked but logically separate)
- US3 tests T024-T027 can run in parallel
- Polish T031, T032, T033 can run in parallel
- Different user stories can be worked on in parallel by different team members once US1 core exists

---

## Parallel Example: User Story 1

```bash
# Launch all tests for User Story 1 together (fail-first TDD):
Task: "Unit test for validateOrderTransition in src/modules/order/order.service.spec.ts" # T008
Task: "Contract test for POST /order/:id/complete owner 200 in src/modules/order/test/order-complete.integration.spec.ts" # T009
Task: "Integration test for single-item + missing Reservation 404 in src/modules/order/test/order-complete.integration.spec.ts" # T010

# Launch guard + DTO for Foundational together:
Task: "Create empty CompleteOrderDto in src/modules/order/dto/complete-order.dto.ts" # T004
Task: "Add assertOwner helper for Order in src/modules/order/order.service.ts" # T006
```

---

## Implementation Strategy

### MVP First (User Story 1 Only)

1. Complete Phase 1: Setup (T001-T003)
2. Complete Phase 2: Foundational (T004-T007) — `validateOrderTransition` + `CompleteOrderDto` + skeleton
3. Complete Phase 3: User Story 1 (T008-T017) — `OrderCompletionService.complete` lock→validate→mutate, `POST /order/:id/complete` thin route, historical price check
4. **STOP and VALIDATE**: Run `npm run lint && npm run build && npm run test -- --runInBand` — `T009` SC-001 `PENDING→COMPLETED stock10→8` should pass, `GET /order/:id` + `GET /inventory/:productId` observable
5. Deploy/demo if ready — MVP delivers exit criterion `A completed sale permanently decreases stock while releasing its reservation`

### Incremental Delivery

1. Complete Setup + Foundational → Foundation ready (guards + empty DTO)
2. Add User Story 1 → Test independently (sale + historical) → Deploy/Demo (MVP!)
3. Add User Story 2 → Test independently (concurrent single-winner idempotent + no-deadlock) → Deploy/Demo
4. Add User Story 3 → Test independently (ownership 403/Admin, invalid 409, missing 404, empty-body 400, visibility + pagination) → Deploy/Demo
5. Each story adds value without breaking previous stories (transactions rollback on 403/409/404, no double stock move)

### Parallel Team Strategy

With multiple developers:

1. Team completes Setup + Foundational together (T001-T007)
2. Once Foundational is done:
   - Developer A: User Story 1 — `OrderCompletionService` core + `POST` route (T008-T017)
   - Developer B (after A stubs): User Story 2 — concurrency `complete vs complete` / `complete vs expire` + EXPLAIN (T018-T023) — can draft tests early in parallel with A's implementation
   - Developer C: User Story 3 — ownership/visibility/invalid (T024-T030) — can draft tests in parallel with A
3. Stories complete and integrate independently; merge order US1 → US2 → US3

---

## Notes

- [P] tasks = different files, no dependencies
- [Story] label maps task to specific user story for traceability
- Each user story should be independently completable and testable (US1 MVP is `POST /order/:id/complete` single sale; US2 adds concurrency; US3 adds auth/visibility)
- Verify tests fail before implementing (TDD per FR-010)
- Commit after each task or logical group; push `008-order-completion-sale`
- Stop at any checkpoint to validate story independently via `npm run test -- --runInBand` + `quickstart.md` curls
- Avoid: vague tasks, same file conflicts, cross-story dependencies that break independence; keep transactions `DataSource.transaction(async manager => ...)` short with no Redis/RabbitMQ I/O inside per `research.md` D3/D4
