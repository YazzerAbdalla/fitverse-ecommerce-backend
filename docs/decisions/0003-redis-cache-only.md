# ADR 0003 — Redis as Cache Only (Not Authoritative)

- **Status:** Accepted
- **Context:** Need fast reads (e.g. product listing) and a future home for rate
  limiting / job storage, without coupling business correctness to a cache.
- **Decision:** **Redis 8** is used **only as a cache** via
  `@nestjs/cache-manager` + `@keyv/redis` (ioredis). It is **never** a source of
  truth for inventory or orders.
- **Consequences:** Inventory/reservation decisions must not rely on cached values.
  Cache invalidation must be implemented when underlying data mutates (currently
  missing for product list — open question). Redis may be unavailable without
  corrupting the domain model.
- **Source:** `src/app.module.ts` (`CacheModule`), `products.service.ts`
  (`findAll` caching), `docs/plan.md` §21.
