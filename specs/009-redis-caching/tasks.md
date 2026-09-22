---
description: "Task list template for feature implementation"
---

# Tasks: Redis / Product Caching (Phase 9)

**Input**: Design documents from `/specs/009-redis-caching/`  
**Prerequisites**: plan.md (required), spec.md (required for user stories), research.md, data-model.md, contracts/  
**Branch**: `009-redis-caching` | **Spec**: [spec.md](./spec.md) | **Plan**: [plan.md](./plan.md)

**Tests**: FR-009 mandates DB-backed tests (unit mocked + integration real PG + E2E GraphQL). Tests are REQUIRED per constitution VII.

**Organization**: Tasks are grouped by user story to enable independent implementation and testing of each story.

## Format: `[ID] [P?] [Story] Description`

- **[P]**: Can run in parallel (different files, no dependencies)
- **[Story]**: Which user story this task belongs to (e.g., US1, US2, US3)
- Include exact file paths in descriptions

## Path Conventions

- **Single project**: `src/`, `specs/` at repository root
- Paths shown below assume single project - adjust based on plan.md structure

---

## Phase 1: Setup (Shared Infrastructure)

**Purpose**: Project initialization, env and tooling for caching

- [ ] T001 Verify Redis infra and env defaults in `.env` and `.env.example` per plan (REDIS_URL, PRODUCT_LIST_CACHE_TTL_MS=60000, PRODUCT_SINGLE_CACHE_TTL_MS=300000, docs clamps)
- [ ] T002 [P] Ensure docker-compose Redis 8 healthy and `CacheModule` global config in `src/app.module.ts` uses `createKeyv(REDIS_URL)` with `ttl: 60*1000` fallback
- [ ] T003 [P] Confirm `src/cache-test.service.ts` onModuleInit logs `Redis connection successfully verified` without crashing on failure

---

## Phase 2: Foundational (Blocking Prerequisites)

**Purpose**: Core caching infrastructure that MUST be complete before ANY user story can be implemented

**⚠️ CRITICAL**: No user story work can begin until this phase is complete

- [ ] T004 [P] Add ConfigService-based TTL helper in `src/modules/products/products.service.ts` (`parseTtlMs` with `PRODUCT_LIST_CACHE_TTL_MS` / `PRODUCT_SINGLE_CACHE_TTL_MS`, clamp `list>=5000 single>=30000`, `Logger.warn` + `Logger.log Product cache TTLs: list=* single=*`)
- [ ] T005 [P] Add private cache key helpers in `src/modules/products/products.service.ts` (`buildKeyList(page,limit) → products:list:{page}:{limit}`, `buildKeySingle(id) → product:{id}`)
- [ ] T006 Create private invalidation helpers in `src/modules/products/products.service.ts` (`invalidateSingle(id)` via `cacheManager.del`, `invalidateAllLists()` via `store.keys('products:list:*')→del` selective + `clear()` fallback with `Logger.warn`, `invalidateProductCaches(ids[])`)
- [ ] T007 Configure `CACHE_MANAGER` and `ConfigService` injection in `src/modules/products/products.module.ts` (keep `TypeOrmModule.forFeature([Product])` + `forwardRef(InventoryModule)`, ensure `CACHE_MANAGER` token and `ConfigService` available for TTLs)
- [ ] T008 Add class-level JSDoc and method-level JSDoc stubs in `src/modules/products/products.service.ts` per AGENTS.md §3 (service responsible for product catalog and product-cache cache-aside)

**Checkpoint**: Foundation ready - user story implementation can now begin in parallel

---

## Phase 3: User Story 1 - Product listing is fast on second read (cache hit) after a miss (Priority: P1) 🎯 MVP

**Goal**: `findAll(page,limit)` cache-aside `products:list:{page}:{limit}` with TTL 60s; first miss populates, second hit returns without DB

**Independent Test**: Seed 3 products, FLUSHDB, `findAll({page:1,limit:10})` → `Cache MISS` + `findAndCount` called once + `set`; second identical → `Cache HIT` + `findAndCount` not called again + deep-equal payload; different pagination `1:10` vs `2:10` isolated; TTL expiry re-misses

### Tests for User Story 1 (write FIRST, ensure FAIL before implementation)

- [ ] T009 [P] [US1] Unit test `findAll` miss→hit in `src/modules/products/products.service.spec.ts` (mock `CACHE_MANAGER` get returns undefined then cached, verify `findAndCount` spy calledOnce, `Logger.debug` HIT/MISS, TTL arg 60000)
- [ ] T010 [P] [US1] Unit test `findAll` pagination isolation in `src/modules/products/products.service.spec.ts` (`products:list:1:10` hit does not serve `products:list:2:10`)
- [ ] T011 [P] [US1] Unit test `findAll` TTL expiry re-miss in `src/modules/products/products.service.spec.ts` (mock expired = undefined → second miss → findAndCount again)

### Implementation for User Story 1

- [ ] T012 [US1] Implement cache-aside in `src/modules/products/products.service.ts` `findAll` (compute `key=buildKeyList(page,limit)`, `try/catch get` → HIT return, MISS → `findAndCount({take:limit, skip:(page-1)*limit})` → build `{data,meta}`, `try/catch set(key, result, listTtl)`, `Logger.debug` HIT/MISS, fail-open on throw, no Redis I/O inside transaction)
- [ ] T013 [US1] Verify GraphQL `products` query thin passthrough in `src/modules/products/products.resolver.ts` (no cache logic moved to resolver, `findAll` delegates to service)

**Checkpoint**: At this point, User Story 1 should be fully functional and testable independently (SC-001, SC-002 list side)

---

## Phase 4: User Story 2 - Any product mutation promptly invalidates the affected caches (Priority: P1)

**Goal**: Every successful `create`/`createMany`/`update`/`updateMany`/`remove`/`resetAll` invalidates **all** `products:list:*` + affected `product:{id}` after DB commit, never on failure

**Independent Test**: `products:list:1:10` cached → `createProduct` success → lists cleared → next `findAll` miss `totalItems+1`; `updateMany` 5 ids → 5 singles + lists cleared; failure duplicate 409/400/404 → no invalidation → next `findAll` still HIT

### Tests for User Story 2 (write FIRST, ensure FAIL)

- [ ] T014 [P] [US2] Unit test `create` invalidates all `products:list:*` in `src/modules/products/products.service.spec.ts` (mock `store.keys` returns `[products:list:1:10,products:list:2:10]` → `del` called per key, verify `del` called before next `findAll` miss)
- [ ] T015 [P] [US2] Unit test `update` invalidates `product:{id}` + lists in `src/modules/products/products.service.spec.ts` (single del + lists)
- [ ] T016 [P] [US2] Unit test `updateMany` invalidates each `product:{id}` + lists in `src/modules/products/products.service.spec.ts` (5 del singles + lists, mock `DataSource.transaction` resolving → helpers called after)
- [ ] T017 [P] [US2] Unit test `remove`/`resetAll` invalidates `product:{id}` + lists in `src/modules/products/products.service.spec.ts`
- [ ] T018 [P] [US2] Unit test no invalidation on failure in `src/modules/products/products.service.spec.ts` (duplicate name `ConflictException` → `del` never called, `clear` never called, next `findAll` still HIT)

### Implementation for User Story 2

- [ ] T019 [US2] Add post-commit `invalidateAllLists` + `invalidateSingle` calls after `save` in `src/modules/products/products.service.ts` `create` (after `productsRepo.save` success)
- [ ] T020 [US2] Add invalidation after `save` in `src/modules/products/products.service.ts` `createMany` (after batch save, lists only)
- [ ] T021 [US2] Add `del product:{id}` + lists after `save` in `src/modules/products/products.service.ts` `update` (after `productsRepo.save` success)
- [ ] T022 [US2] Add invalidation after transaction commit in `src/modules/products/products.service.ts` `updateMany` (outside `dataSource.transaction` promise, after `manager.save` resolves, for each id + lists)
- [ ] T023 [US2] Add `del product:{id}` + lists after `delete` in `src/modules/products/products.service.ts` `remove`, and namespace clear for `src/modules/products/products.service.ts` `resetAll`/`deleteAll` (all `product:*` + lists via `invalidateProductCaches` or `clear()` fallback)

**Checkpoint**: At this point, User Stories 1 AND 2 should both work independently (SC-003, SC-005 bulk part, SC-006)

---

## Phase 5: User Story 3 - Single product fetch is cached and shares invalidation with the list (Priority: P2)

**Goal**: `findOne(id)` cache-aside `product:{id}` TTL 300s (no negative cache), invalidated together with lists on mutation

**Independent Test**: `findOne(id:known)` miss → `findOne` DB + `set product:known` 300s, second → HIT no DB, `updateProduct` then both `product:known` + lists invalidated → next `findOne` miss `price 999`

### Tests for User Story 3 (write FIRST)

- [ ] T024 [P] [US3] Unit test `findOne` miss→hit + no negative cache in `src/modules/products/products.service.spec.ts` (first `get` undefined → `findOne` DB + `set` 300000, second `get` hit → no DB, null from repo not cached)
- [ ] T025 [P] [US3] Unit test `findOne` invalidated by `update`/`remove` in `src/modules/products/products.service.spec.ts` (cached single → after `update` single del + lists cleared → next `findOne` miss)

### Implementation for User Story 3

- [ ] T026 [US3] Implement cache-aside in `src/modules/products/products.service.ts` `findOne` (`key=product:{id}`, `try/catch get` → HIT return, MISS → `findOne({where:{id}})`, if null return null without set, else `try/catch set(key, product, singleTtl)`, `Logger.debug` HIT/MISS, fail-open)
- [ ] T027 [US3] Wire `findOne` invalidation already covered by US2 helpers (verify `update`/`remove` already call `invalidateSingle` + `invalidateAllLists` → no extra code, just ensure `findOne` cache respects it)

**Checkpoint**: All user stories so far (US1+US2+US3) independently functional (SC-004, SC-005 single part)

---

## Phase 6: User Story 4 - Redis failures never break product reads, and inventory is never served from cache (Priority: P2)

**Goal**: Every `get/set/del/keys/clear` is fail-open (`try/catch` + `Logger.warn`); `Inventory`/`Reservation`/`Order`/`Cart` paths never touch `CACHE_MANAGER`

**Independent Test**: Mocked `cacheManager` throwing on `get/set/del` → `findAll`/`findOne` still 200 from DB + `warn`; `createProduct` with `del` throw still commits 201 + `warn`; spy `cacheManager.get` never called inside `cart/inventory/reservation/order`

### Tests for User Story 4 (write FIRST)

- [ ] T028 [P] [US4] Unit test fail-open `findAll` get throws in `src/modules/products/products.service.spec.ts` (mock `get` rejects `ECONNREFUSED` → still returns DB `data/meta` + `Logger.warn` called, no throw)
- [ ] T029 [P] [US4] Unit test fail-open `findAll` set throws + mutation del throws in `src/modules/products/products.service.spec.ts` (mock `set` reject during populate → still 200, mock `del` reject during `create` → still 201 + `warn`)
- [ ] T030 [P] [US4] Unit test fail-open `findOne` get/set throws in `src/modules/products/products.service.spec.ts`
- [ ] T031 [P] [US4] Unit test inventory never cached audit in `src/modules/products/products.service.spec.ts` (spy `CACHE_MANAGER.get` never called inside inventory path, `productsService` never stores `stock/reservedAmount` in cached value, grep audit `CACHE_MANAGER` only in `ProductsModule`/`CacheTestService`)

### Implementation for User Story 4

- [ ] T032 [US4] Wrap every `cacheManager.get/set/del` with fail-open `try/catch` + `Logger.warn` in `src/modules/products/products.service.ts` (`findAll` get, `findAll` set, `findOne` get, `findOne` set)
- [ ] T033 [US4] Wrap `invalidateSingle` and `invalidateAllLists` (`store.keys` + `del` per key + `clear()` fallback) with `try/catch` + `Logger.warn` in `src/modules/products/products.service.ts`
- [ ] T034 [US4] Audit and enforce `CACHE_MANAGER` only in `src/modules/products/products.module.ts` + `src/cache-test.service.ts` (grep `CACHE_MANAGER` must return 0 in `src/modules/cart`, `src/modules/inventory`, `src/modules/reservation`, `src/modules/order`), document in `docs/architecture/modules.md`

**Checkpoint**: User Story 4 complete; reliability invariant SC-007, SC-008 verified

---

## Phase 7: Polish & Cross-Cutting Concerns

**Purpose**: Config, docs, validation, build

- [ ] T035 [P] Add `PRODUCT_LIST_CACHE_TTL_MS` and `PRODUCT_SINGLE_CACHE_TTL_MS` to `.env.example` with defaults `60000`/`300000` and clamp docs in `src/modules/products/products.service.ts` (`parseTtlMs` minima `5000`/`30000`)
- [ ] T036 [P] Update architecture docs in `docs/architecture/modules.md` or `docs/architecture/products-caching.md` (keys `product:{id}`/`products:list:{page}:{limit}`, TTLs, cache-aside flow, after-commit selective `keys→del` vs `clear()` fallback, fail-open, inventory never cached per FR-007)
- [ ] T037 [P] Run `quickstart.md` validation: `docker-compose up -d`, `FLUSHDB`, `products` miss→hit, `FLUSHDB` re-miss, `createProduct`/`updateProduct` invalidation, `findOne` hit, Redis `stop` fail-open still 200, `grep -rn CACHE_MANAGER src/modules/cart|inventory|reservation|order` 0 hits
- [ ] T038 Verify `npm run build` + `npm run lint` + `npm run test -- --runInBand` pass (8+ new cache tests + existing 19 suites) and `specs/009-redis-caching/checklists/requirements.md` green

---

## Dependencies & Execution Order

### Phase Dependencies

- **Setup (Phase 1)**: No dependencies - can start immediately
- **Foundational (Phase 2)**: Depends on Setup completion - BLOCKS all user stories
- **User Stories (Phase 3+)**: All depend on Foundational phase completion
  - User stories can then proceed in parallel (if staffed)
  - Or sequentially in priority order (P1 → P2 → P1? US1→US2 both P1 then P2 US3→US4)
- **Polish (Final Phase)**: Depends on all desired user stories being complete

### User Story Dependencies

- **User Story 1 (P1)**: Can start after Foundational (Phase 2) - No dependencies on other stories
- **User Story 2 (P1)**: Can start after Foundational (Phase 2) - Depends on US1 cache keys existing but independently testable; shares `invalidateAllLists` helper (implement in US2 phase even if US1 already uses keys)
- **User Story 3 (P2)**: Can start after Foundational (Phase 2) - May integrate with US2 invalidation but independently testable for single hit/miss
- **User Story 4 (P2)**: Can start after Foundational (Phase 2) - Wraps all prior cache calls with fail-open; should be applied after US1-US3 cache calls exist but testable by mocking throw on otherwise-correct US1-US3 implementation

### Within Each User Story

- Tests (if included) MUST be written and FAIL before implementation
- Helpers (`buildKeyList`/`invalidateAllLists`) before `findAll`/`findOne` cache logic
- Core implementation before integration
- Story complete before moving to next priority

### Parallel Opportunities

- All Setup tasks marked [P] can run in parallel
- All Foundational tasks marked [P] can run in parallel (within Phase 2) — T004, T005 parallel
- Once Foundational phase completes, all user stories can start in parallel (if team capacity allows) — but P1 stories (US1, US2) should be staffed first for MVP
- All tests for a user story marked [P] can run in parallel — T009/T010/T011 together; T014-T018 together
- Within US4, T028-T031 parallel
- Polish docs T035/T036 parallel

---

## Parallel Example: User Story 1

```bash
# Launch all tests for User Story 1 together (fail-first in same spec file but parallelizable per test file):
Task: "Unit test findAll miss→hit in src/modules/products/products.service.spec.ts" # T009
Task: "Unit test findAll pagination isolation in src/modules/products/products.service.spec.ts" # T010
Task: "Unit test findAll TTL expiry re-miss in src/modules/products/products.service.spec.ts" # T011

# Implementation then parallel-safe:
Task: "Implement cache-aside in src/modules/products/products.service.ts findAll" # T012
# Resolver thin check is separate file:
Task: "Verify resolver thin in src/modules/products/products.resolver.ts" # T013 [could run in parallel if no file conflict]
```

---

## Implementation Strategy

### MVP First (User Story 1 Only)

1. Complete Phase 1: Setup (T001-T003)
2. Complete Phase 2: Foundational (T004-T008) — CRITICAL - blocks all stories
3. Complete Phase 3: User Story 1 (T009-T013)
4. **STOP and VALIDATE**: Test User Story 1 independently via `npm run test -- src/modules/products/products.service.spec.ts --runInBand` (miss→hit, isolation)
5. Deploy/demo if ready — listing is fast, but still stale until US2 invalidation

### Incremental Delivery

1. Complete Setup + Foundational → Foundation ready (T001-T008)
2. Add User Story 1 → Test independently → Deploy/Demo (MVP! list cached)
3. Add User Story 2 → Test independently → Deploy/Demo (invalidation safe, SC-003/006)
4. Add User Story 3 → Test independently → Deploy/Demo (single detail cached, SC-004)
5. Add User Story 4 → Test independently → Deploy/Demo (fail-open + inventory isolation, SC-007/008)
6. Polish → `npm run build/lint/test` + `quickstart.md` FLUSHDB manual
7. Each story adds value without breaking previous stories

### Parallel Team Strategy

With multiple developers:

1. Team completes Setup + Foundational together (T001-T008)
2. Once Foundational is done:
   - Developer A: User Story 1 (T009-T013)
   - Developer B: User Story 2 (T014-T023) — can start after A defines `buildKeyList` but shares helpers
   - Developer C: User Story 3 (T024-T027)
   - Developer D: User Story 4 (T028-T034) — wraps existing cache calls; can pair with A-C
3. Stories complete and integrate independently
4. Polish together (T035-T038)

---

## Notes

- [P] tasks = different files, no dependencies
- [Story] label maps task to specific user story for traceability
- Each user story should be independently completable and testable
- Verify tests fail before implementing (TDD: spec FR-009 → write failing spy tests T009-T011 before T012)
- Commit after each task or logical group (atomic cache helper change)
- Stop at any checkpoint to validate story independently (US1 MVP stop, US2 P1 pair stop)
- Avoid: vague tasks, same file conflicts (serialize `products.service.ts` edits: US1 T012 before US2 T019 before US3 T026 before US4 T032), cross-story dependencies that break independence
- File path rule: every task description includes exact file path (AGENTS.md §3 JSDoc required for `ProductsService` changes)
