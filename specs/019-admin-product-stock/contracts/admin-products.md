# Contract: Admin Products (Phase 20 Demo Scope)

All routes require `Authorization: Bearer <admin JWT>` (`@Auth(Admin)` → `401` unauthenticated, `403` non-admin). Throttled writes return `429` with `Retry-After` (see D5). Errors serialize as `{ statusCode, message, timestamp }` via `AllExceptionsFilter`.

## GET /admin/products — list with stock status

Query (all optional): `search?: string` (partial, case-insensitive name match, `@MaxLength(100)`, LIKE wildcards `%_\\` escaped), `status?: in-stock | low-stock | out-of-stock` (filtered in SQL on the same CASE expression before pagination), `minPrice?: int >= 0`, `maxPrice?: int >= 0` (`minPrice <= maxPrice` enforced in service → 400), `lowThreshold?: int 0..1000 (default 5; 0 ⇒ `low-stock` unreachable by construction)`, `page?: int >= 1 (default 1)`, `limit?: int 1..100 (default 20)`. Admin list bypasses the `products:list:*` cache (filter-blind keys).

- `200 { data: AdminProductView[], meta: { totalItems, itemCount, itemsPerPage, totalPages, currentPage } }`
- `400` invalid pagination/filter values (`minPrice > maxPrice`, unknown `status`)
- `401` / `403` per above

`AdminProductView = { id, name, slug, description, price, stock, reservedAmount, available, status }`.

## POST /admin/products — create with initial stock

Body: `{ name: string (1..100), description: string (1..250), price: int >= 0, stock?: int >= 0 (default 0) }` — unknown fields rejected (`forbidNonWhitelisted`).

- `201` created product + initialized inventory (response includes `available` + `status`)
- `400` validation failure; `409` duplicate name/slug (nothing created)
- `401` / `403` / `429` per above

## PATCH /admin/products/:id/stock — delta adjustment

Params: `:id` product UUID (`ParseUUIDPipe` → malformed `:id` is `400`, never `500`). Body: `{ delta: int, ≠ 0 }` (positive adds, negative subtracts).

- `200` updated inventory view (`{ id, productId, stock, reservedAmount, available, status }`) via explicit allow-list mapper
- `400` validation (`delta = 0`, non-integer, malformed `:id`, `minPrice > maxPrice` on list); `404` product not found, or inventory not found when `delta < 0` on a missing row; `409` adjustment would drop `stock < 0` or `stock < reservedAmount` (stock unchanged)
- Missing-row policy: `delta > 0` on a missing row auto-creates via `createForProduct(productId, 0)` then applies the increase (orphan repair); `delta < 0` on a missing row → `404`.
- `401` / `403` / `429` per above

> Absolute-set is intentionally absent (Q2/C). To set stock to `N`, read current `stock` and send `delta = N − stock`.
