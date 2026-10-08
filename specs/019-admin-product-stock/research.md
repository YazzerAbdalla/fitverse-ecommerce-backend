# Research: Admin Product & Stock (Phase 20 Demo Scope)

**Date**: 2026-10-08 | **Spec**: [spec.md](./spec.md) | **Plan**: [plan.md](./plan.md)
**Method**: Codebase inspection (no external research needed — all unknowns resolved by spec clarifications + existing code).

## D1 — New `dashboard` module for the admin surface

- **Decision**: Create `src/modules/dashboard/` with `dashboard.module.ts` (imports `ProductsModule`, `InventoryModule`, `AuthModule`), a thin `admin-products.controller.ts`, and `admin-products.service.ts` for list math. Controllers parse + delegate; all **writes** go through `ProductsService` / `InventoryService`. The single exception is the admin **list read**: it uses the shared `DataSource` for one read-only join (LEFT JOIN Product→Inventory, no N+1) per the plan §20.5 read-only-aggregator allowance — never `@InjectRepository` of another module's entity, never a write, never inside a tx. This keeps the SQL `CASE` status filter + filter-before-paginate (B1) in the dashboard instead of leaking admin presentation logic into `ProductsService`.
- **Rationale**: `docs/plan.md` §20.5 mandates a separate module for the admin/operational surface; keeps customer GraphQL (`products.resolver.ts`) and admin REST in separate bounded concerns while sharing one service truth.
- **Alternatives considered**: Extending `products` module with a REST controller — rejected (mixes customer browse + admin write concerns in one module, harder to split later); generic `admin` module — rejected (`dashboard` is the plan-mandated name and future metrics home).

## D2 — Product creation reuses `ProductsService.create` via explicit field map

- **Decision**: `POST /admin/products` maps the REST DTO field-by-field onto `CreateProductInput` (`name/description/price`) + `stock` forwarded separately, then delegates to `ProductsService.create` unchanged (never pass the REST DTO straight through — `slug` is server-derived via `slugify`). Its service already: slugifies + enforces unique name/slug (`409`), tolerates missing `stock` (defaults `0` — matches Q4/A), creates the `Inventory` row via `createForProduct`, and invalidates list caches post-save.
- **Rationale**: Zero new product-write logic; duplicate/conflict semantics already tested; explicit map keeps the GraphQL input shape owned by `ProductsService`.
- **Alternatives considered**: Duplicating create logic in the dashboard service — rejected (dual write truth, violates TI-2 single-mutation-point direction).
- **Known gaps (accepted, post-demo)**: `Product.price` has no DB `@Check(price >= 0)` (DTO/service-only guard); `slug` has no DB unique backstop beyond `name` — concurrent duplicate-slug creates can both pass the `findOne` check. Both pre-date this spec; no new migration in demo scope.

## D3 — Delta-only stock update via new `adjustStockByDelta` (+ missing-row policy)

- **Decision**: Add `InventoryService.adjustStockByDelta(productId, delta)` (full JSDoc `@param/@returns/@throws` per AGENTS.md §3; thin sign-dispatcher only — guards stay in the delegates) where `delta > 0` delegates to `increaseStock(productId, delta)` and `delta < 0` delegates to `decreaseStock(productId, -delta)`; `delta === 0` rejected at DTO (`@IsInt, @NotEquals(0)`). The existing guards already enforce the spec: positive-integer quantities, `stock >= 0`, and `reservedAmount <= stock` (decrease below reserved → `409`, stock unchanged). Missing-row policy (decided here, was unspecified): `delta > 0` on a missing row auto-creates via idempotent `createForProduct(productId, 0)` then applies the increase; `delta < 0` on a missing row → `404` (nothing to subtract from).
- **Rationale**: Matches Q2/C (signed delta only); reuses proven guards instead of inventing a third mutation path; auto-create on increase unblocks orphan products that list as `out-of-stock` per Q3/B.
- **Alternatives considered**: Absolute-set mode — rejected by clarification Q2; callers needing "set to N" read current stock and send `N − stock` (documented in quickstart). Always-404 on missing row — rejected (leaves orphan products unfixable via the only stock-write path).
- **Known limitation (accepted, post-demo)**: `increase/decreaseStock` are lock-free read-modify-write (REFACTOR_PLAN B-3). Concurrent same-product admin edits are last-writer-wins; no reserved-unit corruption is possible (guards re-checked per write). The atomic helper ships post-demo — T017 asserts guards-intact, never an exact final stock.

## D4 — Stock status derived with a single SQL CASE + shared TS mapper (no N+1, filter-before-paginate)

- **Decision**: `admin-products.service.listAdminProducts` loads products + their inventories in one paginated query (LEFT JOIN, no N+1) that selects a SQL `CASE` status expression over `COALESCE(stock,0) − COALESCE(reservedAmount,0)` with the bound `:lowThreshold` param: `available <= 0` → `out-of-stock`; `0 < available <= :lowThreshold` → `low-stock`; else `in-stock` (`lowThreshold=0` ⇒ `low-stock` unreachable by construction — pinned by test). The `status` query filter is applied **in SQL on that same CASE expression before `LIMIT/OFFSET`** so `meta.totalItems` counts post-filter rows; the TS response mapper (`toAdminProductView()`) implements the identical three-branch formula over the returned `available` + threshold and is the single enum definition for the response path (the SQL CASE mirrors it with a `//` comment citing this decision — duplication is intentional and tested by the T007 matrix + T008 `totalItems` assertion, not a second truth). Threshold: query param `lowThreshold`, default `5`, validated `@IsInt @Min(0) @Max(1000)`. Products with no inventory row return `stock=0, reservedAmount=0, available=0, status=out-of-stock` (Q3/B) via `COALESCE`. Search: `ILIKE %name%` case-insensitive with LIKE wildcards (`%`, `_`, `\`) escaped and `@MaxLength(100)`; filters `status`/`minPrice`/`maxPrice` combined with AND plus a service guard `minPrice <= maxPrice` else `400`; envelope `{ data, meta }` reuses the repo pagination shape (`skip = (page−1) * limit`, default `limit=20`, cap 100). Admin list reads **bypass** the `products:list:*` cache entirely (those keys ignore `search/status/threshold` — reusing them would serve wrong rows); `EXPLAIN` must show index use on the product/inventory join.
- **Rationale**: Implements FR-002/FR-003/FR-004 exactly as clarified (Q1/A threshold, Q3/B missing-row fallback); single query keeps reads cheap; no stored status column (constitution III); filtering in SQL preserves pagination correctness.
- **Alternatives considered**: In-memory post-query status filtering — rejected (paginates then filters, corrupts `totalItems`). Reusing `products:list:*` cache keys — rejected (keys are filter-blind).

## D5 — Throttle reuse: identical limits, separate counters, read exemption recorded

- **Decision**: Add two `DEFAULT_LIMITS` entries (`POST /admin/products`, `PATCH /admin/products/:id/stock`) with `max: 30, windowMs: 3600_000` — separate per-route counters with identical limits, NOT a shared bucket with `products:mutation` (so effective budget is 30/h per route, tunable independently; FR-013 "same quota" means same numbers, not shared state). User-dimensioned (`req.user.sub`), guard outermost, fail-open preserved. `GET /admin/products` unthrottled — explicit exemption per THROTTLE rule (reads, consistent with existing `GET` policy; stolen-admin-token scraping accepted as demo risk, revisit post-demo).
- **Rationale**: Implements Q5/A with no new env surface; `429` never holds a lock (guard runs before any service call).
- **Alternatives considered**: Mapping admin REST into the literal `products:mutation` bucket — rejected (bucket key derives from GraphQL field mapping; explicit REST keys with identical quota are clearer and independently tunable). True shared bucket — rejected (couples GraphQL + REST budgets).

## D6 — Auth: `@Auth(Admin)` on new routes + tighten legacy stock writes

- **Decision**: All three dashboard routes use `@Auth(Admin)` (existing `JwtGuard` + `RolesGuard`, no guard changes). Legacy `POST /inventory/:productId/increase|decrease` are tightened from `@Auth()` to `@Auth(Admin)` in this spec (T002b) — otherwise any authenticated customer could mutate stock around the demo's admin-only + throttled path, voiding FR-009/SC-005. `GET /inventory/:productId` + `/availability` stay any-role (reads).
- **Rationale**: FR-009 covers every stock-mutation path, not just the new doors; tightening is a one-line `[S]` with a 403 regression test and no client-behavior change for admins.

## D7 — Cache: inherit invalidation post-commit/fail-open, admin list uncached, `clear()` fallback contained

- **Decision**: Admin create inherits `ProductsService.create` → `invalidateAllLists()` (selective `del products:list:*` via `store.keys`, `clear()` fallback). Stock adjustments change `Inventory`, which the product list cache never stores as authoritative — but list responses embed quantities, so the stock-update path (T019) also calls the existing list invalidation **after commit, fail-open, never inside a tx**, with a `// TODO(CACHE-1a)` + warn log on the fallback path. The new `GET /admin/products` itself is **uncached** (bypasses `products:list:*` — see D4). `dashboard.module.ts` must have only one-way edges (dashboard → Products/Inventory/Auth, never reverse; no `@InjectRepository` of another module's entity).
- **Rationale**: Demo keeps customer-list cache correct on both writes with no new cache code and without making admin reads depend on filter-blind keys.
- **Known limitation (accepted, post-demo)**: the `clear()` fallback (CACHE-1a ban target) stays until the shared-helper phase replaces it; blast radius is the pre-existing one, unchanged by this feature — T019 adds a second caller but no new fallback semantics.

## D8 — Test strategy (constitution VII)

- **Decision**: Unit (dashboard status matrix incl. threshold override + missing-row; delta guard matrix; DTO validation incl. `delta ≠ 0`), integration on real PG (create→list round-trip, adjust up/down, `409` below-reserved/zero with stock unchanged, concurrent same-product adjusts last-wins with no guard violation), E2E (admin happy path + customer `403` on all three routes + validation `400` matrix).
- **Rationale**: Matches the repo's test pyramid; real PG for every consistency assertion; Redis/RMQ mocked.
