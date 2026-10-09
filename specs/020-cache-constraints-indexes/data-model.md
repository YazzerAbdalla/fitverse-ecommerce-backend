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

Run before writing DDL; record results here:

- [ ] Violation scan: `SELECT COUNT(*) FROM "Product" WHERE price < 0` (plus `Order.total < 0`, `Payment.amount < 0`, `Inventory` triple-check, `quantity <= 0` tables) → counts + cleanup decision per 2026-10-09 audit-first rule
- [ ] `EXPLAIN` expiry scan uses `status+expiresAt` composite → plan output
- [ ] `EXPLAIN` order-by-user, inventory-by-product, order-items-by-order → plan outputs
- [ ] `EXPLAIN` order-by-createdAt range (revenue window) → missing-index verdict + new index DDL if added
- [ ] Final ≤3 index list with per-index query evidence
