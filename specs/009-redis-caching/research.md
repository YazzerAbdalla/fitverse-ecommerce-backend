# Research: Redis / Product Caching (Phase 9)

**Branch**: `009-redis-caching` | **Date**: 2026-09-22 | **Spec**: [spec.md](./spec.md) | **Plan**: [plan.md](./plan.md)

All `NEEDS CLARIFICATION` from Technical Context resolved (0). Spec Session 2026-09-22 provides 5 clarifications. Research consolidates best practices and rejected alternatives for cache-aside product layer.

---

## D1: Cache keys — `products:list:{page}:{limit}` and `product:{id}`

- **Decision**: List `products:list:{page}:{limit}` (e.g., `products:list:1:10`) with exact numeric `page:limit` from `PaginationArgs`; single `product:{id}` (e.g., `product:3f7c...`). List namespace for bulk invalidation `products:list:*`. No search hash V1 (extends as `products:list:{page}:{limit}:{hash}` when search added).
- **Rationale**: Matches existing implementation at `src/modules/products/products.service.ts:158` (`const key = `products:list:${page}:${limit}``) and `docs/plan.md` example `product:{productId}`. `:` separator is idiomatic for Redis namespaces and `KEYS` prefix scans. Separate prefixes prevent collision with `expiration:*` (`reservation-expiration.service.ts:19`) and future `inventory:*` (never used).
- **Alternatives considered**:
  - `products:{page}:{limit}` without `list` segment — rejected: collides with single `product:{id}` prefix on `KEYS product:*`.
  - Hash incorporating `skip/take` raw vs `page/limit` — rejected: `page/limit` is canonical pagination API, stable under `skip = (page-1)*limit`.
  - Include `search`/`sort` now — rejected: `findAll` still has `TODO Add search and filters`; premature hash complicates keys for no query.

---

## D2: TTLs — list 60s, single 300s via `ConfigService`, clamped

- **Decision**: `PRODUCT_LIST_CACHE_TTL_MS` default `60_000` (60s per `CacheModule.registerAsync` `ttl:60*1000` in `src/app.module.ts:41`), `PRODUCT_SINGLE_CACHE_TTL_MS` default `300_000` (300s). Read via `ConfigService.get<string>` → `parseInt` with fallbacks; per-entry `cacheManager.set(key, value, ttlMs)` overrides global. Clamped minima `list >=5_000`, `single >=30_000`; misconfigured (0/negative/NaN) → fallback + `Logger.warn`.
- **Rationale**: Lists aggregate many rows and go stale faster after admin edit; short 60s balances hit rate vs staleness (Phase 9 tasks: `Define TTLs`). Singles vary per id, longer 300s amortizes detail-page hits. Configured via env (AGENTS.md Configuration rule — never hardcode). Existing `CacheTestService` and `ExpirationProcessor` 30s cadence show Redis cost is negligible at this scale (10k products).
- **Alternatives considered**:
  - Single global TTL via `CacheModule ttl` only — rejected: forces 60s for singles too short for detail hits.
  - Write TTL in seconds (`PRODUCT_CACHE_TTL=60`) — rejected: `cache-manager` with `@keyv/redis` expects ms in `app.module.ts:41` (`ttl:60*1000`); ms is already used for `ProductCacheEntry`.
  - 5m list / 1h single aggressive — rejected: stale listings would persist 5m after `createProduct` if invalidation missed; 60s safer for V1 with fail-open.

---

## D3: Invalidation — selective `store.keys(products:list:*)→del` vs `clear()` fallback

- **Decision**: After successful DB commit, **selectively** delete all `products:list:*` via `cacheManager.store.keys('products:list:*')` (ioredis `KEYS`) if `store.keys` exists, then `Promise.all(keys.map(k => cacheManager.del(k)))` best-effort. Delete each affected `product:{id}` via `cacheManager.del`. If `store.keys` unsupported (in-memory `cache-manager` on CI), fallback to `cacheManager.clear()` with documented collateral caveat (`expiration:tick:lock`, `expiration:poison:count` would be evicted if sharing instance — acceptable only as fallback). All `del` wrapped `try/catch` `Logger.warn`.
- **Rationale**: `docs/plan.md` Phase 9 tasks: `Invalidate cache after product mutation`. Selective `keys→del` avoids nuking `expiration:*` namespace used by `ReservationExpirationProcessor` (`expiration:tick:lock` `SET NX EX`) and `expiration:poison:*` (`src/modules/reservation/reservation-expiration.service.ts:19`). `KEYS` at product-list cardinality (tens of pagination combos) is cheap; alternative `SCAN` not needed. `@nestjs/cache-manager` `Cache` wraps `Keyv`; `Keyv` with `@keyv/redis` exposes `store` with `keys` via underlying ioredis when available — verified by checking `node_modules/@keyv/redis/src/index.ts` `getMany`/`clear` impl (covers `store.keys` shadowing). Fallback `clear()` retained for CI in-memory store per spec Edge Case `REDIS_URL unset`.
- **Alternatives considered**:
  - Always `cacheManager.clear()` — rejected: collateral eviction of `expiration:*` would break BullMQ singleton tick lock and poison TTL, causing duplicate expiration runs.
  - Keep in-memory `Set` of known list keys (track on every `set`) — viable but leaks unbounded memory and misses keys set by other instances in multi-instance deploy; `keys` via Redis is authoritative across instances.
  - Tag-based invalidation (`products:list` tag) — rejected: requires Redis `JSON` or `Redisson` feature not in current `cache-manager`/`Keyv` API.

---

## D4: Single `product:{id}` cached, negative lookups not cached

- **Decision**: `findOne(id)` cache-aside `product:{id}` 300s; only cache when `product !== null`. Missing `id` returns `null/404` without `set`.
- **Rationale**: `docs/plan.md` example `product:{productId}` and `CartItem.product` `eager:true` path benefit from single-hit; negative caching would require TTL-evicted placeholder and complicate `createProduct` (create would need to `del` negative key that never existed as list invalidation already suffices).
- **Alternatives considered**:
  - Cache `null` with short 5s negative TTL (`SET product:missing null EX 5`) — rejected: extra `del` on create path and risk of serving stale 404 after creation within TTL; list invalidation restores discoverability simpler.
  - No single cache (list only) — rejected: `findOne` called per-detail and violates FR-004; detail hit rate lost.

---

## D5: Fail-open on every cache operation

- **Decision**: Every `get/set/del/keys/clear` is `try { await cacheManager.xxx } catch (e) { this.logger.warn('Cache ... failed for key ...', (e as Error).message) }`. Read failures fallback to DB `findOne/findAndCount`; invalidation failures log but do not throw or rollback the already-committed DB mutation. `CacheTestService` `onModuleInit` already logs but does not crash (spec §2 Story 4).
- **Rationale**: Constitution I (Redis cache-only, never authoritative) and `AGENTS.md` async rule (failures not rolled back) + existing `RateLimitGuard` fail-open via `INCR+EXPIRE` precedent. Keeps catalog `200` during Redis outage (FR-006/SC-007). `AllExceptionsFilter` serializes only real `409/404`, not cache transport errors.
- **Alternatives considered**:
  - Propagate Redis error as `503` — rejected: ties catalog availability to Redis uptime, breaks constitution.
  - Circuit-breaker (`opossum`) — viable future but overkill for V1; simple `warn+fallback` covers `ECONNREFUSED`.

---

## D6: Invalidation timing — after DB commit, outside transaction

- **Decision**: `create`/`createMany`/`update` invalidate **after** `productsRepo.save` resolves; `updateMany` (`dataSource.transaction(async manager => ... FOR UPDATE ... manager.save)`) invalidates **after** the `transaction` promise resolves (outside `manager` scope). No `cacheManager` I/O inside `dataSource.transaction`. On `BadRequestException`/`NotFoundException`/`ConflictException` before `save`, no invalidation.
- **Rationale**: Follows constitution Additional Constraints “async events published ONLY after commit” and AGENTS.md Transactions “all writes via `manager`”. Cache invalidation is side-effect analogous to `reservation.expired` post-commit publish (`reservation-expiration.service.ts:44`). In-transaction `del` would be wasted if `ROLLBACK` and would hold transaction open longer (lock window). Post-commit keeps `stock`/`reservedAmount` authoritative.
- **Alternatives considered**:
  - In-transaction `del` + rollback cache on failure (cache rollback) — rejected: cache has no transactions; restores complexity and longer lock.
  - Background BullMQ invalidation job — rejected: adds queue latency; product list staleness 60s tolerates immediate `del` but not deferred job.

---

## Risk Mitigations

- **Stale list after selective `del` missed key**: List TTL 60s bounds staleness; `KEYS` enumerates all `products:list:*` atomically per invalidation.
- **Thundering herd duplicate DB hits**: Both `findAndCount` then `set`; last write wins, no correctness loss (FR-003 Edge Case).
- **`REDIS_URL` unset CI**: `createKeyv(undefined)` falls back to in-memory `cache-manager`; `store.keys` absent → `clear()` fallback path exercised in tests.

## Open items to verify in implementation

- Confirm `Cache` type is `import { Cache } from 'cache-manager'` via `@nestjs/cache-manager` `CACHE_MANAGER` token (already in `products.service.ts:16`).
- Confirm `ConfigService` TTL parsing produces number ms (env string → `parseInt`, NaN fallback to defaults).
- Confirm `Logger` warn prefixes distinguish `Cache GET/SET/DEL failed for key X`.

