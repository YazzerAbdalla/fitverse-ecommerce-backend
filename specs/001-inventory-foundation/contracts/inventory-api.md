# Contract: Inventory REST API (Phase 1)

**Feature**: 001-inventory-foundation
**Surface**: REST (thin controller over `InventoryService`)
**Auth**: Protected. Inventory mutations require an authenticated principal; reserve/release/completeSale later phases may require admin/system role. Follow `@Auth(...roles)` + `JwtGuard` + `RolesGuard` (AGENTS.md §5).

> Justification: `docs/plan.md` §1.2–1.3 define an `inventory.controller.ts` and a
> business API. Endpoints below are derived directly from that; no invented fields
> or payment logic (Constitution VIII).

## Resources

Base path: `/inventory`

### GET /inventory/:productId
Return the inventory record for a product.
- **200** `{ id, productId, stock, reservedAmount, available, createdAt, updatedAt }`
- **404** `NotFoundException` if no inventory record exists.

### GET /inventory/:productId/availability?quantity=:q
Check whether `q` units are available (`available >= q`).
- **200** `{ available, requested: q, sufficient: boolean }`
- **400** validation error if `quantity` missing/non-positive.
- **404** if inventory not found.

### POST /inventory/:productId/increase
Increase `stock` by `quantity` (restock).
- **Body** `{ "quantity": number }` (positive integer)
- **200** updated inventory
- **400** invalid quantity; **409** if result would violate `stock >= 0` (defensive)

### POST /inventory/:productId/decrease
Decrease `stock` by `quantity` (sale without reservation, interim).
- **Body** `{ "quantity": number }` (positive integer)
- **200** updated inventory
- **409** `ConflictException` if `stock - quantity < 0`

### (Reserved for later phases — NOT implemented in Phase 1)
- `POST /inventory/:productId/reserve` → `reservedAmount += q`
- `POST /inventory/:productId/release` → `reservedAmount -= q`
- `POST /inventory/:productId/complete` → `stock -= q; reservedAmount -= q`

These are defined in `research.md` R5 and implemented in Phase 3/4 with transactional pessimistic locking.

## Error body (all routes)
`{ statusCode, message, timestamp }` (from global `AllExceptionsFilter`).

## DTOs (global `ValidationPipe`: whitelist + forbidNonWhitelisted + transform)
- `IncreaseStockDto` / `DecreaseStockDto`: `{ quantity: number }` with `@IsInt() @Min(1)`.
