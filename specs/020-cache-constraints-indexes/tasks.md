# Tasks: Cache Constraints Indexes

**Input**: Design documents from `/specs/020-cache-constraints-indexes/`
**Prerequisites**: plan.md, spec.md, research.md, data-model.md, contracts/, quickstart.md

**Tests**: Included — spec SC-001…SC-005 are test-verified outcomes (miss/hit/invalidation, namespace preservation, constraint rejection, EXPLAIN, never-authoritative proof).

**Organization**: Grouped by user story; each story independently testable.

## Format: `[ID] [P?] [Story] Description`

- **[P]**: Can run in parallel (different files, no dependencies on incomplete tasks)
- **[Story]**: Which user story this task belongs to (US1, US2, US3)

---

## Phase 1: Setup (Shared Infrastructure)

**Purpose**: Infra up + green baseline before changes

- [X] T001 Start local infra via `docker-compose.yml` (postgres 5432, redis 6379) and verify both reachable per `specs/020-cache-constraints-indexes/quickstart.md` §1
- [X] T002 Record green baseline (`npm run build` + `npm run test -- --runInBand src/modules/products`) before changes in `specs/020-cache-constraints-indexes/`

---

## Phase 2: Foundational (Blocking Prerequisites)

**Purpose**: Audit-first evidence that gates migration DDL (2026-10-09 clarification)

**⚠️ CRITICAL**: No migration task (T016) begins until this phase is recorded in `data-model.md` §Audit

- [X] T003 [P] Run CHECK-violation audit queries (Product price, Order total, Payment amount, Inventory/quantity tables) and record counts + cleanup decision in `specs/020-cache-constraints-indexes/data-model.md`
- [X] T004 [P] Run EXPLAIN audit on hot paths (expiry scan, order-by-user, inventory-by-product, order-items-by-order, order-createdAt range) and record plans + final ≤3 index list in `specs/020-cache-constraints-indexes/data-model.md`

**Checkpoint**: Audit recorded — migration scope locked, user-story work can begin

---

## Phase 3: User Story 1 - Fast, correct product catalog (Priority: P1) 🎯 MVP

**Goal**: Cache-aside miss/hit with deterministic order, pinned TTLs, invalidation on every mutation

**Independent Test**: Browse list twice (miss then hit identical), admin mutates, next read reflects change; availability still from live data

### Tests for User Story 1 ⚠️

> **NOTE: Write these tests FIRST, ensure they FAIL before implementation**

- [X] T005 [US1] Unit key-completeness test (every `findAll` input participates in cache key) in `src/modules/products/products.service.spec.ts`
- [X] T006 [US1] Unit deterministic-order passthrough + TTL warn-fallback tests in `src/modules/products/products.service.spec.ts`

### Implementation for User Story 1

- [X] T007 [US1] Add `ORDER BY created_at ASC, id ASC` to `findAndCount` in `src/modules/products/products.service.ts`
- [X] T008 [US1] Document TTL ms unit + defaults (list 60_000, single 300_000) beside `parseTtlMs` in `src/modules/products/products.service.ts`
- [X] T009 [US1] Live miss→hit→mutate→miss integration suite in `src/modules/products/test/products-cache.integration.spec.ts` (real Redis, per `quickstart.md` §3)

**Checkpoint**: US1 independently functional — repeat reads cached + ordered, mutations invalidate

---

## Phase 4: User Story 2 - Shared cache never wiped (Priority: P1)

**Goal**: Selective invalidation only; `clear()` gone from every product path; version-stamp fallback

**Independent Test**: Seed `rl:*`/`expiration:*`/`notification:*`/cooldown keys, run all six mutation invalidations, assert non-product namespaces intact

### Tests for User Story 2 ⚠️

- [X] T010 [US2] Unit test asserting `cacheManager.clear()` never called on any mutation path in `src/modules/products/products.service.spec.ts`
- [X] T011 [P] [US2] Real-Redis namespace-preservation integration in `src/modules/products/test/products-cache.integration.spec.ts`

### Implementation for User Story 2

- [X] T012 [US2] Delete both `clear()` fallbacks and add `products:cache-version` stamp fallback in `src/modules/products/products.service.ts` (per `contracts/cache-invalidation.md`)
- [X] T013 [US2] Extend `products-cache.integration.spec.ts` with `resetAll` selective-invalidation case in `src/modules/products/test/products-cache.integration.spec.ts`

**Checkpoint**: US1 + US2 green — invalidation namespace-safe on all paths

---

## Phase 5: User Story 3 - DB backstops + hot-path indexes (Priority: P2)

**Goal**: Audit-gated `CHECK`s + ≤3 proven indexes via one additive migration, PG-proven

**Independent Test**: Direct invalid writes rejected with no partial state; `EXPLAIN` shows index use on all hot paths

### Tests for User Story 3 ⚠️

- [X] T017 [P] [US3] Real-PG constraint-rejection tests (negative price/stock, over-reserved, non-positive quantity) in `src/modules/products/test/` + audit-found module suites (depends on T016)
- [X] T018 [P] [US3] Real-PG `EXPLAIN` index-usage tests for hot paths in `src/modules/products/test/` + audit-found module suites (depends on T016)

### Implementation for User Story 3

- [X] T014 [US3] Add `@Check('"price" >= 0')` (+ audit-approved extra checks) in `src/modules/products/entities/product.entity.ts` and audit-found entity files (depends on T003)
- [X] T015 [US3] Add ≤3 audit-approved `@Index`es in entity files per `data-model.md` §Audit (depends on T004)
- [X] T016 [US3] Create additive migration `src/migration/1755900000013-*.ts` (guarded adds, `down` drops only what `up` added; depends on T003, T004, T014, T015)
- [X] T019 [P] [US3] Never-authoritative proof test (identical checkout with cache warm / cold / Redis down) in `src/modules/products/test/products-cache.integration.spec.ts` (depends on T007, T012)

**Checkpoint**: All stories independently functional; migration green on clean + dirty-data paths

---

## Phase 6: Polish & Cross-Cutting Concerns

**Purpose**: Close-out verification + docs

- [X] T020 Full verification per `quickstart.md` §3 (`npm run lint`, `npm run build`, unit + integration + e2e) from repo root
- [X] T021 [P] Tick `docs/plan.md` Phase 9 tasks + Phase 13 exit with EXPLAIN evidence and add decision note in `docs/decisions/`
- [X] T022 End-to-end validation run of `specs/020-cache-constraints-indexes/quickstart.md` from repo root (depends on T020)

---

## Dependencies & Execution Order

### Phase Dependencies

- **Setup (Phase 1)**: No dependencies — start immediately
- **Foundational (Phase 2)**: Depends on Setup — BLOCKS migration (T016) only; US1/US2 code work may overlap audit
- **User Stories (Phase 3+)**: US1, US2 depend on Setup; US3 impl depends on Foundational audit (T003/T004)
- **Polish (Phase 6)**: Depends on all stories complete

### User Story Dependencies

- **US1 (P1)**: After Setup — no other story deps (MVP)
- **US2 (P1)**: After Setup — shares `products.service.ts` with US1 (sequence T007/T008 before T012, same file)
- **US3 (P2)**: After Foundational audit — independent files except `products-cache.integration.spec.ts` shared with US1/US2 (sequence appends)

### Within Each User Story

- Tests written FIRST and FAIL before implementation (T005/T006 → T007/T008; T010 → T012; T017/T018 → T016)
- Same-file tasks run sequentially (no [P]): T005/T006/T010 share `products.service.spec.ts`; T007/T008/T012 share `products.service.ts`; T009/T011/T013/T019 share `products-cache.integration.spec.ts`

### Parallel Opportunities

- T003 ∥ T004 (audit queries, different concerns)
- T005 ∥ T011 (different files: unit spec vs integration spec)
- T017 ∥ T018 ∥ T019 after T016 (different suites, all depend on migration only)
- T021 ∥ T020 (docs vs verification run)

---

## Parallel Example: Foundational + US1 tests

```bash
# Launch audit pair together:
Task: "Run CHECK-violation audit queries in specs/020-cache-constraints-indexes/data-model.md"
Task: "Run EXPLAIN audit on hot paths in specs/020-cache-constraints-indexes/data-model.md"

# Launch US1/US2 test tasks in different files together:
Task: "Unit key-completeness test in src/modules/products/products.service.spec.ts"
Task: "Real-Redis namespace-preservation integration in src/modules/products/test/products-cache.integration.spec.ts"
```

---

## Implementation Strategy

### MVP First (User Story 1 Only)

1. Complete Phase 1: Setup (T001–T002)
2. Complete Phase 3: US1 tests-first → impl (T005–T009)
3. **STOP and VALIDATE**: miss/hit/invalidation live on real Redis
4. Demo if ready (catalog freshness proven)

### Incremental Delivery

1. Setup → US1 (MVP: fast + fresh catalog)
2. Add US2 (namespace-safe invalidation) → redeploy
3. Foundational audit → US3 (backstops + indexes) → redeploy
4. Polish: plan checkboxes + decision note

---

## Notes

- [P] = different files, no unfinished deps; same-file tasks always sequential
- [USn] maps task to spec user story for traceability
- Total: 22 tasks (Setup 2, Foundational 2, US1 5, US2 4, US3 6, Polish 3)
- Suggested MVP: US1 only (T001–T002 + T005–T009)
- Commit after each task or logical group; stop at any checkpoint to validate
