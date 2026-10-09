# Data Model: Cache Constraints Indexes

**Branch**: `020-cache-constraints-indexes` | **Date**: 2026-10-09
No new entities. Changes are additive `CHECK`s, ≤3 evidence-gated indexes, and documented cache shapes.

## 1. Cache shapes (documented, values unchanged)

| Entry | Key | Value | TTL (ms) |
|-------|-----|-------|----------|
| Product list | `products:list:{page}:{limit}` → `products:list:v{n}:{page}:{limit}` once version-stamp fallback lands (dual-read during rollout not needed; single writer) | `{ data, meta }` envelope (byte shape unchanged) | 60_000 (`PRODUCT_LIST_CACHE_TTL_MS`, min 5_000) |
| Single product | `product:{id}` | `Product` row (no stock fields — none exist on entity) | 300_000 (`PRODUCT_SINGLE_CACHE_TTL_MS`, min 30_000) |
| Cache version | `products:cache-version` (new, only used when `store.keys` unavailable) | integer counter | no expiry |

Relationships: list/single entries reference `Product` rows by id; invalidation deletes product keys only — never `rl:*`, `expiration:*`, `notification:*`, `resend:*`, `otp:*` namespaces. Availability path (`available = stock − reservedAmount` from locked `Inventory` row) never reads these entries.

## 2. Entity changes (migration `1755900000013-*`)

| Entity | Change | Validation |
|--------|--------|------------|
| `Product` | `+@Check('"price" >= 0')` | Service re-checks untrusted client prices (constitution VIII); DB is backstop |
| `(audit)` | Further `CHECK`s only per §Audit findings | Each maps to spec FR-008 value class |
| `(audit)` | ≤3 `@Index` additions, each with query evidence + `EXPLAIN` | Each maps to spec FR-010 hot path |

State transitions: none (lifecycle untouched). Uniqueness: unchanged (`Product.name`, `Inventory.productId`, reservation/order item pairs).

## 3. Audit (blocking precondition for migration task)

Recorded 2026-10-09 on live dev PG (`ecommerce`, tables lowercase):

- [x] Violation scan: `product.price < 0` → 0; `"order".total < 0` → 0; `inventory` triple-check → 0; `payment.amount < 0` → 0; `order_item quantity/unit_price` → 0; `reservation_item quantity` → 0. Verdict: strict `CHECK`s safe, no cleanup needed.
- [x] `EXPLAIN` expiry scan uses `status+expiresAt` composite → `Index Scan using IDX_18950fa318a3e2e63f7be6ec27` ✓ re-proven, no action.
- [x] `EXPLAIN` inventory-by-product → `Seq Scan` but `btree ("productId")` + `UQ` exist (tiny-table planner choice, same fragility as ADR-0014) → index-existence asserted, no action. Same for `cart("userId")` (unique constraint covers).
- [x] `EXPLAIN` revenue window (`status='COMPLETED' AND created_at BETWEEN`) → `Seq Scan`, no supporting index → **ADD `IDX_order_status_createdAt (status, created_at)`**.
- [x] `EXPLAIN` owner listing (`userId = ? ORDER BY created_at DESC`) → `Seq Scan + Sort`, no supporting index → **ADD `IDX_order_userId_createdAt (userId, created_at)`**.
- [x] Final new-index list (2 of ≤3 budget): the two order composites above. No speculative adds.
