# Feature Specification: Redis / Product Caching

**Feature Branch**: `009-redis-caching`  
**Created**: 2026-09-22  
**Status**: Draft  
**Input**: User description: "phase 9"  
**Source**: `docs/plan.md` Phase 9 — Redis / Caching (§9), constitution I/III/IV (`AGENTS.md` Architecture: PostgreSQL authoritative, Redis cache-only, never source for inventory/reservation/order), existing `src/modules/products/products.service.ts` (`findAll` cached `products:list:{page}:{limit}`) + `src/app.module.ts` (`CacheModule` via `@nestjs/cache-manager` + `@keyv/redis` ioredis, `REDIS_URL`, ttl `60*1000`, `CacheTestService` connection check) + `src/modules/inventory/inventory.service.ts` (`available = stock - reservedAmount`)

---

## 1. Overview

Phases 1-8 built a transactionally correct product → inventory → reservation → order pipeline. `Product` is the customer-facing catalog (GraphQL `products` query, `findAll` paginated `skip=(page-1)*limit`, `findOne`, `create`/`createMany`/`update`/`updateMany`/`remove`). `Inventory` (`stock`, `reservedAmount`, `available=stock-reservedAmount`) is authoritative in PostgreSQL; reservations and checkout mutate it inside `FOR UPDATE` transactions. No other store drives inventory decisions.

Redis infrastructure already exists (`docker-compose.yml` redis:8, `CacheModule` global with `createKeyv(REDIS_URL)` + BullMQ shared connection, `CacheTestService` verifying `SET connection_test_key` on bootstrap). The current product listing is partially cached: `ProductsService.findAll` does cache-aside `products:list:{page}:{limit}` with a single global TTL, but:

- there is **no single-product cache** (`product:{id}`),
- **invalidation** after `create`/`update`/`updateMany`/`remove`/`createMany`/`resetAll` is missing (lists stay stale),
- cache keys/TTLs are ad-hoc, and
- no tests assert hit/miss/invalidation or the fail-open rule.

Phase 9 **does not** introduce a new domain. It hardens the product cache so that **read-heavy catalog browsing is fast and cheap** without ever letting Redis decide inventory availability. This is the user request `phase 9` in `docs/plan.md`.

**Decision for Phase 9 V1** (per `docs/plan.md` Important Rule + constitution): **Products only**. Inventory/Reservation/Order/Cart are **never cached** for business decisions. Redis is a **derived, evictable copy** of `Product` rows — on `CACHE MISS` read PostgreSQL; on `CACHE HIT` return the cached payload; on any product mutation invalidate the affected keys **after** DB commit; on Redis failure log and fall back to DB (fail-open). No write-through, no Redis-as-primary, no inventory stock cached.

### Goal

Customer product browsing hits Redis when possible and always reconciles with PostgreSQL on miss, while every product mutation promptly invalidates its cache entries — without making Redis authoritative for inventory, reservations, or orders. — `docs/plan.md` Phase 9 Exit Criteria (adapted).

---

## 2. User Scenarios & Testing

### User Story 1 — Product listing is fast on second read (cache hit) after a miss (Priority: P1)

A shopper (anonymous or authenticated) browses the catalog via GraphQL `products(page:1, limit:10)`. On the first request the cache is empty; the system reads PostgreSQL (`findAndCount` with `take/skip`), builds `{ data, meta:{ totalItems, itemCount, itemsPerPage, totalPages, currentPage } }`, stores it under `products:list:1:10` with TTL, and returns it. An immediate second identical request hits the cache and returns the same payload **without touching the database** (verified by a DB call count spy or by the `Logger.debug Cache HIT` path), in measurably less time.

**Why this priority**: This is the core value of caching — offloading the most frequent, read-heavy query (paginated product listing) from PostgreSQL. Every other caching behavior (invalidation, single-item cache) depends on a correct hit/miss path.

**Independent Test**: Seed 3 products. Clear Redis (`cacheManager.clear()` or `FLUSHDB`). Call `findAll({page:1, limit:10})` → assert `Logger.debug Cache MISS: products:list:1:10` and `productsRepo.findAndCount` was called exactly once and `cacheManager.get` returned `undefined` on first invocation, then response equals expected `data/meta`. Call `findAll({page:1, limit:10})` again without mutating → assert `Logger.debug Cache HIT` and `productsRepo.findAndCount` was **not** called a second time (spy `calledOnce`), and payload is deep-equal to first. Optionally assert second-call latency < first-call latency (not a hard SLA). Flush key and repeat to prove re-miss → re-populate.

**Acceptance Scenarios**:

1. **Given** Redis has no `products:list:1:10` (cleared), **When** `GET` GraphQL `products(page:1,limit:10)` is called the first time, **Then** system logs `Cache MISS`, queries `Product` table, caches the result under `products:list:1:10` with TTL, and returns `200 { data:[...3], meta:{ totalItems:3, totalPages:1 } }`.
2. **Given** `products:list:1:10` is now cached (TTL not expired), **When** the same `products(page:1,limit:10)` is called again, **Then** system logs `Cache HIT: products:list:1:10`, does **not** call `findAndCount`, and returns an identical `data/meta` payload from cache.
3. **Given** two different paginations `products:list:1:10` and `products:list:2:10` exist, **When** each is fetched, **Then** they are cached under distinct keys (`products:list:1:10` vs `products:list:2:10`) and a hit on one does not serve the other.
4. **Given** the cached entry's TTL has expired (wait or mock `cacheManager` TTL), **When** `products(page:1,limit:10)` is called again, **Then** it is a `Cache MISS` again, re-queries DB, and re-caches.

---

### User Story 2 — Any product mutation promptly invalidates the affected caches (Priority: P1)

A `ContentManager`/`Admin`/`CoAdmin` (per Phase 20 roles, V1 at least `Admin`) creates, updates, bulk-updates, or deletes a product via GraphQL mutations (`createProduct`, `createManyProducts`, `updateProduct`, `updateMany`, `removeProduct`, `removeAllProducts`). After each successful DB commit, the system invalidates every `products:list:*` key (list invalidation) **and** the specific `product:{id}` key(s) so that the next `products`/`product` query is a miss and reflects the mutation. Without this, shoppers would see stale prices/names after an admin edit.

**Why this priority**: Without invalidation, caching introduces correctness bugs: a product renamed or deleted remains visible in cached listings until TTL expiry. Invalidation is the safety property that makes caching viable for a mutable catalog. Equal priority to Story 1.

**Independent Test**: With `products:list:1:10` cached (from Story 1), perform `createProduct({name:"New", price:250, description:"x"})` as Admin → assert DB row created **and** cache for `products:list:1:10` was deleted (`cacheManager.del` called with key or `clear` of list namespace) and subsequent `findAll({page:1,limit:10})` is a `Cache MISS` returning `totalItems:4` including the new product. Repeat for `updateProduct(id, {name:"Renamed"})` → next `findOne(id)` is a miss and returns renamed value; `removeProduct(id)` → subsequent `findOne(id)` 404 and lists no longer contain it. Test `updateMany` and `createMany` invalidate all list keys.

**Acceptance Scenarios**:

1. **Given** `products:list:1:10` is cached with `totalItems:3`, **When** admin `createProduct({name:"New Cake", price:250})` succeeds, **Then** `products:list:1:10` (and all `products:list:*` keys) is deleted; next `products(page:1,limit:10)` is a `Cache MISS` and returns `totalItems:4` with the new product.
2. **Given** `product:abc` is cached (from `product(id:abc)` flow), **When** admin `updateProduct(id:abc, {price:999})` succeeds, **Then** `product:abc` is deleted and all `products:list:*` are deleted; next `product(id:abc)` is a `Cache MISS` returning `price:999`, and next `products(page:1,limit:10)` is a `Cache MISS` reflecting the new price.
3. **Given** multiple lists cached (`products:list:1:10`, `products:list:2:10`), **When** admin `updateMany([{id:abc, price:999},{id:def, price:888}])` succeeds transactionally, **Then** both `product:abc` and `product:def` are deleted and **all** `products:list:*` keys are deleted; next `products(page:1,limit:10)` and `products(page:2,limit:10)` are misses.
4. **Given** `products:list:1:10` cached, **When** admin `removeProduct(id:abc)` succeeds (or `removeAllProducts`), **Then** `product:abc` deleted and all `products:list:*` deleted; next `product(id:abc)` returns `null/404` and `products(page:1,limit:10)` is a miss without the deleted row.
5. **Given** a product mutation fails (duplicate name `409`, validation `400`, or missing id `404`), **When** the mutation was not committed, **Then** caches are **not** invalidated — subsequent reads still hit the prior cached value (no spurious invalidation on failure).

---

### User Story 3 — Single product fetch is cached and shares invalidation with the list (Priority: P2)

A shopper fetches a single product `product(id:uuid)` (or a cart loads `CartItem.product` eager). The first load caches `product:{id}` with its own TTL; the second load hits the cache. Any later mutation of that product invalidates both `product:{id}` and all lists, keeping detail and listing views consistent.

**Why this priority**: P2 because listing covers the dominant load; single-item caching accelerates `product(id)` and reduces per-detail DB hits, but depends on the same invalidation contract as Story 2. Isolated, it still delivers value for product-detail pages and cart hydration paths that reuse `findOne`.

**Independent Test**: Clear Redis. `findOne(id:known)` first time → `Cache MISS product:known`, `productsRepo.findOne` called, `cacheManager.set product:known` called. Second `findOne(id:known)` → `Cache HIT product:known`, no `findOne` call. Mutate that product via `updateProduct` → `cacheManager.del product:known` was called, and next `findOne(id:known)` is a miss with updated value.

**Acceptance Scenarios**:

1. **Given** no `product:abc` in cache, **When** `product(id:abc)` is queried, **Then** `Cache MISS product:abc`, DB row loaded, cached with TTL, and returned.
2. **Given** `product:abc` is cached, **When** `product(id:abc)` queried again before TTL, **Then** `Cache HIT product:abc`, no DB call, same payload.
3. **Given** `product:abc` cached and `products:list:1:10` cached, **When** `product:abc` is updated or deleted, **Then** both `product:abc` and every `products:list:*` invalidated; subsequent reads for both are misses reflecting the mutation.

---

### User Story 4 — Redis failures never break product reads, and inventory is never served from cache (Priority: P2)

When Redis is unreachable (network partition, `ECONNREFUSED`, or `cacheManager.get/set/del` throws), the system **fails open**: it logs a warning and falls back to PostgreSQL instead of returning `500` or stale inventory data. Separately, product mutations that change `Inventory.stock` (via `InventoryService.createForProduct` on product create) must not confuse product caching with inventory authority — availability decisions (`available = stock - reservedAmount`) always read `Inventory` from the transactional DB path.

**Why this priority**: P2 reliability invariant. Constitution §1/2 is explicit: Redis is cache-only, never authoritative for inventory/reservation/order. Without fail-open, a Redis outage would take down the entire catalog (and by extension cart/order flows). With inventory accidentally cached, overselling becomes possible.

**Independent Test**: With a mocked `cacheManager` that throws on `get`/`set`/`del`, call `findAll` → assert it still returns correct `data/meta` from DB, logs `Logger.warn Cache unavailable, fallback to DB`, and does not propagate the Redis error. Call `createProduct` with mocked `del` failure → assert mutation still commits to DB, `Logger.warn` emitted, and no `500`. Also assert inventory `getInventory` path never calls `cacheManager` — spy never invoked.

**Acceptance Scenarios**:

1. **Given** Redis is down (`cacheManager.get` throws `ECONNREFUSED`), **When** `products(page:1,limit:10)` is queried, **Then** response is `200` with data from DB, log warns `Cache GET failed for key products:list:1:10: <error>` but does not throw, and no empty-cache error is exposed.
2. **Given** Redis `SET` or `DEL` throws during `findAll` populate or post-mutation invalidation, **When** the operation completes, **Then** the DB result/mutation still succeeds, warning logged, and subsequent calls retry the cache on next request (no 500).
3. **Given** a product exists with `Inventory {stock:10, reservedAmount:2, available:8}`, **When** `CartService` checks `available >= requestedQty` or `ReservationService` locks `Inventory FOR UPDATE`, **Then** that check never consults Redis cache — it is a direct `getInventory`/`SELECT ... FOR UPDATE` on PostgreSQL; no `product:{id}` cached entry contains `stock`/`reservedAmount`.
4. **Given** `PRODUCT_CACHE_TTL` configuration is missing, **When** app boots, **Then** `ConfigService` falls back to defaults (`products:list` 60s, `product:{id}` 300s) and `Logger.log Product cache TTLs: list=60s single=300s`.

---

### Edge Cases

- What happens when `page`/`limit` are omitted (null/undefined)? → Same as existing `findAll`: `skip=(page-1)*limit` uses supplied args; cache key encodes the exact `page:limit` used (`products:list:1:10` vs `products:list::`), and `ValidationPipe` coerces DTO; missing pagination still caches under its computed key without collision.
- What happens when `page`/`limit` are large or zero? → `PaginationArgs` validation rejects `page<1`/`limit<1`; caches are not created for invalid inputs (400 path).
- What happens when TTL is zero or negative from config? → Clamp to minimum `5s` for lists, `30s` for single, or fallback to default; log warning.
- What happens when multiple distinct paginations are cached (`products:list:1:10`, `products:list:1:20`, `products:list:2:10`) and a single product mutates? → **All** `products:list:*` keys must be invalidated, not just `products:list:1:10`. Implementation pattern `keys(products:list:*)` → `del` (via `cacheManager.store` or iterative `del` of known pages) — see FR-005. V1 may enumerate known pagination keys in memory or use `store.keys` if available; document the choice in plan (Redis `KEYS` is acceptable here at low cardinality; alternative: `clear` list namespace via prefix).
- What happens when `createMany`/`updateMany` partially succeed (some names duplicate → `400` all input names exist, or `404` some ids missing inside transaction)? → No invalidation on failure; only on committed success. `productsService.createMany` already throws `BadRequestException`/`NotFoundException` before `save`; cache untouched.
- What happens when `product:missing-id` is not found (404)? → Do **not** cache a negative entry (`null`). Next fetch re-attempts DB; if someone creates it later, the later list invalidation will allow it to appear.
- What happens when two `findAll` concurrent misses for same key race (thundering herd)? → Both may `findAndCount` and `set`; last write wins, no correctness issue (product rows are not transactional). Optional single-flight guard (future) but V1 tolerates duplicate DB hits under high concurrency.
- What happens when Redis `FLUSHDB` or eviction clears entries mid-request? → Next request is a miss and repopulates; no error.
- What happens when `REDIS_URL` is empty/unset in `.env` (CI without Redis)? → `CacheModule` with `createKeyv(undefined)` falls back to in-memory `cache-manager` store (per `@nestjs/cache-manager` default) or `Noop`; `findAll` still works but without cross-instance sharing — logged as `Logger.warn Redis URL not set, using in-memory cache`.
- What happens when an admin calls `resetAll` deleting all products? → All `products:list:*` + every `product:{id}` deleted (or `cacheManager.clear()` for product namespace); subsequent `findAll` returns empty `data:[] totalItems:0` and caches that empty result (optional, but V1 may cache empties briefly 30s to avoid hammering an empty table).
- What happens when `findOne` is called with a non-UUID string? → `@IsUUID` or service `NotFound` path; no cache operation.
- What happens when `available` formula changes on `Inventory`? → Product caching bypasses inventory; no effect.

---

## 3. Requirements

### Functional Requirements

- **FR-001**: System MUST define **product cache keys** deterministically. Required keys (V1):
  - Single: `product:{productId}` — e.g., `product:3f7c...`
  - List: `products:list:{page}:{limit}` — e.g., `products:list:1:10`
  - List namespace prefix for invalidation: `products:list:*` (all paginations)
  - Optional (if search/filter added later): `products:list:{page}:{limit}:{searchHash}` — not required V1, but pattern must not break extension.
  Keys MUST be documented in `docs/architecture` and used consistently in both `get` and `set`/`del`. No ad-hoc keys.

- **FR-002**: System MUST define and apply **TTLs per cache type** via configuration (env + `ConfigService`, never hard-coded), with sensible defaults:
  - List cache: `PRODUCT_LIST_CACHE_TTL_MS` (default `60_000` ms = 60s), short because listings are asked often and go stale quickly after admin edits.
  - Single cache: `PRODUCT_SINGLE_CACHE_TTL_MS` (default `300_000` ms = 300s = 5 min), longer because a single row changes less often per key.
  - AppConfig `CacheModule.registerAsync` `ttl` default is `60*1000` ms; per-entry `cacheManager.set(key, value, ttlMs)` overrides as needed (300s for singles).
  - TTL values MUST be clamped to minima (`list >= 5_000`, `single >= 30_000`) if misconfigured, with `Logger.warn` + fallback.
  - All TTLs read via `ConfigService.get<number>('PRODUCT_LIST_CACHE_TTL_MS')` style (or `parseInt`) and never via bare `process.env` inside service.

- **FR-003**: System MUST implement **cache-aside for product listings** in `ProductsService.findAll(paginationArgs)`:
  1. Compute `key = products:list:{page}:{limit}` (use exact numeric page/limit from args, defaulted by `PaginationArgs`).
  2. `cached = await cacheManager.get(key)` inside `try/catch`; on `hit` (`cached !== undefined && cached !== null`) → `Logger.debug Cache HIT: <key>` → return cached `PaginationOutput` immediately (no DB).
  3. On `miss` (`cached == null`) or `cacheManager.get` threw → `Logger.debug Cache MISS: <key>` (or `Logger.warn Cache GET failed ...` on throw) → query DB with `productsRepo.findAndCount({ take: limit, skip: (page-1)*limit })` (existing behavior, no extra lock).
  4. Build `result = { data, meta: { totalItems, itemCount, itemsPerPage, totalPages, currentPage } }`.
  5. `await cacheManager.set(key, result, PRODUCT_LIST_CACHE_TTL_MS)` inside `try/catch`; `set` failure is logged `Logger.warn Cache SET failed for <key>: <msg>` but does not throw or omit the return.
  6. Return `result`.
  The DB path MUST remain the fallback on any cache error (fail-open). No Redis I/O inside a `DataSource.transaction`.

- **FR-004**: System MUST implement **cache-aside for single product reads** in `ProductsService.findOne(id)`:
  1. `key = product:{id}`.
  2. `cached = cacheManager.get(key)` try/catch; hit → return cached `Product`.
  3. Miss → `product = await productsRepo.findOne({ where:{ id } })`; if `null` → return `null` (do not cache negative lookups).
  4. If found → `cacheManager.set(key, product, PRODUCT_SINGLE_CACHE_TTL_MS)` best-effort, log `Cache MISS/HIT product:{id}` similarly, fail-open on error, return entity.
  `findOne` MUST NOT mutate inventory and MUST not derive `stock/available` from cache.

- **FR-005**: System MUST **invalidate product caches immediately after successful mutations**, never before commit and never on failure. All mutating paths MUST, after `productsRepo.save/delete` succeeds:
  - Delete the single keys for every affected product id: `await cacheManager.del(product:{id})` (or `store.del`/`del` per driver) one by one, best-effort `try/catch` with `Logger.warn` on failure.
  - Delete **all** `products:list:*` keys. Pattern (V1 choice):
    - Preferred portable: keep a small `Set` of known list keys (if app tracks them) or enumerate via `cacheManager.store.keys('products:list:*')` (ioredis `KEYS`) if `store.keys` exists, then `await Promise.all(keys.map(k => cacheManager.del(k)))`.
    - If driver does not expose `keys`, fallback to `await cacheManager.clear()` scoped to cache instance (acceptable because only products are cached globally — documented). Document the chosen strategy in `docs/architecture` and in JSDoc.
  - Mutations covered: `create` (invalidate all lists; no single key to delete for new id but list invalidation ensures appearance), `createMany`, `update` (single+lists), `updateMany` (each id+lists), `remove` (single+lists), `resetAll`/`deleteAll` (clear lists + clear all singles via namespace clear).
  Invalidation MUST happen **after** the DB write in the same call stack, but **outside** any `dataSource.transaction` if one is used (Phase 1.4.1 detail: `updateMany` runs inside `dataSource.transaction`; invalidation occurs after commit, i.e., after `transaction` promise resolves). `create`/`createMany` are not transactional but still invalidate only after `save` succeeds; on exception before save, no invalidation.

- **FR-006**: System MUST be **fail-open on Redis/cache failures** everywhere. Every `cacheManager.get/set/del/keys/clear` is wrapped in `try { ... } catch (e) { this.logger.warn('Cache ... failed for key ...', e.message) }`. Fail-open means:
  - Reads fall back to DB and return `200` with correct data.
  - Writes still commit to DB and return `201/200`; invalidation failure does not rollback or throw, only logged.
  - No `500` is produced by a transient Redis outage for product catalog routes.
  Redis health is checked on bootstrap via existing `CacheTestService` (`SET connection_test_key working 5000`); failure there already logs but does not crash (per `src/cache-test.service.ts:27`).

- **FR-007**: System MUST **never use Redis as authoritative for inventory/reservation/order/cart** and MUST NOT cache `Inventory`, `Reservation`, `Order`, `Cart`, `Inventory.available` or `available >= requestedQty` checks. Required guard:
  - `CartService.addCartItem/increaseQuantity` stock checks MUST call `InventoryService.getInventory(productId)` (DB) per `AGENTS.md` boundaries, never `cacheManager.get`.
  - `ReservationService.create` MUST lock `Inventory FOR UPDATE` and read `stock/reservedAmount` inside the transaction (Phase 3), never from cache.
  - `OrderCheckoutService` and `OrderCompletionService` stock/reserved arithmetic MUST use `Manager.find(Inventory, { lock: pessimistic_write })`, not a cached snapshot.
  - Integration test asserts `cacheManager.get` is never called inside `cart/inventory/reservation/order` paths (spy on `CACHE_MANAGER`).
  - `docs/plan.md` Important Rule violation (`Redis inventory → reservation decision`) is a **P0 regression** must be caught in review.

- **FR-008**: System MUST keep **GraphQL product API surface unchanged** and thin. `ProductsResolver` methods (`createProduct`, `createManyProducts`, `findAll`/`products`, `findOne`/`product`, `updateProduct`, `removeProduct`, `removeAllProducts`) stay thin: input validation via DTO/ `ValidationPipe`, then delegate to `ProductsService` and return its result. No business logic migrates to resolver. Cache logic lives entirely in `ProductsService` (service boundary per `AGENTS.md` Backend Rules). Add class-level `/** This service is responsible for product catalog and product-cache (cache-aside) ... */` and method-level `/** @param @returns @throws */` JSDoc per `AGENTS.md` §3 Documentation rules, plus inline `//` for any non-trivial cache-branch condition (≥2 predicates) — e.g., `// HIT only if cached and not null; null means not found (do not cache negative)`.

- **FR-009**: System MUST provide **DB-backed tests proving cache contract** (per Testing Rules — unit mocked, integration mostly mocked for cache but real PG for product CRUD):
  - **Unit (mocked `Repository<Product>`, mocked `CACHE_MANAGER` as `{ get, set, del, store: { keys } }`, mocked `Logger`, `DataSource` for `updateMany`):**
    - `findAll` first miss populates cache with correct key and TTL, second call hit does not call `findAndCount` (spy).
    - `findAll` with different `page:limit` uses different keys; hit on one does not satisfy the other.
    - `create` invalidates all `products:list:*` (calls `del` with each discovered list key or `clear`), `update` invalidates `product:{id}` + lists, `updateMany` invalidates every `product:{id}` in batch + lists, `remove`+`resetAll` clears appropriately.
    - On mutation failure (duplicate name `409`, `BadRequestException`, `NotFoundException`) cache is **not** invalidated.
    - `cacheManager.get/set/del` throwing → service still succeeds and logs warn (fail-open).
    - `findOne` single cache hit/miss as in Story 3.
    - No inventory caching (spy never calls cache in cart/reservation/order and `productsService` never stores `stock`/`reservedAmount` in cached value).
  - **Integration (real PostgreSQL, `CacheModule` mocked or real Redis when available, `jest --runInBand`):**
    - Real `ProductsService` with real `productsRepo` + mocked `CACHE_MANAGER` (or real `cacheManager` with `FLUSHDB` if Redis reachable). Seed products via `create`/`createMany`; call `findAll` twice → second callspy confirms DB call count 1.
    - Mutate via `update` → next `findAll` miss returns updated name/price.
    - Bulk `updateMany` with 5 products → lists invalidated and follow-up reads reflect bulk changes.
    - Concurrent `findAll` (two simultaneous misses) → both eventually cached and neither throws; at most one extra DB hit is acceptable.
  - **E2E (supertest + GraphQL `supertest`):**
    - `mutation { createProduct(...) } → query { products(page:1,limit:10) }` cached, second identical query hit, `mutation { updateProduct(...) } → query { products(...) }` miss reflects updated price.
    - Optional: `mutation { createManyProducts(...) }` + invalidated.
  - Existing suites must still pass (`npm run test`, `npm run build`).

- **FR-010**: System MUST be **configurable and observable** for caching:
  - New env variables (`.env` + `.env.example`, read via `ConfigService`):
    ```
    PRODUCT_LIST_CACHE_TTL_MS=60000
    PRODUCT_SINGLE_CACHE_TTL_MS=300000
    REDIS_URL=redis://...
    ```
    plus reuse existing `CACHE_MANAGER` `ttl` fallback `60*1000` as default. No hard-coded TTLs.
  - On module init, `Logger.log Product cache TTLs: list=<ms> single=<ms>` + `Logger.log Cache strategy: product catalog only (inventory/reservation/order never cached)`.
  - Metrics/observability (optional but recommended): expose `Cache HIT/MISS` counts via `Logger.debug` (existing) and optionally a `GET /products/cache/stats` (admin) OR a simple in-memory counter `cacheHits/misses` for dashboards — not required V1, but plan records the decision. If added, keep it in `ProductsService` with `getCacheStats()` and `clearCache()` admin helper for operational use.
  - Documentation: update `docs/architecture/products-caching.md` (or extend `docs/architecture/modules.md`) with keys, TTLs, invalidation flow, fail-open rule, and the explicit non-goals (inventory never cached).

---

### Key Entities

- **Product**: `id uuid PK`, `name @Unique`, `slug @Unique`, `description`, `price int CHECK >=0`, `created_at`, `inventory OneToOne`, `orderItems OneToMany`. No `stock` field (stock in `Inventory`). The only type whose rows are cached (`Product` + pagination envelope `{ data, meta }`). Cached payload is a **snapshot** of the DB row at write time; TTL-bounded and evictable.

- **Inventory**: `id uuid PK`, `productId FK→Product CASCADE @Unique`, `stock int CHECK >=0`, `reservedAmount CHECK >=0 CHECK <=stock`, derived `available = stock - reservedAmount`. **Never cached** for business decisions; read exclusively via `InventoryService`/`FOR UPDATE` in transactions. Product caching must never encapsulate `Inventory` rows.

- **ProductCacheEntry (derived, evictable)**: Not a table. In Redis as `CacheManager` store:
  - `product:{id} → Product` (TTL `PRODUCT_SINGLE_CACHE_TTL_MS`).
  - `products:list:{page}:{limit} → { data: Product[], meta: { totalItems, itemCount, itemsPerPage, totalPages, currentPage } }` (TTL `PRODUCT_LIST_CACHE_TTL_MS`).
  Both entries are **loss-tolerant** (may be evicted/expired at any time); correctness never depends on their presence.

- **Cart / CartItem / Reservation / ReservationItem / Order / OrderItem / User**: Existing. Excluded from product caching; their services (`CartService`, `ReservationService`, `OrderCheckoutService`, `OrderCompletionService`) MUST NOT read from product cache for inventory logic. Mentioned in spec only to explicitly scope non-goals.

---

## 4. Success Criteria

### Measurable Outcomes

- **SC-001**: With Redis empty, `findAll({page:1,limit:10})` on 3 seeded products returns `data.length=3 totalItems=3` and populates Redis under `products:list:1:10`. An immediate second identical `findAll` returns an identical payload **without invoking `productsRepo.findAndCount`** (verified by call-count spy) and logs `Cache HIT: products:list:1:10`. Conversely, the first call logged `Cache MISS: products:list:1:10` and set the entry with TTL `PRODUCT_LIST_CACHE_TTL_MS`. (Hit vs miss observable per-request without changing any `Product` between calls.)

- **SC-002**: `products:list:1:10` and `products:list:2:10` (or `1:20`) are isolated: after caching both, a hit for one does not serve the other; mutating any single product invalidates **all** `products:list:*` keys, so the next fetch for **each** distinct pagination is a miss that re-queries and returns the updated `totalItems`/content.

- **SC-003**: After `products:list:1:10` is cached, admin `createProduct({name:"X", price:111})` succeeding deletes every `products:list:*` (verified spy `cacheManager.del` with each list key or `clear` call). Subsequent `products(page:1,limit:10)` is a miss returning `totalItems:4` with product X present. Same holds for `createManyProducts` with 3 inputs (list invalidation once, single keys not needed for new ids but appear on next `findOne` hits).

- **SC-004**: Single-item cache: `findOne(id:known)` first call miss (DB hit, `cacheManager.set product:known` with `PRODUCT_SINGLE_CACHE_TTL_MS`), second call hit (no DB hit). Then `updateProduct(id:known, {price:999})` succeeds → `product:known` deleted and `products:list:*` deleted; next `findOne(id:known)` miss returns `price=999` and next `findAll` misses reflecting the edit.

- **SC-005**: Bulk and delete correctness: `updateMany([{id:a, price:10},{id:b, price:20}])` (5 items) invalidates `product:a`…`product:e` and all lists; next `products(page:1,limit:10)` miss shows bulk prices. `removeProduct(id:abc)` or `removeAllProducts` deletes `product:abc` (and all products for `clearAll`) and all lists; next `product(id:abc)` miss yields `null/404`, next `products` miss yields `data` without the deleted row(s).

- **SC-006**: No spurious invalidation on failure: `createProduct` with duplicate name `409`, `createMany` where all names exist → `400`, `updateMany` with a missing id → `404`, `update` not found → `404`. In each failing mutation case, existing cached `products:list:1:10` and `product:*` remain intact — the next `products`/`product` read **still hits** and returns the previous cached snapshot (no delete called).

- **SC-007**: **Fail-open invariant**: With `cacheManager.get` throwing `ECONNREFUSED`, `findAll` still returns `200` from DB, logs `Cache GET failed for key products:list:1:10: ...`, and does not return `500`. With `cacheManager.set` or `del` throwing during populate/invalidation, the mutation still commits to PostgreSQL (`createProduct` returns `201`) and logs `Cache SET/DEL failed...`; SC-001–SC-005 remain eventual (next read re-attempts cache) but correctness is preserved.

- **SC-008**: **Strict non-caching of inventory/business state**: Code audit shows `cacheManager` is imported only in `ProductsModule`/`ProductsService` (and `CacheTestService`); `CartModule`, `InventoryModule`, `ReservationModule`, `OrderModule` have zero `CACHE_MANAGER` injections. Integration spy confirms calling `findAll`/`findOne` caches product rows only, while `InventoryService.getInventory`/`ReservationService.create` never call `cacheManager.get`. `docs/architecture` records `available = stock - reservedAmount` as always derived from transactional DB, and `EXPLAIN`-style reasoning is not needed (product reads are not locked) but `productsRepo.findAndCount` plan shows no `Inventory` join contamination. `npm run test -- --runInBand` (19 suites) + `npm run build` pass, with 8+ new cache tests covering miss/hit, invalidation, fail-open, and single-item paths.

---

## 5. Assumptions

- **A1**: PostgreSQL is authoritative; Redis + `@nestjs/cache-manager` + `@keyv/redis` + ioredis are cache-only and never authoritative for inventory/reservation/order/payment or any transactional business state (constitution I/III, `AGENTS.md` Architecture). Product caching is a performance layer, not a correctness layer; a cache flush at any time is safe.

- **A2**: Phase 0-8 entities and constraints remain as shipped: `Product` (no `stock`, `@Unique(name/slug)`, price `>=0`), `Inventory` 1-1 with `InventoryService.createForProduct` on product create, `Cart/CartItem` eager `product`, `Reservation/ReservationItem` with `status+expiresAt` composite index, `Order/OrderItem` with checkout-only reservation, `User` with roles. `synchronize:false`, existing migrations intact.

- **A3**: Redis is already provisioned (`docker-compose.yml` `redis:8`, `REDIS_URL` set, `CacheModule.registerAsync` global with `createKeyv(REDIS_URL)` + `ttl:60*1000 ms`, `BullMQ` shares same connection, `CacheTestService` logs `Redis connection successfully verified` on `onModuleInit` but does not crash on failure). Phase 9 does not add a second Redis client; it reuses `CACHE_MANAGER`.

- **A4**: Current `ProductsService.findAll` already caches `products:list:{page}:{limit}` with global TTL `60s` but without single-key caching or any invalidation; `findOne` is not cached at all. Phase 9 retrofits `findOne` caching and adds post-commit invalidation to every mutating method (`create`, `createMany`, `update`, `updateMany`, `remove`, `resetAll`). List filtering/search is still `TODO` (consistent with `findAll` comment), so keys do not include search hash in V1; if search is added, key design extends as `products:list:{page}:{limit}:{hash}`.

- **A5**: TTL defaults are chosen for safety over maximum performance: list `60s`, single `300s`. Tenants may override via env `PRODUCT_LIST_CACHE_TTL_MS`/`PRODUCT_SINGLE_CACHE_TTL_MS`. No per-product or per-page TTL variance in V1.

- **A6**: Invalidation order is **after DB commit** in the same call stack, not inside the DB transaction. `create`/`createMany`/`update`/`remove` are single-save paths; `updateMany` is `dataSource.transaction(... FOR UPDATE ... manager.save ...)`. Invalidation fires **after** the `transaction` promise resolves; if the transaction rolled back, invalidation is skipped.

- **A7**: Cache keyspace collision is avoided by namespace `product:` vs `products:list:` prefixes. Other modules (auth/cart/order/reservation/inventory) do not use these prefixes, so a scoped `clear()` or `keys('products:list:*')` cannot accidentally delete unrelated keys. If `keys()` is unsupported, `clear()` on the `CacheManager` instance is acceptable because the instance is product-only (global, but only products write to it today — reservation worker's `expiration:tick:lock` uses raw `ioredis`/`CacheManager` store `SET NX EX` in its own namespace `expiration:*`, which would be collateral if `clear()` were used; therefore plan MUST prefer selective `keys` + per-key `del` and document why `clear()` is a fallback only).

- **A8**: Authorization stays unchanged: GraphQL mutations (`createProduct`, `createManyProducts`, `updateProduct`, `updateMany`, `removeProduct`) are not yet gated by `RolesGuard` (existing `products.resolver.ts` has no guard); Phase 9 does not tighten or loosen auth (that is Phase 20 RBAC). Caching does not gate reads on role — cached listings are role-agnostic and safe because they contain only `Product` public fields, not user-specific data.

- **A9**: Negative caching is off (missing `product:id` is never stored as `null`). Invalidation of `product:{id}` on delete includes that id; queries for deleted ids stay as DB misses returning `null` until 404 mapping handles them.

- **A10**: Tests use mocked `CACHE_MANAGER` (`jest.fn().mockResolvedValue`) for determinism in unit suites; integration may use real Redis when available via `REDIS_URL` but must still pass when Redis is absent by mocking (same as expiration worker's fail-open). `jest` is `ts-jest` with `--runInBand --forceExit`, existing `transformIgnorePatterns` for `@nestjs/bullmq` ESM already present.

---

## 6. Dependencies

- Phase 0-3 (`Product` entity `create/createMany`/`findAll`/`findOne`/`update`/`updateMany`/`remove` without stock; `synchronize:false`).
- Phase 1 (`Inventory` 1-1 `InventorySeeder`, `InventoryService`, `createForProduct`, `stock/reservedAmount` CHECKs).
- Phase 3 (`products.service.ts:updateMany` `FOR UPDATE` + deterministic ordering — reused as reference for short transaction pattern).
- `CacheModule` global (`@nestjs/cache-manager` + `@keyv/redis` + ioredis) + `BullModule` shared `REDIS_URL` + `CacheTestService` (connection ping). No new infrastructure.
- Global `ValidationPipe` (`whitelist + forbidNonWhitelisted + transform`) + `AllExceptionsFilter` + `Logger` (for `Cache MISS/HIT` and `warn` fail-open).
- Existing `ProductsModule` (`TypeOrmModule.forFeature([Product])`, `forwardRef(InventoryModule)` for `createForProduct`) — cache invalidation will call `InventoryService` already; no circular-cache issue.

---

## 7. Out of Scope (this phase)

- Any inventory, reservation, order, cart, payment, or `available = stock - reservedAmount` caching or pre-check — never. Redis must not influence `available >= requestedQty` decisions (docs/plan.md Important Rule). No `inventory:{productId}`, `reservation:{id}`, `order:{id}` keys.
- Full-text search / filtering / sorting on product listings (`TODO Add search and filters` in `findAll`) — keys will not include search/sort hash in V1; if search reuses `findAll`, it must include a new key variant with hash.
- Write-through or write-behind caching — only cache-aside (lazy populate on miss) and explicit invalidation on write; no sync-on-write to keep cold-start simple.
- Per-row cache warming on boot — not needed; first miss populates.
- Redis persistence, clustering, sentinel, or eviction tuning — ops concern; V1 keeps single-node `redis:8` via `REDIS_URL`.
- Cache statistics UI / Grafana — only `Logger.debug` hit/miss now; `GET /products/cache/stats` admin endpoint is optional future (Phase 20 dashboard), not required to meet Phase 9 exit criteria.
- Rate limiting (`docs/plan.md` Phase 10) — orthogonal; product caching does not throttle reads.
- RabbitMQ/BullMQ fan-out of `product.created/updated/deleted` events (`docs/plan.md` Phase 11) — if chosen, publishing is **after commit** and after invalidation, but not required V1.
- Multi-region cache invalidation, CDN, or HTTP cache headers — out of scope.
- New DB migration for this phase — none expected (cache is external to PostgreSQL). If `synchronize` or index changes are found needed, they are added as separate migrations, but product tables stay unchanged.

---

## 8. Clarifications

### Session 2026-09-22 (Phase 9 kickoff)

- Q: What cache key should identify a paginated listing? → **A: `products:list:{page}:{limit}` with exact numeric `page:limit` from `PaginationArgs`** (matching the existing implementation at `src/modules/products/products.service.ts:158`). Other query params (search/sort) are not yet modeled, so no hash extension V1.

- Q: How long should a product listing stay cached? → **A: List 60s, single 300s** (defended as `PRODUCT_LIST_CACHE_TTL_MS=60_000` + `PRODUCT_SINGLE_CACHE_TTL_MS=300_000`, configurable via `ConfigService`, global `CacheModule` `ttl` `60*1000` kept as fallback). List shorter because it aggregates many rows and goes stale faster; single longer per-row. Min clamp `5s`/`30s`.

- Q: How does every `products:list:*` get invalidated when one product mutates? → **A: Enumerate all `products:list:*` keys via `cacheManager.store.keys('products:list:*')` (ioredis `KEYS`) then `del` each — scoped, selective.** `CACHE_MANAGER.clear()` is fallback only if `keys` unsupported, because global clear would also evict `expiration:tick:lock` etc. if shared instance. Plan documents the chosen strategy.

- Q: Should `findOne` be cached? → **A: Yes, `product:{id}` cached `300s`**, matching `docs/plan.md` example `product:{productId}` and covering `CartItem.product` eager/detail pages. Negative lookups not cached.

- Q: Should Redis downtime break product reads? → **A: Never — fail open** (consistent with `AllExceptionsFilter` + `RateLimitGuard` fail-open via Redis `INCR+EXPIRE` in Phase 5/6). `cacheManager.get/set/del` throwing → `Logger.warn` + fallback to DB, not `500`.

No additional `[NEEDS CLARIFICATION]` markers remain at spec authoring time. If plan research surfaces a search/filter key variant or a single-flight thundering-herd guard, ≤1 focused clarification will be opened and the spec patched.

---

## 9. Acceptance Scenarios (for planning)

1. Cold miss → hit: `FLUSHDB`, `products(page:1,limit:10)` → `MISS` + DB `findAndCount` 1 call + `set products:list:1:10`, second identical call → `HIT` + DB 0 additional calls + deep-equal `data/meta`.
2. List invalidation on create: `products(page:1,limit:10)` cached, `createProduct` ok → lists cleared, next `products` miss `totalItems +1`.
3. Single invalidation on update: `product(id:abc)` cached, `updateProduct(abc)` price `999` → `product:abc` + lists cleared, next `product(abc)` miss `price 999`.
4. Bulk: `updateMany` on 5 ids → 5 singles + all lists cleared, follow-up `products` misses show 5 new prices.
5. Delete: `removeProduct(id:abc)` → `product:abc` + lists cleared, next `products` without abc, next `product(abc)` 404.
6. Fail-open: mocked `cacheManager.get` throw → `products` still `200` from DB, `warn` logged; `cacheManager.del` throw on mutation → mutation `201/200` still succeeds, `warn` logged.
7. Isolation: `products:list:1:10` hit does not serve `products:list:2:10`; after one mutation both miss.
8. Inventory isolation: inventory `getInventory`/`FOR UPDATE` never consults cache (spy 0 calls).

