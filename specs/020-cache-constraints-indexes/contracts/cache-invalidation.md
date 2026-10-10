# Contract: Product Cache Invalidation

**Feature**: `020-cache-constraints-indexes` | Applies to: `ProductsService` cache paths

## Namespaces (shared Redis store)

| Namespace | Owner | Product invalidation MUST NOT touch |
|-----------|-------|-------------------------------------|
| `products:list:*`, `product:*`, `products:cache-version` | catalog cache | — (these are the only deletable keys) |
| `rl:*` | rate limiting | preserve |
| `expiration:tick:lock`, `expiration:poison:*` | expiry worker | preserve |
| `notification:processed:*`, `notification:send:*` | idempotency/dedup | preserve |
| `resend:cooldown:*`, `otp:*` | auth flows | preserve |

## Rules

1. Every product mutation invalidates **after commit** via per-key `del` (singles) + pattern `del` (lists), or `INCR products:cache-version` when key listing is unavailable.
2. `cacheManager.clear()` MUST NOT appear on any product path (unit-asserted).
3. Invalidation failure is logged + swallowed (fail-open); the mutation commit stands; TTL expiry heals.
4. List keys embed every `findAll` input parameter; a new influencing parameter without a key change fails the key-completeness test.
