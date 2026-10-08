# Contract: Admin Products (Phase 20 Demo Scope)

All routes require `Authorization: Bearer <admin JWT>` (`@Auth(Admin)` → `401` unauthenticated, `403` non-admin). Throttled writes return `429` with `Retry-After` (see D5). Errors serialize as `{ statusCode, message, timestamp }` via `AllExceptionsFilter`.

## GET /admin/products — list with stock status

Query (all optional): `search?: string` (partial, case-insensitive name match), `status?: in-stock | low-stock | out-of-stock`, `minPrice?: int >= 0`, `maxPrice?: int >= 0`, `lowThreshold?: int 0..1000 (default 5)`, `page?: int >= 1 (default 1)`, `limit?: int 1..100 (default 20)`.

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

Params: `:id` UUID. Body: `{ delta: int, ≠ 0 }` (positive adds, negative subtracts).

- `200` updated inventory view (`{ id, productId, stock, reservedAmount, available, status }`)
- `400` validation (`delta = 0`, non-integer, malformed `:id`); `404` product or inventory not found; `409` adjustment would drop `stock < 0` or `stock < reservedAmount` (stock unchanged)
- `401` / `403` / `429` per above

> Absolute-set is intentionally absent (Q2/C). To set stock to `N`, read current `stock` and send `delta = N − stock`.
