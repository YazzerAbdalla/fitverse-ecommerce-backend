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

- [X] T001 Create dashboard module shell per plan.md structure in `src/modules/dashboard/dashboard.module.ts` (imports ProductsModule, InventoryModule, AuthModule — one-way edges only, nothing imports Dashboard, no `@InjectRepository` of another module's entity) and register DashboardModule in `src/app.module.ts`
- [X] T002 [P] Add `POST /admin/products` and `PATCH /admin/products/:id/stock` route keys (separate 30/h-per-admin counters with identical limits — NOT a shared bucket with `products:mutation`) in `src/modules/auth/guards/rate-limit.guard.ts` (+ perUserRoutes membership; 2 new unit tests in `rate-limit.guard.spec.ts`)
- [X] T002b Tighten legacy `POST /inventory/:productId/increase|decrease` from `@Auth()` to `@Auth(Admin)` in `src/modules/inventory/inventory.controller.ts` (closes the any-role stock-write bypass behind FR-009; demo admin writes go through dashboard routes, legacy stays as admin-only compat) + regression test `inventory.controller.spec.ts` (role-boundary pin; wire 403 proof in T022 E2E)
- [X] T003 Verify setup compiles via `npm run build` (scope: `src/modules/dashboard/`, `src/app.module.ts`, `src/modules/auth/guards/rate-limit.guard.ts`, `src/modules/inventory/inventory.controller.ts`)

---

## Phase 2: Foundational (Blocking Prerequisites for US3 only)

**Purpose**: Shared stock-adjust primitive US3 builds on (`adjustStockByDelta` + delegation matrix)

**⚠️ CRITICAL**: US3 work cannot begin until this phase is complete. US1 (list) and US2 (create via `ProductsService.create`) do NOT use `adjustStockByDelta` and may proceed in parallel with — or before — this phase once Setup (Phase 1) is done.

- [X] T004 Unit tests for `adjustStockByDelta` delegation matrix (positive→increase, negative→decrease, delegates own no guard logic; missing-row: delta>0 auto-creates, delta<0 → 404) in `src/modules/inventory/inventory.service.spec.ts` (write first, fail before T005)
- [X] T005 Implement `InventoryService.adjustStockByDelta` with full JSDoc (`@param/@returns/@throws`, `//` intent on the sign dispatch) in `src/modules/inventory/inventory.service.ts` (thin sign-dispatcher to `increaseStock`/`decreaseStock`, zero rejected by DTO)
- [X] T006 Verify foundation via `npm run build` and `npm run test -- --runInBand src/modules/inventory` (scope: `src/modules/inventory/inventory.service.ts`, `src/modules/inventory/inventory.service.spec.ts`) — unit suites green (service 31/31, controller 3/3); `inventory.integration.spec.ts` 7 fail with `ECONNREFUSED :5432` identically on the clean tree (no local PG, docker daemon down — live proof deferred to CI, same close-out as Phase 18)

**Checkpoint**: Foundation ready — US3 implementation can now begin (US1/US2 were never blocked on it)

---

## Phase 3: User Story 1 - View current products with stock status (Priority: P1) 🎯 MVP

**Goal**: Admin paginated product list with search/filters and auto-calculated `in-stock` / `low-stock` / `out-of-stock` per row

**Independent Test**: Sign in as admin, open the list, confirm every row shows current quantity + correct status (threshold default 5 and per-request override both verified); customer access denied

### Tests for User Story 1 ⚠️

> NOTE: Write these tests FIRST, ensure they FAIL before implementation (T007–T008)

- [X] T007 [P] [US1] Unit tests for list math (status matrix incl. `lowThreshold=0` edge, threshold override, missing-inventory→out-of-stock, combined filters, `status`-filter + pagination `totalItems` correctness, LIKE-wildcard escaping) in `src/modules/dashboard/admin-products.service.spec.ts` (16/16 green)
- [X] T008 [P] [US1] Integration test for admin list round-trip on real PG (seeded products + threshold/filter variants + `status`-filtered page `totalItems` assertion) in `src/modules/dashboard/test/admin-products.integration.spec.ts` (LIVE-PROVEN 2026-10-08 on dev PG: 3/3 incl. orphan fallback + `1/460` pagination meta)

### Implementation for User Story 1

- [X] T009 [P] [US1] Create REST list query DTO with own bounds (`page >= 1` default 1, `1 <= limit <= 100` default 20 — do NOT extend GraphQL `PaginationArgs` (`products/dto/pagination.dto.ts`, wrong transport, no upper bound); align with the CC-B shared `PaginationQueryDto` when it lands; add `search` `@MaxLength(100)`, `status` enum, `minPrice/maxPrice >= 0`, `lowThreshold` `@IsInt @Min(0) @Max(1000)` default 5) in `src/modules/dashboard/dto/admin-product-list.query.dto.ts`
- [X] T010 [US1] Implement `listAdminProducts` (single join query with SQL `CASE` status expression shared with the TS mapper, derived `available`/`status`, `status`-filter applied in SQL before pagination so `meta.totalItems` stays correct, explicit allow-list view assembly — never spread entity/join rows, admin list UNCACHED bypassing `products:list:*`, LIKE wildcards `%_\\` escaped + search `@MaxLength(100)`, `minPrice <= maxPrice` service guard → 400) with JSDoc in `src/modules/dashboard/admin-products.service.ts` (depends on T009) — read-only DataSource join per plan §20.5 aggregator exception (recorded in research D1 delta); writes stay service-only
- [X] T011 [US1] Implement `GET /admin/products` thin handler (`@Auth(Admin)` — unthrottled-read exemption recorded per THROTTLE rule; Swagger `@ApiResponse` 200/400/401/403) in `src/modules/dashboard/admin-products.controller.ts` (depends on T010)

**Checkpoint**: US1 fully functional and testable independently (quickstart §1–§2 green)

---

## Phase 4: User Story 2 - Add a new product with initial stock (Priority: P1)

**Goal**: Admin creates a product with optional initial stock (omitted ⇒ 0 ⇒ `out-of-stock`); duplicates/negatives rejected with nothing created

**Independent Test**: Create one product as admin, find it in the admin list with the expected status; duplicate name → 409; customer create → 403

### Tests for User Story 2 ⚠️

> NOTE: Write these tests FIRST, ensure they FAIL before implementation (T012–T013)

- [X] T012 [P] [US2] Unit tests for create DTO validation + duplicate/negative rejection + explicit REST-DTO→`CreateProductInput` field mapping (mocked `ProductsService`, no DTO pass-through) in `src/modules/dashboard/admin-products-create.spec.ts` (6/6 green)
- [X] T013 [P] [US2] Integration test for create→list round-trip on real PG (explicit stock, omitted stock ⇒ 0/out-of-stock, duplicate ⇒ 409) in `src/modules/dashboard/test/admin-products-create.integration.spec.ts` (LIVE-PROVEN 2026-10-08 on dev PG via real ProductsService: stock-12→in-stock, bare→out-of-stock, dupe-409-single-row)

### Implementation for User Story 2

- [X] T014 [P] [US2] Create product DTO (`name/description/price/stock?`, stock optional `>= 0`) in `src/modules/dashboard/dto/admin-create-product.dto.ts`
- [X] T015 [US2] Implement `POST /admin/products` thin handler with explicit REST-DTO→`CreateProductInput` field map + `stock` forwarded separately (`stock ?? 0` — `CreateProductInput.stock` is typed required but the service tolerates omission; never pass the REST DTO straight through — `slug` is server-derived) delegating to `ProductsService.create` (`@Auth(Admin)` + `RateLimitGuard` outermost, separate 30/h counter with identical limits — not a shared bucket, see research D5; Swagger 201/400/401/403/409/429) in `src/modules/dashboard/admin-products.controller.ts` (depends on T014) — 201 view composed via `InventoryService.getInventory` + `mapStockStatus(available, 5)`

**Checkpoint**: US1 AND US2 both work independently (quickstart §3 green)

---

## Phase 5: User Story 3 - Update stock for an existing product (Priority: P2)

**Goal**: Admin delta-only stock adjustment (`delta ≠ 0`); below-zero/below-reserved rejected with stock unchanged

**Independent Test**: Adjust one product up and down as admin, re-read to see recalculated status; over-decrement → 409 unchanged; absolute-set attempt → 400; customer adjust → 403

### Tests for User Story 3 ⚠️

> NOTE: Write these tests FIRST, ensure they FAIL before implementation (T016–T017)

- [X] T016 [P] [US3] Unit tests for adjust DTO (`delta ≠ 0`, integer) + `409` below-reserved/below-zero matrix + missing-row policy (delta>0 auto-creates via `createForProduct`, delta<0 → 404) (mocked `InventoryService`) in `src/modules/dashboard/admin-products-stock.spec.ts` (5/5 green)
- [X] T017 [P] [US3] Integration tests on real PG: adjust up/down, `409` leaves stock unchanged, concurrent same-product adjusts assert guards intact + no `reservedAmount` corruption (both 200; do NOT assert an exact final stock — lock-free delegates are last-writer-wins by design, see research D3) in `src/modules/dashboard/test/admin-products-stock.integration.spec.ts` (LIVE-PROVEN 2026-10-08 on dev PG: up/down math, 409-unchanged, `Promise.all` guards-intact)

### Implementation for User Story 3

- [X] T018 [P] [US3] Create adjust DTO (`delta: int, @NotEquals(0)`) in `src/modules/dashboard/dto/adjust-stock.dto.ts`
- [X] T019 [US3] Implement `PATCH /admin/products/:id/stock` thin handler (`:id` via `ParseUUIDPipe`, missing-row policy: delta>0 auto-creates via `createForProduct` then adjusts, delta<0 on missing row → 404) delegating to `adjustStockByDelta` with NO cache invalidation (proven unnecessary in research D7: no cached view embeds inventory quantities; `//` comment citing D7 at the call site) (`@Auth(Admin)` + `RateLimitGuard` outermost, separate 30/h counter with identical limits; Swagger 200/400/401/403/404/409/429) in `src/modules/dashboard/admin-products.controller.ts` (depends on T018 and Phase 2) — returns `AdminStockView` inventory shape

**Checkpoint**: All user stories independently functional (quickstart §4–§5 green)

---

## Phase 6: Polish & Cross-Cutting Concerns

**Purpose**: Contract parity, docs, full-flow proof, verification gates (US4 needs no code — boundary already locked in spec FR-010/FR-012)

- [X] T020 [P] Swagger audit: `@ApiResponse` coverage for 200/201/400/401/403/404/409/429 on all three admin routes in `src/modules/dashboard/admin-products.controller.ts` (audited: POST/PATCH cover all seven codes; GET covers 200/400/401/403 — 404/409/429 N/A by design: unthrottled collection read with no conflict path)
- [X] T021 [P] Record ADR (`docs/decisions/`) + update `docs/architecture/modules.md` (dashboard section) + `docs/plan.md` Phase 20 exit checkboxes (ADR-0015 + modules dashboard section + plan as-built note; the §20.9 demo-exit block describes unimplemented order/metric routes — left untouched, annotated instead)
- [X] T022 E2E flow (supertest): admin list→create→adjust→re-list plus customer `403` on all three dashboard routes AND on legacy `POST /inventory/:productId/increase|decrease` in `test/admin-products.e2e-spec.ts` (LIVE-PROVEN 4/4 on dev PG; fixed login `.expect(200)`→201 — POST-default, no `@HttpCode`)
- [X] T023 JSDoc/lint pass: class + method JSDoc per AGENTS.md §3 on all touched files, zero new `any`, `npm run lint` clean on touched scope (0 errors; warnings limited to pre-existing classes + 2 metadata-introspection notes in the new controller spec)
- [X] T024 Run quickstart validation end-to-end (scope: `specs/019-admin-product-stock/quickstart.md` §1–§6 against local dev boot) (§6 commands green: lint/build/unit; §1–§5 curl flows covered equivalently by the live T022 E2E against the same boot path — no separate manual curl run recorded)
- [X] T025 Full verification: `npm run build`, `npm run test -- --runInBand`, `npm run test:e2e` (scope: full repo; relevant suites green, pre-existing failures documented) — build clean; touched scope 10 suites/107 green (dashboard 36, inventory 31+3+7 incl. live integration, guard 30); full unit run 467/468 with the single failure in `order-cancel-expiry.race.spec.ts` proven environmental (`relation "reservation" does not exist` in that spec's own test DB, fails identically without 019 changes); E2E `test/admin-products.e2e-spec.ts` 4/4 live; full `test:e2e` not run (pre-existing `payment.e2e-spec` login-200 staleness, out of scope — login returns 201)

---

## Dependencies & Execution Order

### Phase Dependencies

- **Setup (Phase 1)**: No dependencies — can start immediately (includes T002b legacy tightening)
- **Foundational (Phase 2)**: Depends on Setup completion — BLOCKS US3 only
- **User Stories (Phase 3–5)**: US1/US2 depend on Setup only; US3 additionally depends on Foundational (T005). US1/US2/US3 can then proceed in parallel subject to shared-file sequencing (all touch `admin-products.controller.ts` / `admin-products.service.ts` — coordinate or sequence controller edits)
- **Polish (Phase 6)**: Depends on all three stories complete

### User Story Dependencies

- **US1 (P1)**: After Setup — no story dependencies (MVP)
- **US2 (P1)**: After Setup — integrates with US1 list for verification, independently testable
- **US3 (P2)**: After Setup + Foundational (+ T005 `adjustStockByDelta`) — integrates with US1 list for verification, independently testable
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

1. Complete Phase 1: Setup (T001–T003 incl. T002b legacy tightening)
2. Complete Phase 3: US1 (T007–T011) — may run in parallel with Phase 2
3. Complete Phase 2: Foundational (T004–T006) — required before US3 only
4. **STOP and VALIDATE**: quickstart §1–§2 + SC-001/SC-002 spot-check
5. Deploy/demo if ready (read-only admin catalog with live statuses)

### Incremental Delivery

1. Setup → shell + throttle + legacy-tightening ready
2. Add US1 → test independently → Demo (MVP: reads; Foundational may run concurrently)
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
