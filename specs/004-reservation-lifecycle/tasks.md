---
description: "Task list for Reservation Lifecycle (Phase 4)"
---

# Tasks: Reservation Lifecycle (Phase 4)

**Input**: Design documents from `/specs/004-reservation-lifecycle/`
**Prerequisites**: plan.md, spec.md, research.md, data-model.md, contracts/reservation-lifecycle-api.md, quickstart.md
**Branch**: `004-reservation-lifecycle`
**Tests**: Integration + concurrency + idempotent tests against real PostgreSQL (`--runInBand`) are REQUIRED per spec FR-010; unit tests for guards

**Organization**: Tasks grouped by user story to enable independent implementation and testing. All P1 stories share foundational transactional helper (Phase 2).

## Format: `[ID] [P?] [Story] Description`

- **[P]**: Can run in parallel (different files, no dependencies)
- **[Story]**: Which user story this task belongs to (US1-US4)
- Include exact file paths

## Path Conventions

- **Single project**: `src/` at repo root; tests co-located `*.spec.ts` and `src/modules/reservation/test/`

---

## Phase 1: Setup (Shared Infrastructure)

**Purpose**: Verify branch, dependencies, and existing PostgreSQL baseline before any lifecycle change

- [x] T001 Verify branch `004-reservation-lifecycle` and `specs/004-reservation-lifecycle/spec.md` clarifications Q1-Q5 integrated
- [x] T002 Ensure Docker infra healthy `docker compose ps` (postgres:17 healthy) and `.env` present in `D:\Projects\mini-e-commerce\.env`
- [x] T003 [P] Run baseline `npm run build` and `npm run lint` (0 errors) in `D:\Projects\mini-e-commerce\`
- [x] T004 [P] Run existing unit baseline `npm run test -- --runInBand` (pre-Phase 4: 89 tests) to confirm green before edits

---

## Phase 2: Foundational (Blocking Prerequisites)

**Purpose**: Shared transactional + test infrastructure that MUST be complete before any lifecycle story (US1-US4). No new tables.

**⚠️ CRITICAL**: No user story work can begin until this phase is complete

- [x] T005 Create or verify `src/modules/reservation/test/` helpers for lifecycle integration in `src/modules/reservation/test/reservation.lifecycle.integration.spec.ts` (skeleton, real PG DataSource setup per `quickstart.md`)
- [x] T006 Implement shared private helper `transition()` skeleton with `FOR UPDATE` Reservation lock + deterministic sorted Inventory locks in `src/modules/reservation/reservation.service.ts` (reuse Phase 3 `sortedIds` ordering, D1/D2)
- [x] T007 Add transactional error-mapping utility (DB `@Check` `QueryFailedError` → `409 ConflictException`) in `src/modules/reservation/reservation.service.ts`
- [x] T008 Verify existing `ReservationService.validateTransition` allows `RESERVED→COMPLETED|CANCELLED|EXPIRED` only and `assertOwner` guard in `src/modules/reservation/reservation.service.ts`
- [x] T009 Verify `Inventory` derived `available` and `@Check` constraints remain (`src/modules/inventory/entities/inventory.entity.ts`) — no DDL change per D10

**Checkpoint**: Foundation ready — `transition()` helper exists (stubs returning 409/404), locks sorted, EntityManager pattern verified; US1-US4 can now proceed (sequentially or in parallel once this phase done)

---

## Phase 3: User Story 1 — Complete a reserved sale (Priority: P1) 🎯 MVP

**Goal**: `RESERVED → COMPLETED` atomically does `stock -= qty` + `reservedAmount -= qty` per item, optional `orderId` overwrite (Q3), and idempotent `COMPLETED→COMPLETED` `200` (Q4/Q5), else `409/404/403`. See `spec.md` US1.

**Independent Test**: Create `RESERVED` `stock=10,reserved=3,qty=3` → `PATCH /:id/complete` → `200 COMPLETED`, `stock=7 reserved=0`; second `complete` → `200` idempotent no double; `orderId` overwrite works; invalid `orderId` → `404` rollback; concurrent `complete` vs `complete` single-winner.

### Tests for User Story 1 (write FIRST, ensure FAIL)

- [x] T010 [P] [US1] Unit test for `complete` success path + `stock`/`reserved` math in `src/modules/reservation/reservation.service.spec.ts`
- [x] T011 [P] [US1] Unit test for `orderId` overwrite vs `404` not-found and idempotent `COMPLETED→COMPLETED` `200` in `src/modules/reservation/reservation.service.spec.ts`
- [x] T012 [P] [US1] Integration test `RESERVED→COMPLETED` happy (multi-item atomic, stock/reserved decrement) in `src/modules/reservation/test/reservation.integration.spec.ts`
- [x] T013 [P] [US1] Integration test idempotent `COMPLETED→COMPLETED` retry `200` no re-mutation in `src/modules/reservation/test/reservation.integration.spec.ts`
- [x] T014 [P] [US1] Integration test `complete` with valid `orderId` overwrite + invalid `orderId` `404` rollback in `src/modules/reservation/test/reservation.integration.spec.ts`

### Implementation for User Story 1

- [x] T015 [US1] Implement `complete(manager,userId,id,dto,role)` with `FOR UPDATE` Reservation → `assertOwner` → idempotent `COMPLETED→COMPLETED` `200` early return → `validateTransition` → `orderId` existence check (overwrite per Q3) → lock sorted Inventories `FOR UPDATE` → mutate `stock-=qty` + `reserved-=qty` via `manager.getRepository(Inventory)` → save `Reservation.status=COMPLETED` in `src/modules/reservation/reservation.service.ts`
- [x] T016 [US1] Ensure `ReservationController.complete` wraps in `dataSource.transaction(manager=>service.complete(...))` and error mapping via `AllExceptionsFilter` in `src/modules/reservation/reservation.controller.ts`
- [x] T017 [US1] Verify `PATCH /reservations/:id/complete` contract per `specs/004-reservation-lifecycle/contracts/reservation-lifecycle-api.md` (201 vs 200 idempotent vs 409/404/403) — manual curl check per `quickstart.md` §3.1

**Checkpoint**: US1 fully functional — `complete` is transactional, `stock`/`reserved` synchronized, orderId overwrite, idempotent retry `200`; tests T010-T014 green (`--runInBand`)

---

## Phase 4: User Story 2 — Cancel a reserved hold (Priority: P1)

**Goal**: `RESERVED → CANCELLED` releases `reservedAmount -= qty` (stock unchanged), ownership guard, `CANCELLED→CANCELLED` remains `409` (Q5), transaction rolls back on failure. See `spec.md` US2.

**Independent Test**: Create `RESERVED` `stock=10,reserved=5,qty=2` → `PATCH /:id/cancel` → `200 CANCELLED`, `stock=10 reserved=3`; retry `cancel` → `409`; `COMPLETED→CANCELLED` → `409`; non-owner → `403`; multi-item atomic.

### Tests for User Story 2

- [x] T018 [P] [US2] Unit test for `cancel` success + `reserved` only decrement + `409` on `CANCELLED→CANCELLED` in `src/modules/reservation/reservation.service.spec.ts`
- [x] T019 [P] [US2] Integration test `RESERVED→CANCELLED` happy (stock unchanged, reserved decrement, available +qty) in `src/modules/reservation/test/reservation.integration.spec.ts`
- [x] T020 [P] [US2] Integration test `cancel` invalid edges `COMPLETED→CANCELLED` `409` + `CANCELLED→CANCELLED` `409` + `403` non-owner in `src/modules/reservation/test/reservation.integration.spec.ts`

### Implementation for User Story 2

- [x] T021 [US2] Implement `cancel(manager,userId,id,role)` via shared `transition()` helper → `RESERVED→CANCELLED` `reservedAmount-=qty` only in `src/modules/reservation/reservation.service.ts`
- [x] T022 [US2] Verify `ReservationController.cancel` transaction wrapper + `@Auth(User,Admin)` + `assertOwner` in `src/modules/reservation/reservation.controller.ts`

**Checkpoint**: US1 + US2 both work — cancel releases reserved without touching stock, invalid/terminal retries correctly `409`

---

## Phase 5: User Story 3 — Expire a stale hold (Priority: P1)

**Goal**: Admin `RESERVED → EXPIRED` identical inventory effect as cancel (`reserved-=qty`, stock unchanged) but **immediate admin override** regardless of `expiresAt` (Q1 A → D3); non-admin `403`; retry `EXPIRED→EXPIRED` remains `409`. See `spec.md` US3.

**Independent Test**: Create `RESERVED` `expiresAt=now+15m` → admin `PATCH /:id/expire` → `200 EXPIRED`, `reserved-=qty`; admin `expire` on future `expiresAt` still `200` (override); non-admin `403`; retry `409`; `COMPLETED/CANCELLED → EXPIRED` `409`.

### Tests for User Story 3

- [x] T023 [P] [US3] Unit test for `expire` admin-only guard + immediate override (no `expiresAt` check) in `src/modules/reservation/reservation.service.spec.ts`
- [x] T024 [P] [US3] Integration test `RESERVED→EXPIRED` immediate admin override even when `expiresAt` future in `src/modules/reservation/test/reservation.integration.spec.ts`
- [x] T025 [P] [US3] Integration test `expire` invalid edges `EXPIRED→EXPIRED` `409` + `COMPLETED→EXPIRED` `409` + non-admin `403` in `src/modules/reservation/test/reservation.integration.spec.ts`

### Implementation for User Story 3

- [x] T026 [US3] Implement `expire(manager,id)` (admin-only at controller) → shared `transition()` → `RESERVED→EXPIRED` `reserved-=qty` without `expiresAt <= NOW()` check per Q1 in `src/modules/reservation/reservation.service.ts`
- [x] T027 [US3] Verify `ReservationController.expire` remains `@Auth(Admin)` and `dataSource.transaction` wrapper in `src/modules/reservation/reservation.controller.ts` (service path bypassable for Phase 5 worker per D3)

**Checkpoint**: US1-US3 work — all three terminal transitions have correct inventory effects and role/time semantics per Q1

---

## Phase 6: User Story 4 — Reject invalid state transitions explicitly (Priority: P1)

**Goal**: Guard **all** non-allowed edges with `409`, zero inventory side-effects, and race-safe single-winner (`complete` vs `cancel` vs `expire` concurrently → one `200` one `409` or idempotent `COMPLETED→COMPLETED` `200`). See `spec.md` US4, FR-004/008, SC-004/005.

**Independent Test**: For each invalid pair (`COMPLETED→CANCELLED`, `EXPIRED→COMPLETED`, etc.) assert `409` + inventory unchanged; fire parallel `complete` vs `cancel` on same `RESERVED` → one `200` one `409`, inventory mutated exactly once; parallel `complete` vs `complete` on same `RESERVED` → one `200` `COMPLETED` one either `409` or idempotent `200` (no double `stock-=qty`).

### Tests for User Story 4

- [x] T028 [P] [US4] Unit test for `validateTransition` rejects all invalid edges (`COMPLETED→*`, `EXPIRED→*`, `CANCELLED→*`, `RESERVED→RESERVED`) in `src/modules/reservation/reservation.service.spec.ts`
- [x] T029 [P] [US4] Integration test invalid transitions `409` and inventory unchanged for each edge in `src/modules/reservation/test/reservation.integration.spec.ts`
- [x] T030 [P] [US4] Integration test concurrent race `complete` vs `cancel` on same `RESERVED` → single winner `200`/`409` and exactly one inventory mutation in `src/modules/reservation/test/reservation.integration.spec.ts`
- [x] T031 [P] [US4] Integration test rollback on missing `Inventory` (`404` inventory not found) + multi-item partial failure rollback in `src/modules/reservation/test/reservation.integration.spec.ts`
- [x] T032 [P] [US4] Integration test DB `CHECK` backstop (stock/reserved invariant `409`) and `reservedAmount<qty` guard in `src/modules/reservation/test/reservation.integration.spec.ts`

### Implementation for User Story 4

- [x] T033 [US4] Harden `validateTransition` + early idempotent `COMPLETED→COMPLETED` branch per Q4 in `src/modules/reservation/reservation.service.ts`
- [x] T034 [US4] Ensure `transition()` handles concurrent `FOR UPDATE` loss → detects `status != RESERVED` after lock and returns `409` (except idempotent `200`) + `reservedAmount` not double-decremented in `src/modules/reservation/reservation.service.ts`
- [x] T035 [US4] Add `Logger` audit for idempotent `COMPLETED→COMPLETED` second `200` path in `src/modules/reservation/reservation.service.ts` (per D6 risk mitigation)

**Checkpoint**: US1-US4 all green — every invalid edge `409`, every race single-winner, no double-release/sell

---

## Phase 7: Polish & Cross-Cutting Concerns

**Purpose**: Validate end-to-end (quickstart), harden observability, and documentation

- [x] T036 Run `npm run lint` (0 errors) and `npm run build` in `D:\Projects\mini-e-commerce\`
- [x] T037 Run full suite `npm run test -- --runInBand` (all 13+ suites green) and `npm run test:e2e -- --runInBand` in `D:\Projects\mini-e-commerce\`
- [x] T038 Validate `specs/004-reservation-lifecycle/quickstart.md` §3.1-3.7 manual flows: complete/cancel/expire, invalid `409`, concurrent race, idempotent retry, orderId overwrite in `D:\Projects\mini-e-commerce\`
- [x] T039 [P] Update `docs/plan.md` Phase 4 status `NOT DONE` → `DONE — 2026-09-14` and `AGENTS.md` module map if needed (no new module, but verify reservation row) in `docs/plan.md`
- [x] T040 [P] Add ADR `docs/decisions/0010-reservation-lifecycle-transaction-pattern.md` documenting `FOR UPDATE` reservation-first + sorted inventories, Q1-Q5 choices, idempotent `COMPLETED` semantics in `docs/decisions/`
- [x] T041 Final `git status` clean, `git log --oneline -5` confirms `004-reservation-lifecycle` history, ready for `/speckit.converge` and merge

---

## Dependencies & Execution Order

### Phase Dependencies

- **Setup (Phase 1)**: No dependencies — can start immediately
- **Foundational (Phase 2)**: Depends on Setup (T001-T004) — **BLOCKS** all user stories
- **User Stories (Phase 3-6)**: All depend on Foundational (T005-T009)
  - US1 (Complete) → MVP, no dependency on US2-4
  - US2 (Cancel) → depends on Foundational, not on US1 implementation (but reuses same `transition()` helper)
  - US3 (Expire) → depends on Foundational, independent of US1/US2
  - US4 (Invalid + Race) → depends on Foundational AND US1-US3 behaviors (but tests can be written in parallel once helper exists)
  - Can proceed **sequentially** P1 order (US1→US2→US3→US4) or **in parallel** after Foundational if staffed (different files but same `reservation.service.ts` — prefer sequential to avoid merge conflicts on that file)

### User Story Dependencies

- **US1 (P1) Complete**: Can start after Foundational — No dependencies on other stories
- **US2 (P1) Cancel**: Can start after Foundational — Independent, but shares `transition()` helper with US1 (sequential safer)
- **US3 (P1) Expire**: Can start after Foundational — Independent of US1/US2; admin-only path
- **US4 (P1) Invalid/Race**: Should start after US1-US3 at least stubbed — tests verify all three transitions' invalid edges and races

### Within Each User Story

- Tests **MUST** be written and **FAIL** before implementation (TDD per spec FR-010)
- Unit tests → Integration tests → Implementation
- Single file owner per parallel batch: `reservation.service.spec.ts` vs `reservation.integration.spec.ts` can run in parallel (different test files but same source — commit after each story)

### Parallel Opportunities

- T003-T004 (lint/build vs baseline test) can run in parallel
- T010-T014 (US1 tests across spec + integration files) can run in parallel (different test paths but same `reservation.service.ts` pending — tests themselves parallel)
- T018-T020 (US2 tests) parallel
- T023-T025 (US3 tests) parallel
- T028-T032 (US4 tests) parallel
- **Not parallelizable**: T015/T021/T026 all edit `src/modules/reservation/reservation.service.ts` — run sequentially
- Different user stories **can** be worked in parallel by different owners if they first agree on `transition()` signature in Phase 2, but within a single-agent flow, execute US1→US2→US3→US4 sequentially

---

## Parallel Example: User Story 1

```bash
# Launch US1 tests in parallel (after Phase 2 helper stub exists):
Task T010: "Unit test for complete success path in src/modules/reservation/reservation.service.spec.ts"
Task T011: "Unit test for orderId overwrite + idempotent COMPLETED->COMPLETED in src/modules/reservation/reservation.service.spec.ts"
Task T012: "Integration test RESERVED->COMPLETED happy in src/modules/reservation/test/reservation.integration.spec.ts"
# These three edit different test blocks and can run together.

# Implementation must be sequential after tests fail:
Task T015: "Implement complete(manager,...) in src/modules/reservation/reservation.service.ts"
```

---

## Implementation Strategy

### MVP First (User Story 1 Only)

1. Complete Phase 1: Setup (T001-T004)
2. Complete Phase 2: Foundational (T005-T009) — transition helper stubs + sorted locks + error mapping
3. Complete Phase 3: US1 Complete (T010-T017) — `COMPLETED` transactional path + idempotent
4. **STOP and VALIDATE**: `npm run test -- --runInBand` for US1, manual `PATCH /:id/complete` via `quickstart.md` §3.1
5. Deploy/demo if ready — sale path works without cancel/expire

### Incremental Delivery

1. Setup + Foundational → Foundation ready (locks + helper)
2. Add US1 (Complete) → Test independently → Demo (MVP!)
3. Add US2 (Cancel) → Test independently → Demo
4. Add US3 (Expire) → Test independently → Demo (admin override verified)
5. Add US4 (Invalid/Race) → Test independently → Demo (single-winner guarantee)
6. Each story adds value without breaking previous stories (all `409`/`200` semantics preserved)

### Parallel Team Strategy

With multiple developers (after Foundational agreement on `transition(reservationId, to)` signature):

1. Team completes Setup + Foundational together
2. Once Foundational is done:
   - Developer A: US1 Complete (owns `complete` branch of `transition`)
   - Developer B: US2 Cancel (owns `cancel` branch)
   - Developer C: US3 Expire (owns `expire` branch)
   - Developer D: US4 Invalid/Race tests (reads all three)
3. Merge sequentially into `reservation.service.ts` (resolve conflicts on shared helper)
4. Validate with `npm run test -- --runInBand` after each merge

---

## Notes

- [P] tasks = different files, no dependencies
- [Story] label maps task to specific user story for traceability (US1-US4)
- Each user story independently completable and testable per `quickstart.md`
- Verify tests **FAIL** before implementing (red-green)
- Each story's tests use real PostgreSQL via `DataSource` + `dataSource.transaction(manager=>…)` (mirrors controller)
- Commit after each task or logical group; push only after full story green
- Stop at any checkpoint to validate story independently (especially after US1 MVP)
- Avoid: vague tasks, missing file paths, same-file parallel edits, cross-story dependencies that break independence
- `--runInBand` is required for integration suite (see `quickstart.md` and research D9)
