# Data Model: Admin Product & Stock (Phase 20 Demo Scope)

**Date**: 2026-10-08 | **Spec**: [spec.md](./spec.md) | **Plan**: [plan.md](./plan.md)

> No schema change. No migration. All entities below already exist; this file records how the demo reads/derives them.

## Product (existing — read + create, no alteration)

| Attribute | Type | Rules |
|-----------|------|-------|
| `id` | uuid PK | generated |
| `name` | string | required, `@Unique`, max 100 |
| `slug` | string, nullable | derived server-side (`slugify(name)`), unique-or-null |
| `description` | string | required, max 250 |
| `price` | int | required, `>= 0` (`@Check`) |

Relationships: `1:1` → `Inventory` (inverse, read-only); `1:N` → `CartItem`, `OrderItem` (untouched).

## Inventory (existing — delta adjust, no alteration)

| Attribute | Type | Rules |
|-----------|------|-------|
| `id` | uuid PK | generated |
| `productId` | uuid FK → `Product.id` CASCADE | `@Unique`, `@Index` |
| `stock` | int | `>= 0`, and `>= reservedAmount` (DB `@Check` backstop; service `409` first) |
| `reservedAmount` | int | `>= 0`, `<= stock`; **never written by admin paths** (only checkout/lifecycle flows mutate it) |
| `available` | derived | `stock − reservedAmount`, getter only, never persisted |

New behavior (code only): `adjustStockByDelta(productId, delta)` (JSDoc `@param/@returns/@throws`; thin sign-dispatcher, guards stay in `increase/decreaseStock`) — `delta > 0` → stock increases (auto-creates the row via `createForProduct(productId, 0)` first when missing); `delta < 0` → stock decreases subject to the two guards above (`404` when the row is missing); `delta = 0` rejected before the service.

## AdminProductView (derived read model — not a table)

Returned per row by `GET /admin/products`:

| Field | Source |
|-------|--------|
| `id`, `name`, `slug`, `description`, `price` | `Product` |
| `stock`, `reservedAmount` | `Inventory` (`0`/`0` when row missing) |
| `available` | `stock − reservedAmount` |
| `status` | `StockStatus` derivation below |

## StockStatus (derived enum — never stored, never accepted from client)

```text
available <= 0                          → out-of-stock
0 < available <= lowThreshold           → low-stock
available > lowThreshold                → in-stock
```

- `lowThreshold`: per-request query param, default `5`, validated `0..1000`. Not persisted. `0` ⇒ `low-stock` unreachable (`0 < available <= 0` is empty — pinned by test).
- Missing `Inventory` row ⇒ `available = 0` ⇒ `out-of-stock` (clarification Q3/B) via `COALESCE`; the single SQL `CASE` expression (research D4) is the filter path, the TS mapper is the response path — tested as one behavior (T007/T008).

## Actors

- **Admin** (existing `UserRoles.Admin`): sole demo actor. No new roles, no user-management powers (FR-010).

## Validation summary (server-side, all re-checked in service)

- Create: name/description non-empty + lengths, `price` int `>= 0` (DTO/service-only — no DB `@Check`, known gap per research D2), `stock` optional int `>= 0` (omitted ⇒ `0`); duplicate name/slug ⇒ `409`, nothing created. REST DTO maps field-by-field onto `CreateProductInput` (never pass-through; `slug` server-derived).
- List: `search` `@MaxLength(100)` with `%_\\` escaping, `page >= 1`, `1 <= limit <= 100` (extend shared pagination DTO), `lowThreshold 0..1000`, `minPrice/maxPrice >= 0` (`minPrice <= maxPrice` enforced in service else `400`), `status ∈ {in-stock, low-stock, out-of-stock}`. Response via explicit `toAdminProductView()` allow-list (never spread entities).
- Adjust: `:id` via `ParseUUIDPipe`, `delta` int `≠ 0`; resulting `stock >= 0` and `>= reservedAmount` else `409`, stock unchanged; invalidation post-commit fail-open (`TODO(CACHE-1a)`).
