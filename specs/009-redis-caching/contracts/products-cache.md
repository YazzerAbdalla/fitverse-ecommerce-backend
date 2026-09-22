# Contract: Products Cache (Phase 9)

**Branch**: `009-redis-caching` | **Spec**: [spec.md](../spec.md) | **Plan**: [plan.md](../plan.md)

GraphQL products catalog is **cached products-only** (cache-aside). No REST `products` endpoint exists; caching is invisible to the caller except via latency logs. Inventory/Reservation/Order/Cart are never cached.

## GraphQL Surface (unchanged)

```graphql
type Query {
  products(page: Int, limit: Int): ProductPagination!  # paginated, cached products:list:{page}:{limit} TTL 60s
  product(id: ID!): Product                           # cached product:{id} TTL 300s, no negative cache
}

type Mutation {
  createProduct(createProductInput: CreateProductInput!): Product!
  createManyProducts(createProductInputs: [CreateProductInput!]!): [Product!]!
  updateProduct(id: ID!, updateProductInput: UpdateProductInput!): Product!
  # updateMany, removeProduct, removeAllProducts — via ProductsService direct (no GraphQL alias changes)
}

type Product { id: ID!, name: String!, slug: String!, description: String, price: Int! }
type ProductPagination { data: [Product!]!, meta: PaginationMeta! }
type PaginationMeta { totalItems: Int!, itemCount: Int!, itemsPerPage: Int!, totalPages: Int!, currentPage: Int! }
```

All `products` queries delegate to `ProductsService.findAll(PaginationArgs)`; all `product` queries to `findOne(id)`; all mutations to respective `create/update/remove` — thin resolver per FR-008 (no business logic moved).

## Cache Contract

### Keys

```
product:{productId}           e.g. product:3f7c9d1a-...
products:list:{page}:{limit}  e.g. products:list:1:10
namespace for bulk delete: products:list:*
optional future: products:list:{page}:{limit}:{searchHash}
```

### TTLs (env via ConfigService, per-entry override)

```
PRODUCT_LIST_CACHE_TTL_MS    default 60000  (60s)  clamped >=5000
PRODUCT_SINGLE_CACHE_TTL_MS  default 300000 (300s) clamped >=30000
CacheModule global fallback  60*1000 (src/app.module.ts:41)
```

### Read Behavior (cache-aside, fail-open)

1. `products(page:1,limit:10)`: `get products:list:1:10` try/catch. HIT → `Logger.debug "Cache HIT: products:list:1:10"` + return cached envelope immediately (no DB). MISS or `get` threw → `Logger.debug "Cache MISS: products:list:1:10"` (or `warn "Cache GET failed for key products:list:1:10: <msg>"`) → `productsRepo.findAndCount({ take:limit, skip:(page-1)*limit })` → build `{data, meta}` → `set products:list:1:10 envelope TTL 60s` try/catch (`warn "Cache SET failed ..."`) → return. Same for `product(id)` with `product:{id}` + `findOne` + `set 300s` only if found.
2. Different paginations isolated: `products:list:1:10` hit does not serve `products:list:2:10`.
3. TTL expiry re-misses and repopulates.

### Invalidation (after DB commit, outside transaction, never on failure)

- `createProduct` success → `store.keys('products:list:*')→del each` (or `clear()` fallback) → next `products` miss.
- `createManyProducts` success → same (lists only).
- `updateProduct(id)` success → `del product:{id}` + lists.
- `updateMany(ids[])` success (committed `dataSource.transaction FOR UPDATE`) → `del product:{id}` per id + lists.
- `removeProduct(id)` success → `del product:{id}` + lists.
- `removeAllProducts`/`resetAll` success → all `product:{id}` + lists via namespace clear.
- On `409` duplicate name/slug, `400` all names exist, `404` missing id, or any exception before `save/delete` — **no invalidation**; next reads still hit prior cache.
- Every `del/keys/clear` is `try/catch` `Logger.warn "Cache DEL/keys/clear failed ..."` (fail-open); mutation still `201/200`.

### Fail-open Guarantees

- `cacheManager.get` throws `ECONNREFUSED` → `products` still `200` from DB + `warn Cache GET failed...` (SC-007).
- `cacheManager.set/del` throws → mutation still commits `201/200` + `warn Cache SET/DEL failed...`.
- `REDIS_URL` unset → in-memory fallback (`createKeyv(undefined)`) + `warn Redis URL not set, using in-memory cache`.
- `CacheTestService` `SET connection_test_key working 5000` failure logs `error` but does not crash.

### Non-goals (never cached)

- `inventory:{productId}`, `reservation:{id}`, `order:{id}`, `cart:{id}`, `available = stock - reservedAmount`, `Order.total`/`OrderItem.unit_price` hist snapshot — never stored in Redis for decisions (FR-007). Audit: `CACHE_MANAGER` only in `ProductsModule`/`CacheTestService`.

### Observability

- Per-request `Logger.debug "Cache HIT: <key>"` / `"Cache MISS: <key>"` (existing).
- `Logger.warn "Cache GET/SET/DEL/keys/clear failed for key <key>: <msg>"` on throw.
- Init `Logger.log "Product cache TTLs: list=<ms> single=<ms>"` + `"Cache strategy: product catalog only (inventory/reservation/order never cached)"`.

### Test Contract Mapping (FR-009)

- Unit (mocked `CACHE_MANAGER`): miss→set with correct key/TTL, second call hit no `findAndCount`, paginated isolation, mutation failure no del, throw still 200, single hit/miss, no inventory key.
- Integration (real PG + mocked/real cache `FLUSHDB`): `findAll` twice DB count 1, `update` → next miss `price 999`, `updateMany` 5→5 singles+lists cleared, concurrent `findAll` no throw.
- E2E (GraphQL `supertest`): `mutation createProduct → query products` cached → second same `products` hit → `mutation updateProduct → query products` miss.

### Errors (inherits existing)

- `400` invalid `page<1/limit<1` (PaginationArgs validation), `404` product not found (no cache), `409` duplicate name/slug, `500` unexpected only — cache never maps to `500`.

