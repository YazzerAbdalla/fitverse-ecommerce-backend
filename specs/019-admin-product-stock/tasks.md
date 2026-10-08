# Tasks: Admin Product & Stock (Phase 20 Demo Scope)

**Input**: Design documents from `/specs/019-admin-product-stock/` (spec.md clarified 5/5, plan.md, research.md D1–D8, data-model.md, contracts/admin-products.md, quickstart.md)
**Prerequisites**: plan.md, spec.md (US1 P1, US2 P1, US3 P2, US4 P3 boundary — no implementation)

**Tests**: Included — required by spec acceptance scenarios (per-story **Acceptance Scenarios** + SC-002/SC-004/SC-005) and constitution VII (DB-backed consistency proofs). Unit specs mock collaborators; integration specs run against real PostgreSQL.

**Organization**: One phase per user story (priority order). US4 (out-of-scope marker) has no tasks by design.

## Format: `[ID] [P?] [Story] Description`

- **[P]**: Can run in parallel (different files, no dependencies)
- **[Story]**: Which user story this task belongs to (e.g., US1, US2, US3)

## Phase 1: Setup (Shared Infrastructure)

**Purpose**: Dashboard module shell + shared throttle keys so story work has a place to land

- [ ] T001 Create dashboard module shell per plan.md structure in `src/modules/dashboard/dashboard.module.ts` (imports ProductsModule, InventoryModule, AuthModule) and register DashboardModule in `src/app.module.ts`
- [ ] T002 [P] Add `POST /admin/products` and `PATCH /admin/products/:id/stock` route keys (30/h per admin, same quota family) in `src/modules/auth/guards/rate-limit.guard.ts`
- [ ] T003 Verify setup compiles via `npm run build` (scope: `src/modules/dashboard/`, `src/app.module.ts`, `src/modules/auth/guards/rate-limit.guard.ts`)

---

## Phase 2: Foundational (Blocking Prerequisites)

**Purpose**: Shared stock-adjust primitive every write story builds on (US3 directly; US2's create path is independent but shares the module)

**⚠️ CRITICAL**: No user story work can begin until this phase is complete

- [ ] T004 Unit tests for `adjustStockByDelta` delegation matrix (positive→increase, negative→decrease, guards preserved) in `src/modules/inventory/inventory.service.spec.ts` (write first, fail before T005)
- [ ] T005 Implement `InventoryService.adjustStockByDelta` with JSDoc in `src/modules/inventory/inventory.service.ts` (delegates to `increaseStock`/`decreaseStock`, zero rejected by DTO)
- [ ] T006 Verify foundation via `npm run build` and `npm run test -- --runInBand src/modules/inventory` (scope: `src/modules/inventory/inventory.service.ts`, `src/modules/inventory/inventory.service.spec.ts`)

**Checkpoint**: Foundation ready — user story implementation can now begin in parallel

---

## Phase 3: User Story 1 - View current products with stock status (Priority: P1) 🎯 MVP

**Goal**: Admin paginated product list with search/filters and auto-calculated `in-stock` / `low-stock` / `out-of-stock` per row

**Independent Test**: Sign in as admin, open the list, confirm every row shows current quantity + correct status (threshold default 5 and per-request override both verified); customer access denied

### Tests for User Story 1 ⚠️

> NOTE: Write these tests FIRST, ensure they FAIL before implementation (T009–T011)

- [ ] T007 [P] [US1] Unit tests for list math (status matrix, threshold override, missing-inventory→out-of-stock, combined filters, pagination meta) in `src/modules/dashboard/admin-products.service.spec.ts`
- [ ] T008 [P] [US1] Integration test for admin list round-trip on real PG (seeded products + threshold/filter variants) in `src/modules/dashboard/test/admin-products.integration.spec.ts`

### Implementation for User Story 1

- [ ] T009 [P] [US1] Create list query DTO (`search/status/minPrice/maxPrice/lowThreshold/page/limit` with bounds) in `src/modules/dashboard/dto/admin-product-list.query.dto.ts`
- [ ] T010 [US1] Implement `listAdminProducts` (single join query, derived `available`/`status`, envelope `{data, meta}`) with JSDoc in `src/modules/dashboard/admin-products.service.ts` (depends on T009)
- [ ] T011 [US1] Implement `GET /admin/products` thin handler (`@Auth(Admin)`, Swagger `@ApiResponse` 200/400/401/403) in `src/modules/dashboard/admin-products.controller.ts` (depends on T010)

**Checkpoint**: US1 fully functional and testable independently (quickstart §1–§2 green)

---

## Phase 4: User Story 2 - Add a new product with initial stock (Priority: P1)

**Goal**: Admin creates a product with optional initial stock (omitted ⇒ 0 ⇒ `out-of-stock`); duplicates/negatives rejected with nothing created

**Independent Test**: Create one product as admin, find it in the admin list with the expected status; duplicate name → 409; customer create → 403

### Tests for User Story 2 ⚠️

> NOTE: Write these tests FIRST, ensure they FAIL before implementation (T014)

- [ ] T012 [P] [US2] Unit tests for create DTO validation + duplicate/negative rejection (mocked `ProductsService`) in `src/modules/dashboard/admin-products-create.spec.ts`
- [ ] T013 [P] [US2] Integration test for create→list round-trip on real PG (explicit stock, omitted stock ⇒ 0/out-of-stock, duplicate ⇒ 409) in `src/modules/dashboard/test/admin-products-create.integration.spec.ts`

### Implementation for User Story 2

- [ ] T014 [P] [US2] Create product DTO (`name/description/price/stock?`, stock optional `>= 0`) in `src/modules/dashboard/dto/admin-create-product.dto.ts`
- [ ] T015 [US2] Implement `POST /admin/products` thin handler delegating to `ProductsService.create` (`@Auth(Admin)`, `RateLimitGuard` quota, Swagger 201/400/401/403/409/429) in `src/modules/dashboard/admin-products.controller.ts` (depends on T014)

**Checkpoint**: US1 AND US2 both work independently (quickstart §3 green)

---

## Phase 5: User Story 3 - Update stock for an existing product (Priority: P2)

**Goal**: Admin delta-only stock adjustment (`delta ≠ 0`); below-zero/below-reserved rejected with stock unchanged

**Independent Test**: Adjust one product up and down as admin, re-read to see recalculated status; over-decrement → 409 unchanged; absolute-set attempt → 400; customer adjust → 403

### Tests for User Story 3 ⚠️

> NOTE: Write these tests FIRST, ensure they FAIL before implementation (T018–T019)

- [ ] T016 [P] [US3] Unit tests for adjust DTO (`delta ≠ 0`, integer) + `409` below-reserved/below-zero matrix (mocked `InventoryService`) in `src/modules/dashboard/admin-products-stock.spec.ts`
- [ ] T017 [P] [US3] Integration tests on real PG: adjust up/down, `409` leaves stock unchanged, concurrent same-product adjusts last-writer-wins with guards intact in `src/modules/dashboard/test/admin-products-stock.integration.spec.ts`

### Implementation for User Story 3

- [ ] T018 [P] [US3] Create adjust DTO (`delta: int, @NotEquals(0)`) in `src/modules/dashboard/dto/adjust-stock.dto.ts`
- [ ] T019 [US3] Implement `PATCH /admin/products/:id/stock` thin handler delegating to `adjustStockByDelta` + post-commit list-cache invalidation (`@Auth(Admin)`, throttle quota, Swagger 200/400/401/403/404/409/429) in `src/modules/dashboard/admin-products.controller.ts` (depends on T018 and Phase 2)

**Checkpoint**: All user stories independently functional (quickstart §4–§5 green)

---

## Phase 6: Polish & Cross-Cutting Concerns

**Purpose**: Contract parity, docs, full-flow proof, verification gates (US4 needs no code — boundary already locked in spec FR-010/FR-012)

- [ ] T020 [P] Swagger audit: `@ApiResponse` coverage for 200/201/400/401/403/404/409/429 on all three admin routes in `src/modules/dashboard/admin-products.controller.ts`
- [ ] T021 [P] Record ADR (`docs/decisions/`) + update `docs/architecture/modules.md` (dashboard section) + `docs/plan.md` Phase 20 exit checkboxes
- [ ] T022 E2E flow (supertest): admin list→create→adjust→re-list plus customer `403` on all three routes in `test/admin-products.e2e-spec.ts`
- [ ] T023 JSDoc/lint pass: class + method JSDoc per AGENTS.md §3 on all touched files, zero new `any`, `npm run lint` clean on touched scope
- [ ] T024 Run quickstart validation end-to-end (scope: `specs/019-admin-product-stock/quickstart.md` §1–§6 against local dev boot)
- [ ] T025 Full verification: `npm run build`, `npm run test -- --runInBand`, `npm run test:e2e` (scope: full repo; relevant suites green, pre-existing failures documented)

---

## Dependencies & Execution Order

### Phase Dependencies

- **Setup (Phase 1)**: No dependencies — can start immediately
- **Foundational (Phase 2)**: Depends on Setup completion — BLOCKS all user stories
- **User Stories (Phase 3–5)**: All depend on Foundational completion; US1/US2/US3 can then proceed in parallel (shared files: `admin-products.controller.ts` / `admin-products.service.ts` — coordinate or sequence controller edits)
- **Polish (Phase 6)**: Depends on all three stories complete

### User Story Dependencies

- **US1 (P1)**: After Foundational — no story dependencies (MVP)
- **US2 (P1)**: After Foundational — integrates with US1 list for verification, independently testable
- **US3 (P2)**: After Foundational (+ T005 `adjustStockByDelta`) — integrates with US1 list for verification, independently testable
- **US4 (P3)**: No tasks — out-of-scope boundary marker only

### Shared-file caution

- T010/T011 (US1 service+controller), T015 (US2 controller), T019 (US3 controller) all touch `admin-products.controller.ts` / `admin-products.service.ts`. Parallel workers must sequence edits to these two files (or split: one worker per story in US order).

### Parallel Opportunities

- T001 ∥ T002 (different files); T007 ∥ T008 ∥ T009 (spec, integration spec, DTO — different files); T012 ∥ T013 ∥ T014; T016 ∥ T017 ∥ T018; T020 ∥ T021 (docs vs controller annotations — different files)
- Post-Foundational, US1/US2/US3 can start in parallel subject to the shared-file caution above

---

## Parallel Example: User Story 1

```bash
# Launch US1 tests + DTO together (different files, no dependencies):
Task: "Unit tests for list math in src/modules/dashboard/admin-products.service.spec.ts"
Task: "Integration test for admin list round-trip in src/modules/dashboard/test/admin-products.integration.spec.ts"
Task: "Create list query DTO in src/modules/dashboard/dto/admin-product-list.query.dto.ts"
# Then (depends on DTO): implement service → controller sequentially
```

---

## Implementation Strategy

### MVP First (User Story 1 Only)

1. Complete Phase 1: Setup (T001–T003)
2. Complete Phase 2: Foundational (T004–T006)
3. Complete Phase 3: US1 (T007–T011)
4. **STOP and VALIDATE**: quickstart §1–§2 + SC-001/SC-002 spot-check
5. Deploy/demo if ready (read-only admin catalog with live statuses)

### Incremental Delivery

1. Setup + Foundational → foundation ready
2. Add US1 → test independently → Demo (MVP: reads)
3. Add US2 → test independently → Demo (+ create)
4. Add US3 → test independently → Demo (+ stock adjust)
5. Polish → full verification → Phase 20 demo exit

---

## Notes

- [P] tasks = different files, no dependencies; shared-file edits to the controller/service are sequenced, not parallel
- [Story] label maps each task to US1/US2/US3 for traceability (US4 has no tasks by design)
- Tests written first and confirmed failing before implementation tasks in the same story
- Real PostgreSQL for all integration tasks; Redis/RMQ mocked
- Commit after each task or logical group; stop at any checkpoint to validate the story independently
