# Implementation Plan: Admin Product & Stock (Phase 20 Demo Scope)

**Branch**: `019-admin-product-stock` | **Date**: 2026-10-08 | **Spec**: [spec.md](./spec.md) (clarified 2026-10-08, 5/5 answers integrated)
**Status**: DONE 2026-10-08 — all 26 tasks (T001–T025) implemented TDD red→green and committed in 7 slices; build clean, touched scope 10 suites/107 green, E2E 4/4 live on dev PG (see [tasks.md](./tasks.md) per-task evidence)
**Input**: Feature specification from `/specs/019-admin-product-stock/spec.md`
**Plan reference**: `docs/plan.md` Phase 20 (demo scope locked 2026-10-08 to this spec)

## Summary

Admin-only product operations for the Phase 20 demo: a paginated admin product list with search/filters and auto-calculated stock status, product creation with optional initial stock, and delta-only stock adjustments. Delivered as a thin new `dashboard` module that aggregates the existing `ProductsService` and `InventoryService` (service-only collaboration, one-way edges, no new tables, no migration, no role changes). Stock status is derived on read via a single SQL `CASE` + shared TS mapper (`available = stock − reservedAmount`, threshold default 5 overridable per request, filter applied in SQL before pagination); missing inventory rows list as `out-of-stock` with zero quantity (positive stock-adjust auto-creates the row). Writes use separate 30/h-per-admin counters with identical limits (not a shared bucket); legacy `POST /inventory/:productId/increase|decrease` are tightened to `@Auth(Admin)` in this spec (T002b). Admin list reads bypass the filter-blind `products:list:*` cache. The stock-adjust path performs no cache invalidation — proven unnecessary during implementation (no cached view embeds inventory quantities; research D7 corrected accordingly).

## Technical Context

**Language/Version**: TypeScript 5.x (NestJS 11, existing repo toolchain)
**Primary Dependencies**: NestJS 11, TypeORM 1.1 (`typeorm`), `class-validator`/`class-transformer` (global `ValidationPipe`: whitelist + forbidNonWhitelisted + transform), `@nestjs/swagger` (`@ApiProperty`/`@ApiResponse`), existing `RateLimitGuard` (exported by `AuthModule`), existing `Auth(...roles)` decorator + `RolesGuard`
**Storage**: PostgreSQL 17 (authoritative; existing `Product` + `Inventory` tables, no schema change, no migration)
**Testing**: Jest (`ts-jest`): unit specs next to code (mocked repos/services), integration specs against real PostgreSQL (no DB mocks for consistency paths), E2E via `supertest`
**Target Platform**: Linux server (existing modular-monolith deployment, `PORT` 3000)
**Project Type**: Backend web-service (REST for new admin surface; existing GraphQL products surface untouched)
**Performance Goals**: Admin list reads a single paginated query with join (no N+1); product creation reuses the existing `create` path (<10ms extra for inventory row + cache invalidation)
**Constraints**: `@Auth(Admin)` on all new routes; `RateLimitGuard` outermost so `429` never holds a lock; no `client.emit`/provider I/O inside transactions; JSDoc on every touched class/method per AGENTS.md §3; no `any`
**Scale/Scope**: Demo dataset = existing + seeded products; pagination default `page=1, limit=20`, cap 100 (dev DB held 460 rows at verification; `1/460` pagination meta proven live)

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-check after Phase 1 design.*

| # | Principle | Verdict |
|---|-----------|---------|
| I | PostgreSQL source of truth | **Pass** — all reads/writes go through `ProductsService`/`InventoryService` to PG. Redis stays cache (product list) + throttle counters only; status math never reads cache. |
| II | Modular monolith, service-only collaboration | **Pass** — new `dashboard` module imports `ProductsModule`, `InventoryModule`, `AuthModule` (one-way edges). All writes go through exported services; the single exception is the admin list read, which uses the shared `DataSource` for one read-only join per the plan §20.5 aggregator allowance (research D1). No `@InjectRepository` of another module's entity. |
| III | Inventory separate domain, `available` derived | **Pass** — no `Product.stock`; `available = stock − reservedAmount` computed on read; status label derived, never stored. |
| IV | DB-level concurrency, no overselling | **Pass with note** — customer oversell path (checkout `FOR UPDATE`) untouched. Admin delta writes reuse existing lock-free `increase/decreaseStock`; concurrent same-product admin edits are last-writer-wins by design (tests assert guards-intact + no `reservedAmount` corruption, never an exact final stock). Atomic admin helper is tracked post-demo (REFACTOR_PLAN B-3), not demo scope. |
| V | Thin controllers, services own logic | **Pass** — dashboard controllers parse + delegate; listing math + validation live in services. |
| VI | Spec-driven, no future phases | **Pass** — spec + 5 clarifications done; roles/metrics/bulk explicitly deferred (FR-012). |
| VII | Mandatory DB-backed tests | **Pass, live-proven** — unit 27 + real-PG integration 9 + E2E 4, all green on dev PG 2026-10-08 (dashboard 36 total; `1/460` pagination meta; `Promise.all` guards-intact). |
| VIII | No invented APIs/rules | **Pass** — three capabilities map 1:1 to FR-001/FR-005/FR-007; amounts server-validated. |
| IX | Docs as work | **Pass** — ADR-0015 + `docs/architecture/modules.md` dashboard section + `docs/plan.md` as-built note shipped with implementation. |

*Post-implementation re-check: no violations introduced (no schema, queue, or event changes; full unit run 467/468 — the single failure is `order-cancel-expiry.race.spec.ts`, environmental: `relation "reservation" does not exist` in that spec's own test DB, fails identically without 019 changes).*

## Project Structure

### Documentation (this feature)

```text
specs/019-admin-product-stock/
├── plan.md              # This file (/speckit.plan command output)
├── research.md          # Phase 0 output (/speckit.plan command)
├── data-model.md        # Phase 1 output (/speckit.plan command)
├── quickstart.md        # Phase 1 output (/speckit.plan command)
├── contracts/           # Phase 1 output (/speckit.plan command)
│   └── admin-products.md
├── checklists/
│   └── requirements.md
└── tasks.md             # Phase 2 output (/speckit.tasks command - NOT created by /speckit.plan)
```

### Source Code (repository root)

```text
src/
├── modules/
│   ├── dashboard/                        # NEW (demo scope: admin product & stock only)
│   │   ├── dashboard.module.ts           # imports ProductsModule, InventoryModule, AuthModule
│   │   ├── admin-products.controller.ts  # thin: GET list, POST create, PATCH :id/stock
│   │   ├── admin-products.service.ts     # list math (join, status, filters, pagination) + AdminProductView/AdminStockView + mapStockStatus/escapeLikeWildcards/DEFAULT_LOW_THRESHOLD
│   │   ├── admin-products.service.spec.ts        # T007 status/filter/meta matrix (16)
│   │   ├── admin-products-create.spec.ts         # T012 DTO validation + field-map + 409 (6)
│   │   ├── admin-products-stock.spec.ts          # T016 DTO validation + delegate + 409 (5)
│   │   ├── dto/
│   │   │   ├── admin-product-list.query.dto.ts   # T009 own REST bounds (not GraphQL PaginationArgs)
│   │   │   ├── admin-create-product.dto.ts       # T014
│   │   │   └── adjust-stock.dto.ts               # T018 @NotEquals(0)
│   │   └── test/
│   │       ├── admin-products.integration.spec.ts        # T008 list round-trip (3, live)
│   │       ├── admin-products-create.integration.spec.ts # T013 create round-trip (3, live)
│   │       └── admin-products-stock.integration.spec.ts  # T017 adjust + races (3, live)
│   ├── products/                     # REUSED (create + invalidation inherited, no logic change)
│   ├── inventory/
│   │   ├── inventory.service.ts      # TOUCHED: + adjustStockByDelta sign-dispatcher (T005) + class JSDoc
│   │   ├── inventory.service.spec.ts # TOUCHED: + T004 delegation matrix (5)
│   │   ├── inventory.controller.ts   # TOUCHED: increase/decrease → @Auth(Admin) (T002b)
│   │   └── inventory.controller.spec.ts  # NEW: T002b role-boundary pin (3)
│   └── auth/guards/
│       ├── rate-limit.guard.ts       # TOUCHED: 2 route keys (separate 30/h counters) + perUserRoutes (T002)
│       └── rate-limit.guard.spec.ts  # TOUCHED: + 30/h per-admin + key-normalization tests (2)
└── migration/                        # UNTOUCHED: no schema change, no migration

test/
└── admin-products.e2e-spec.ts        # NEW: T022 admin flow + customer 403 ×3 + legacy 403 ×2 (4, live)

tests (spec-adjacent):
├── unit: dashboard 27 (status matrix, field-map, delegate, DTO validation), inventory delta guards 5, controller boundary 3, guard keys 2
├── integration (real PG, all live 2026-10-08): create→list, delta adjust, 409 below-reserved, concurrent guards-intact
└── e2e (supertest, live): admin flow + customer 403 matrix + legacy 403 proof
```

**Structure Decision**: New `dashboard` module per `docs/plan.md` §20.5 (separate module, service-aggregating). Demo populates it with only the three product/stock capabilities; metrics and order/cart reads arrive post-demo without restructuring. Edges are one-way only (dashboard → Products/Inventory/Auth; nothing imports Dashboard; no `@InjectRepository` of another module's entity). Review deltas applied 2026-10-08: SQL-CASE status + filter-before-paginate (B1), legacy `@Auth(Admin)` tightening T002b (B2), TDD-ID + phase-gating fixes (B3/S5), missing-row auto-create policy (B4), throttle-counter semantics + read exemption + cache containment (S1/S2), input hardening + mapper + pagination-reuse notes (S3–S5/clean-code).

## Complexity Tracking

> No Constitution Check violations — no new abstractions introduced (thin
> sign-dispatcher + two pure helpers only, each with a single responsibility).

## As-Built Deltas (implementation findings, all folded back into spec/docs)

| # | Finding | Resolution |
|---|---------|------------|
| 1 | T019's required stock-path cache invalidation is unnecessary: customer `findAll`/`findOne` cache plain `Product` rows (no stock field/join) and the admin list is uncached. | D7 + T019 rewritten to require **no** invalidation (with `//` cite); widening the private invalidator API for zero benefit rejected. |
| 2 | `POST /auth/login` returns **201**, not 200 (no `@HttpCode`, Nest POST default). | E2E expects 201; `payment.e2e-spec`'s `.expect(200)` on login is stale (pre-existing, out of scope, noted in ADR-0015). |
| 3 | `User` entity is a **default export only** (`export default class User`); named imports resolve to `undefined` and surface as `Entity metadata for X was not found` at DataSource init. | All three dashboard integration specs use the default import (same as `cancel-fixtures.ts`). |
| 4 | `order-cancel-expiry.race.spec.ts` fails in this environment (`relation "reservation" does not exist` in its own test DB). | Proven unrelated to 019 (fails identically with 019 changes stashed); recorded in T025, not fixed here. |
