# Implementation Plan: Admin Product & Stock (Phase 20 Demo Scope)

**Branch**: `019-admin-product-stock` | **Date**: 2026-10-08 | **Spec**: [spec.md](./spec.md) (clarified 2026-10-08, 5/5 answers integrated)
**Input**: Feature specification from `/specs/019-admin-product-stock/spec.md`
**Plan reference**: `docs/plan.md` Phase 20 (demo scope locked 2026-10-08 to this spec)

## Summary

Admin-only product operations for the Phase 20 demo: a paginated admin product list with search/filters and auto-calculated stock status, product creation with optional initial stock, and delta-only stock adjustments. Delivered as a thin new `dashboard` module that aggregates the existing `ProductsService` and `InventoryService` (service-only collaboration, one-way edges, no new tables, no migration, no role changes). Stock status is derived on read via a single SQL `CASE` + shared TS mapper (`available = stock − reservedAmount`, threshold default 5 overridable per request, filter applied in SQL before pagination); missing inventory rows list as `out-of-stock` with zero quantity (positive stock-adjust auto-creates the row). Writes use separate 30/h-per-admin counters with identical limits (not a shared bucket); legacy `POST /inventory/:productId/increase|decrease` are tightened to `@Auth(Admin)` in this spec (T002b). Admin list reads bypass the filter-blind `products:list:*` cache.

## Technical Context

**Language/Version**: TypeScript 5.x (NestJS 11, existing repo toolchain)
**Primary Dependencies**: NestJS 11, TypeORM 1.1 (`typeorm`), `class-validator`/`class-transformer` (global `ValidationPipe`: whitelist + forbidNonWhitelisted + transform), `@nestjs/swagger` (`@ApiProperty`/`@ApiResponse`), existing `RateLimitGuard` (exported by `AuthModule`), existing `Auth(...roles)` decorator + `RolesGuard`
**Storage**: PostgreSQL 17 (authoritative; existing `Product` + `Inventory` tables, no schema change, no migration)
**Testing**: Jest (`ts-jest`): unit specs next to code (mocked repos/services), integration specs against real PostgreSQL (no DB mocks for consistency paths), E2E via `supertest`
**Target Platform**: Linux server (existing modular-monolith deployment, `PORT` 3000)
**Project Type**: Backend web-service (REST for new admin surface; existing GraphQL products surface untouched)
**Performance Goals**: Admin list reads a single paginated query with join (no N+1); product creation reuses the existing `create` path (<10ms extra for inventory row + cache invalidation)
**Constraints**: `@Auth(Admin)` on all new routes; `RateLimitGuard` outermost so `429` never holds a lock; no `client.emit`/provider I/O inside transactions; JSDoc on every touched class/method per AGENTS.md §3; no `any`
**Scale/Scope**: Demo dataset = existing + seeded products (tens of rows); pagination default `page=1, limit=20`, cap 100

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-check after Phase 1 design.*

| # | Principle | Verdict |
|---|-----------|---------|
| I | PostgreSQL source of truth | **Pass** — all reads/writes go through `ProductsService`/`InventoryService` to PG. Redis stays cache (product list) + throttle counters only; status math never reads cache. |
| II | Modular monolith, service-only collaboration | **Pass** — new `dashboard` module imports `ProductsModule`, `InventoryModule`, `AuthModule` and calls only exported services. No `@InjectRepository` of another module's entity. |
| III | Inventory separate domain, `available` derived | **Pass** — no `Product.stock`; `available = stock − reservedAmount` computed on read; status label derived, never stored. |
| IV | DB-level concurrency, no overselling | **Pass with note** — customer oversell path (checkout `FOR UPDATE`) untouched. Admin delta writes reuse existing lock-free `increase/decreaseStock`; concurrent same-product admin edits are last-writer-wins by design (tests assert guards-intact + no `reservedAmount` corruption, never an exact final stock). Atomic admin helper is tracked post-demo (REFACTOR_PLAN B-3), not demo scope. |
| V | Thin controllers, services own logic | **Pass** — dashboard controllers parse + delegate; listing math + validation live in services. |
| VI | Spec-driven, no future phases | **Pass** — spec + 5 clarifications done; roles/metrics/bulk explicitly deferred (FR-012). |
| VII | Mandatory DB-backed tests | **Pass** — plan includes unit + real-PG integration + E2E (see quickstart). |
| VIII | No invented APIs/rules | **Pass** — three capabilities map 1:1 to FR-001/FR-005/FR-007; amounts server-validated. |
| IX | Docs as work | **Pass** — ADR + `docs/architecture/modules.md` update ship with implementation. |

*Post-design re-check: no new violations introduced (design reuses existing services; no schema, queue, or event changes).*

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
│   ├── dashboard/                    # NEW (demo scope: admin product & stock only)
│   │   ├── dashboard.module.ts       # imports ProductsModule, InventoryModule, AuthModule
│   │   ├── admin-products.controller.ts  # thin: GET list, POST create, PATCH :id/stock
│   │   ├── admin-products.service.ts # list math (join, status, filters, pagination)
│   │   └── dto/
│   │       ├── admin-product-list.query.dto.ts
│   │       ├── admin-create-product.dto.ts
│   │       └── adjust-stock.dto.ts
│   ├── products/                     # TOUCHED (no logic change: reuse create + invalidation)
│   ├── inventory/                    # TOUCHED: add adjustStockByDelta (delegates to increase/decrease guards)
│   └── auth/guards/
│       └── rate-limit.guard.ts       # TOUCHED: two new route keys, same 30/h quota
└── migration/                        # UNTOUCHED: no schema change, no migration

tests (spec-adjacent):
├── unit: dashboard service (status matrix, filters), inventory delta guards, DTO validation
├── integration (real PG): create→list, delta adjust, 409 below-reserved, concurrent last-wins
└── e2e (supertest): admin flow + customer 403 matrix
```

**Structure Decision**: New `dashboard` module per `docs/plan.md` §20.5 (separate module, service-aggregating). Demo populates it with only the three product/stock capabilities; metrics and order/cart reads arrive post-demo without restructuring. Edges are one-way only (dashboard → Products/Inventory/Auth; nothing imports Dashboard; no `@InjectRepository` of another module's entity). Review deltas applied 2026-10-08: SQL-CASE status + filter-before-paginate (B1), legacy `@Auth(Admin)` tightening T002b (B2), TDD-ID + phase-gating fixes (B3/S5), missing-row auto-create policy (B4), throttle-counter semantics + read exemption + cache containment (S1/S2), input hardening + mapper + pagination-reuse notes (S3–S5/clean-code).

## Complexity Tracking

> No Constitution Check violations — this section intentionally left empty.
