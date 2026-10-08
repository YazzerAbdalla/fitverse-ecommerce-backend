# ADR 0015: Admin Product & Stock — Dashboard Reads, Delegated Writes (Phase 20 Demo)

**Date**: 2026-10-08
**Status**: Accepted
**Spec**: `specs/019-admin-product-stock/spec.md` (+ clarify 2026-10-08, 5 questions) | **Plan**: `specs/019-admin-product-stock/plan.md`
**Branch**: `019-admin-product-stock`

## Context

Phase 20 demo needed an admin catalog view with live stock statuses plus
product creation and stock correction, restricted to the existing Admin role
(no new roles, no user management). The oversell-critical checkout path
(`FOR UPDATE` sorted inventories) had to stay untouched, and no cached view
could become a stock authority.

## Decision

- **New `dashboard` module** (`src/modules/dashboard/`, owns no tables, no
  migration) with one-way edges to `ProductsModule`/`InventoryModule`/
  `AuthModule`. Three thin routes, all `@Auth(Admin)`: `GET /admin/products`
  (unthrottled-read exemption, recorded), `POST /admin/products` +
  `PATCH /admin/products/:id/stock` (separate 30/h-per-admin counters with
  identical limits — not a shared bucket with `products:mutation`).
- **List (US1)**: single read-only `DataSource` join (`Product LEFT JOIN
  Inventory`, plan §20.5 aggregator exception — writes stay service-only)
  with one SQL `CASE` status expression mirrored by the TS `mapStockStatus`
  (filter applied in SQL before pagination, so `meta.totalItems` is correct);
  LIKE wildcards escaped, `search` capped at 100 chars, `minPrice<=maxPrice`
  guarded in service → 400; admin list bypasses filter-blind
  `products:list:*` keys (uncached).
- **Create (US2)**: explicit REST-DTO→`CreateProductInput` field map
  (`stock ?? 0`, slug server-derived) into unchanged
  `ProductsService.create` (duplicate 409, inventory row, list-cache
  invalidation all inherited); 201 view composed via `getInventory`.
- **Stock (US3)**: delta-only `PATCH` (`ParseUUIDPipe`, `@NotEquals(0)`)
  delegating to new `InventoryService.adjustStockByDelta` (thin
  sign-dispatcher; positive delta auto-creates orphan rows, negative on
  missing row 404s; guards re-checked per write, last-writer-wins by design
  per REFACTOR_PLAN B-3). **No cache invalidation** on this path — proven
  unnecessary during implementation (customer list caches plain `Product`
  rows with no stock field; admin list uncached).
- **Q2 legacy tightening (T002b)**: `POST
  /inventory/:productId/increase|decrease` moved from `@Auth()` to
  `@Auth(Admin)` — otherwise any authenticated customer could mutate stock
  around the demo's guarded path, voiding FR-009.

## Alternatives Considered

- Admin REST inside `products` module — rejected (mixes customer browse +
  admin write concerns; `dashboard` is the plan-mandated home).
- Absolute-set stock mode — rejected by clarification Q2 (diff-and-send).
- Always-404 on missing inventory row — rejected (orphans unfixable).
- Shared throttle bucket with `products:mutation` — rejected (couples
  GraphQL + REST budgets).
- Stock-path cache invalidation — dropped during implementation (no cached
  view embeds quantities; widening the private invalidator API for zero
  benefit rejected).

## Consequences

- Demo is end-to-end clickable on live PG (infra came up mid-implementation,
  so all proofs below are live, not deferred): list/create/adjust round
  trips, 409-unchanged, concurrent-adjust guards-intact, customer 403 on all
  five mutation paths.
- `RateLimitGuard` gains two route keys (same quota family, no new env).
- Known gaps carried post-demo: lock-free admin delegates (B-3 atomic
  helper), `clear()` fallback (CACHE-1a), `price`/`slug` DB backstops.

## Verification

- `npm run build` clean; touched-scope lint 0 errors.
- Dashboard 36 (27 unit + 9 live integration) + inventory-service 31 +
  inventory-controller 3 + guard 30 green; no throttle regression.
- Real-PG suites live-green 2026-10-08: list 3/3 (incl. orphan fallback +
  `1/460` pagination meta), create 3/3 (stock-12→in-stock, bare→
  out-of-stock, dupe-409-single-row), stock 3/3 (up/down, 409-unchanged,
  `Promise.all` guards-intact).
- E2E `test/admin-products.e2e-spec.ts` 4/4 live (create→list→adjust→
  relist, 409s, customer 403 ×3, legacy 403 ×2). Incidental find: login
  returns 201 (no `@HttpCode`), not 200 — payment.e2e-spec's `.expect(200)`
  on login is stale (pre-existing, out of scope).
