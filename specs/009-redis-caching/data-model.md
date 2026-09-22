# Data Model: Redis / Product Caching (Phase 9)

**Branch**: `009-redis-caching` | **Date**: 2026-09-22 | **Spec**: [spec.md](./spec.md) | **Plan**: [plan.md](./plan.md)

No new PostgreSQL tables or migrations in Phase 9. All entities reuse Phase 1-8 schema; Phase 9 adds a derived, evictable **ProductCacheEntry** (not a table) and a **CacheHelper** ephemeral transaction-scoped invalidation model.

---

## 1. Existing Entities (unchanged schema, new cache behavior)

### 1.1 `Product` (`src/modules/products/entities/product.entity.ts`)

```text
Product
-------
id          uuid PK @PrimaryGeneratedColumn('uuid')
name        varchar @Unique @Index
slug        varchar @Unique @Index
description text nullable
price       int CHECK "price" >= 0
created_at  timestamptz @CreateDateColumn
updated_at  timestamptz @UpdateDateColumn

relations: OneToOne Inventory (inverse), OneToMany OrderItem
constraints: @Unique(['name']), @Unique(['slug']), @Check '"price" >= 0'
indexes: @Index(['name']), @Index(['slug'])
```

**Phase 9 delta**: **Only cached entity**. Single rows cached as `product:{id}` (TTL 300s); paginated envelopes `{data, meta}` cached as `products:list:{page}:{limit}` (TTL 60s). No `stock` field (Phase 1 removed). `Product.price` changes still invalidate caches (FR-005).

### 1.2 `Inventory` (`src/modules/inventory/entities/inventory.entity.ts`)

```text
Inventory
---------
id              uuid PK
productId       uuid FK → Product.id ON DELETE CASCADE @Unique @Index
stock           int CHECK "stock" >= 0
reservedAmount  int CHECK "reservedAmount" >= 0, CHECK "reservedAmount" <= "stock"
available       derived getter `stock - reservedAmount` (not stored mutably)

constraints: @Unique(['productId']), @Check stock>=0, reserved>=0, reserved<=stock
```

**Phase 9 delta**: **Never cached** for business decisions (FR-007/SC-008). All `available = stock - reservedAmount` reads go via `InventoryService.getInventory` / `Manager.find(Inventory, { lock: pessimistic_write })` inside checkout/reservation transactions. Product cache payloads **do not embed** `stock/reservedAmount`.

### 1.3 `Reservation` + `ReservationItem` / `Order` + `OrderItem` / `Cart` + `CartItem` / `User`

Unchanged. **Never cached**. Mentioned only to scope non-goals per spec §7 Out of Scope. Their services (`CartService`, `ReservationService`, `OrderCheckoutService`, `OrderCompletionService`) MUST NOT call `cacheManager.get` (FR-007).

---

## 2. New/Derived Models (not tables)

### 2.1 `ProductCacheEntry` (derived, evictable, in Redis via `CACHE_MANAGER`)

Not a table. Redis `CacheManager` store (`createKeyv(REDIS_URL)` ioredis):

```text
product:{id} → Product
  TTL: PRODUCT_SINGLE_CACHE_TTL_MS (default 300_000 = 300s)
  invalidation: on create/update/remove that touches {id}

products:list:{page}:{limit} → PaginationEnvelope
  envelope: { data: Product[], meta: { totalItems, itemCount, itemsPerPage, totalPages, currentPage } }
  TTL: PRODUCT_LIST_CACHE_TTL_MS (default 60_000 = 60s)
  invalidation: on ANY successful product mutation (all products:list:* deleted)
```

Both entries are **loss-tolerant** (may be evicted/expired at any time); correctness never depends on their presence (A1). Empty `data:[] totalItems:0` envelopes may be cached briefly (optional 30s) after `resetAll` but still loss-tolerant.

Constraints: `@Unique` product `name/slug` still enforced at DB on create/update; cache does not enforce uniqueness. Cache keys MUST use deterministic `product:{id}` / `products:list:{page}:{limit}` (FR-001), documented in `docs/architecture/modules.md`.

### 2.2 `CacheHelper` (ephemeral, in-process, not persisted)

Helper inside `ProductsService` (private methods, not a table). Pseudocode contract:

```text
buildKeyList(page: number, limit: number): string
  // returns "products:list:{page}:{limit}" — uses exact numeric page/limit from PaginationArgs

buildKeySingle(id: string): string
  // returns "product:{id}"

parseTtlMs(raw: string|undefined, fallback: number, min: number): number
  // ConfigService.get('PRODUCT_LIST_CACHE_TTL_MS') → parseInt → NaN/<=min ? fallback + warn : raw ; clamp >= min, log warn

getCachedList(key: string): Promise<PaginationEnvelope|undefined>
  // try { cacheManager.get(key) } catch → warn "Cache GET failed for key X: msg" → undefined (fail-open)

setCachedList(key: string, envelope: PaginationEnvelope): Promise<void>
  // try { cacheManager.set(key, envelope, ttlList) } catch → warn "Cache SET failed ..." (fail-open)

invalidateSingle(id: string): Promise<void>
  // try { cacheManager.del(buildKeySingle(id)) } catch → warn "Cache DEL failed for product:{id}"

invalidateAllLists(): Promise<void>
  // try {
  //   const store = (cacheManager as any).store; // Keyv/ioredis store
  //   if (store?.keys && typeof store.keys === 'function') {
  //     const keys: string[] = await store.keys('products:list:*'); // or cacheManager.store.keys if exposed
  //     await Promise.all(keys.map(k => cacheManager.del(k).catch(e=>warn)));
  //   } else {
  //     await cacheManager.clear(); // fallback only; warn "Fallback clear() invoked, expiration:* collateral"
  //   }
  // } catch → warn "Cache invalidateAllLists failed"

invalidateProductCaches(ids: string[]): Promise<void>
  // await Promise.all(ids.map(invalidateSingle)) + await invalidateAllLists() — after DB commit
```

Invariants enforced: `product:{id}` never stores `null` (negative cache off); `products:list:*` invalidation is **selective** unless fallback; every `get/set/del` fail-open.

### 2.3 `ProductCacheConfig` (env-driven, not a table)

```text
PRODUCT_LIST_CACHE_TTL_MS   string env → number ms, default "60000", clamped >=5000
PRODUCT_SINGLE_CACHE_TTL_MS string env → number ms, default "300000", clamped >=30000
REDIS_URL                   string env, passed to CacheModule registerAsync createKeyv
CACHE_MANAGER ttl           60*1000 fallback (src/app.module.ts:41) — kept as global default, per-entry overrides win
```

All via `ConfigService.get` + `parseInt`, never bare `process.env` inside service (FR-002).

---

## 3. Relationships & Indexes (Phase 9 reuse, no new index)

```text
Product 1──0..1 Inventory (FK productId CASCADE, Unique productId, Index productId) — catalog vs authoritative stock
Product 1──∞ OrderItem (FK productId RESTRICT)
Cache (Redis)  *──1 Product (product:{id} snapshot) — derived, not FK
Cache (Redis)  *──1 PaginationEnvelope (products:list:* snapshot) — derived
```

No new PG index. If `EXPLAIN` for `findAll` shows seq scan, existing `Product.name` index already covers listing order but not pagination; no cache-specific index needed. Keep `synchronize:false`.

---

## 4. Validation Rules (from FRs)

- DTOs `CreateProductInput`/`UpdateProductInput`/`PaginationArgs`: unchanged; `ValidationPipe` `whitelist+forbidNonWhitelisted+transform` → extra fields `400` before cache logic.
- Service: `findAll` key `products:list:{page}:{limit}` uses `PaginationArgs` `page/limit` already coerced; invalid `page<1/limit<1` → `400` before cache get/set.
- `findOne` id must be UUID string; non-UUID → service `NotFound` path without cache.
- TTL config validation: string env → `parseInt` → clamps with `Logger.warn` + fallback.
- `Product.price >=0` CHECK unchanged; cache does not validate price.

---

## 5. State Diagrams

```text
Catalog read (cache-aside, no lock):
  Request products(page,limit) ──get products:list:p:l──▶ HIT? → return cached → done
                                      │
                                      └─MISS → findAndCount(skip=(p-1)*l) → build envelope → set products:list:p:l TTL 60s → return

Product detail read:
  Request product(id) ──get product:id──▶ HIT? → return cached → done
                                  │
                                  └─MISS → findOne(id) → if null → return null (no set)
                                           if Product → set product:id TTL 300s → return

Mutation (after commit, outside tx):
  create/update/remove → save/delete Product → on success
       ├─ del product:{id} (each affected id)
       └─ keys(products:list:*) → del each  (or fallback clear())
   No invalidation on exception (duplicate 409, validation 400, missing 404)
```

---

## 6. No Migration

Phase 9 requires **0 migrations**. If future Phase 20 adds `User.role` enum values, that migration is separate. Keep `synchronize:false`.

```

