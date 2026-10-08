# Research: Admin Product & Stock (Phase 20 Demo Scope)

**Date**: 2026-10-08 | **Spec**: [spec.md](./spec.md) | **Plan**: [plan.md](./plan.md)
**Method**: Codebase inspection (no external research needed — all unknowns resolved by spec clarifications + existing code).

## D1 — New `dashboard` module for the admin surface

- **Decision**: Create `src/modules/dashboard/` with `dashboard.module.ts` (imports `ProductsModule`, `InventoryModule`, `AuthModule`), a thin `admin-products.controller.ts`, and `admin-products.service.ts` for list math. Controllers parse + delegate; all persistence goes through `ProductsService` / `InventoryService`.
- **Rationale**: `docs/plan.md` §20.5 mandates a separate module for the admin/operational surface; keeps customer GraphQL (`products.resolver.ts`) and admin REST in separate bounded concerns while sharing one service truth.
- **Alternatives considered**: Extending `products` module with a REST controller — rejected (mixes customer browse + admin write concerns in one module, harder to split later); generic `admin` module — rejected (`dashboard` is the plan-mandated name and future metrics home).

## D2 — Product creation reuses `ProductsService.create`

- **Decision**: `POST /admin/products` delegates to `ProductsService.create` unchanged. Its service already: slugifies + enforces unique name/slug (`409`), tolerates missing `stock` (defaults `0` — matches Q4/A), creates the `Inventory` row via `createForProduct`, and invalidates list caches post-save.
- **Rationale**: Zero new product-write logic; duplicate/conflict semantics already tested; REST DTO (`admin-create-product.dto.ts`: `name`, `description`, `price >= 0`, optional `stock >= 0`) maps 1:1 onto the existing input shape.
- **Alternatives considered**: Duplicating create logic in the dashboard service — rejected (dual write truth, violates TI-2 single-mutation-point direction).

## D3 — Delta-only stock update via new `adjustStockByDelta`

- **Decision**: Add `InventoryService.adjustStockByDelta(productId, delta)` where `delta > 0` delegates to `increaseStock(productId, delta)` and `delta < 0` delegates to `decreaseStock(productId, -delta)`; `delta === 0` rejected at DTO (`@IsInt, @NotEquals(0)`). The existing guards already enforce the spec: positive-integer quantities, `stock >= 0`, and `reservedAmount <= stock` (decrease below reserved → `409`, stock unchanged).
- **Rationale**: Matches Q2/C (signed delta only); reuses proven guards instead of inventing a third mutation path.
- **Alternatives considered**: Absolute-set mode — rejected by clarification Q2; callers needing "set to N" read current stock and send `N − stock` (documented in quickstart).
- **Known limitation (accepted, post-demo)**: `increase/decreaseStock` are lock-free read-modify-write (REFACTOR_PLAN B-3). Concurrent same-product admin edits are last-writer-wins; no reserved-unit corruption is possible (guards re-checked per write). The atomic helper ships post-demo.

## D4 — Stock status derived in the dashboard service

- **Decision**: `admin-products.service.listAdminProducts` loads products + their inventories in one paginated query (join, no N+1), computes `available = stock − reservedAmount` per row, and maps to status: `available <= 0` → `out-of-stock`; `0 < available <= threshold` → `low-stock`; else `in-stock`. Threshold: query param `lowThreshold`, default `5`, validated `@IsInt @Min(0) @Max(1000)`. Products with no inventory row return `stock=0, reservedAmount=0, available=0, status=out-of-stock` (Q3/B). Search: `ILIKE %name%` (case-insensitive); filters: `status`, `minPrice`, `maxPrice` combined with AND; envelope `{ data, meta }` reuses the repo pagination shape (`skip = (page−1) * limit`, default `limit=20`, cap 100).
- **Rationale**: Implements FR-002/FR-003/FR-004 exactly as clarified (Q1/A threshold, Q3/B missing-row fallback); single query keeps reads cheap; no stored status column (constitution III).
- **Alternatives considered**: Filtering `low-stock`/`out-of-stock` in SQL on `stock − reservedAmount` — equivalent; service-side mapping chosen so the status enum has exactly one definition shared by filter + response.

## D5 — Throttle reuse: same 30/h quota, new route keys

- **Decision**: Add two `DEFAULT_LIMITS` entries (`POST /admin/products`, `PATCH /admin/products/:id/stock`) with `max: 30, windowMs: 3600_000` (same quota family as `products:mutation`), user-dimensioned (`req.user.sub`), guard outermost, fail-open preserved. `GET /admin/products` unthrottled (reads, consistent with existing `GET` policy).
- **Rationale**: Implements Q5/A with no new env surface; `429` never holds a lock (guard runs before any service call).
- **Alternatives considered**: Mapping admin REST into the literal `products:mutation` bucket — rejected (bucket key derives from GraphQL field mapping; explicit REST keys with identical quota are clearer and independently tunable).

## D6 — Auth: `@Auth(Admin)` on new routes, existing routes untouched

- **Decision**: All three dashboard routes use `@Auth(Admin)` (existing `JwtGuard` + `RolesGuard`, no guard changes). Existing `POST /inventory/:productId/increase|decrease` (`@Auth()` any-role) are left untouched — demo admin writes go through the dashboard routes only.
- **Rationale**: FR-009 satisfied with zero behavior change to existing clients; tightening legacy inventory routes is a separate, approval-gated change (out of demo scope).

## D7 — Cache: inherit existing invalidation, leave `clear()` fallback as-is

- **Decision**: Admin create inherits `ProductsService.create` → `invalidateAllLists()` (selective `del products:list:*` via `store.keys`, `clear()` fallback). Stock adjustments change `Inventory`, which the product list cache never stores as authoritative — but list responses embed quantities, so the stock-update path also calls the existing list invalidation after commit.
- **Rationale**: Demo keeps cache correct on both writes with no new cache code.
- **Known limitation (accepted, post-demo)**: the `clear()` fallback (CACHE-1a ban target) stays until the shared-helper phase replaces it; blast radius is the pre-existing one, unchanged by this feature.

## D8 — Test strategy (constitution VII)

- **Decision**: Unit (dashboard status matrix incl. threshold override + missing-row; delta guard matrix; DTO validation incl. `delta ≠ 0`), integration on real PG (create→list round-trip, adjust up/down, `409` below-reserved/zero with stock unchanged, concurrent same-product adjusts last-wins with no guard violation), E2E (admin happy path + customer `403` on all three routes + validation `400` matrix).
- **Rationale**: Matches the repo's test pyramid; real PG for every consistency assertion; Redis/RMQ mocked.
