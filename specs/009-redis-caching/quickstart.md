# Quickstart: Redis / Product Caching (Phase 9)

**Branch**: `009-redis-caching` | **Spec**: [spec.md](./spec.md) | **Plan**: [plan.md](./plan.md)

No new DB migration — `synchronize:false` kept. Only `src/modules/products/products.service.ts` gains cache-aside + post-commit invalidation (fail-open, ConfigService TTLs). 5-minute manual path below mirrors SC-001..008.

## 0. Prerequisites

```bash
git checkout 009-redis-caching
cat .specify/feature.json  # {"feature_directory":"specs/009-redis-caching"}
docker-compose up -d       # postgres, redis:8, rabbitmq:4
docker ps                  # verify redis `mini-e-commerce-redis-1` healthy
.env must have:
  REDIS_URL=redis://127.0.0.1:6379
  PRODUCT_LIST_CACHE_TTL_MS=60000      # optional, default 60s
  PRODUCT_SINGLE_CACHE_TTL_MS=300000   # optional, default 300s
  DATABASE_URL=postgresql://...
  JWT_SECRET=...
```

If `REDIS_URL` unset, app falls back to in-memory cache (logged `warn Redis URL not set`), same flow but not cross-instance — still passes tests.

## 1. Install & Build

```bash
npm ci
npm run lint          # ESLint flat + Prettier (no cache console.log)
npm run build         # nest build — must PASS
```

Logs on boot:

```
[Nest] Product cache TTLs: list=60000 single=300000
[Nest] Cache strategy: product catalog only (inventory/reservation/order never cached)
[Nest] Redis connection successfully verified!  # or error log but no crash (CacheTestService)
```

## 2. Manual — list miss → hit (SC-001)

```bash
# Clear cache
docker exec mini-e-commerce-redis-1 redis-cli FLUSHDB
# OR via app: curl POST /graphql not needed — FLUSHDB is enough

# GraphQL playground or curl — first miss
curl -s http://localhost:3000/graphql -H 'Content-Type: application/json' -d '{"query":"{ products(page:1, limit:10){ data{ id name price } meta{ totalItems totalPages } } }"}' | jq
# logs: Cache MISS: products:list:1:10 ; DB findAndCount called

# Second identical — hit (no DB)
curl -s http://localhost:3000/graphql -H 'Content-Type: application/json' -d '{"query":"{ products(page:1, limit:10){ data{ id name price } meta{ totalItems } } }"}' | jq
# logs: Cache HIT: products:list:1:10 ; same data/meta as above

# Verify Redis key exists
docker exec mini-e-commerce-redis-1 redis-cli KEYS 'products:list:*'
# → products:list:1:10
docker exec mini-e-commerce-redis-1 redis-cli TTL 'products:list:1:10'  # ~60

# Isolation: different pagination is separate key
curl -s http://localhost:3000/graphql -H 'Content-Type: application/json' -d '{"query":"{ products(page:2, limit:10){ data{ id name } meta{ totalItems } } }"}' | jq
docker exec mini-e-commerce-redis-1 redis-cli KEYS 'products:list:*'
# → products:list:1:10  products:list:2:10
```

## 3. Manual — single product miss → hit (SC-004)

```bash
# Pick id from previous products query
PID=<id_from_above>
curl -s http://localhost:3000/graphql -H 'Content-Type: application/json' -d "{\"query\":\"{ product(id:\\\"$PID\\\"){ id name price } }\"}" | jq
# logs: Cache MISS product:<pid>

curl -s http://localhost:3000/graphql -H 'Content-Type: application/json' -d "{\"query\":\"{ product(id:\\\"$PID\\\"){ id name price } }\"}" | jq
# logs: Cache HIT product:<pid> ; same price

docker exec mini-e-commerce-redis-1 redis-cli KEYS 'product:*'
# → product:<pid>
```

## 4. Manual — invalidate on mutation (SC-003..005)

```bash
# Before: cache has products:list:1:10 and product:PID
docker exec mini-e-commerce-redis-1 redis-cli KEYS '*'   # shows both

# createProduct → invalidates all products:list:* (no product:{newId} yet to delete)
curl -s http://localhost:3000/graphql -H 'Content-Type: application/json' -d '{"query":"mutation{ createProduct(createProductInput:{name:\"New Cake 9R-XYZ\", description:\"x\", price:250}){ id name price } }"}' | jq

docker exec mini-e-commerce-redis-1 redis-cli KEYS 'products:list:*'
# → (empty)  (invalidated)

# Next list miss repopulates with new total
curl -s http://localhost:3000/graphql -H 'Content-Type: application/json' -d '{"query":"{ products(page:1, limit:10){ meta{ totalItems } } }"}' | jq
# meta.totalItems +1 vs before

# updateProduct → deletes product:{id} + lists
curl -s http://localhost:3000/graphql -H 'Content-Type: application/json' -d "{\"query\":\"mutation{ updateProduct(id:\\\"$PID\\\", updateProductInput:{price:999}){ id price } }\"}" | jq
docker exec mini-e-commerce-redis-1 redis-cli KEYS '*'  # both namespaces empty again
curl -s http://localhost:3000/graphql -H 'Content-Type: application/json' -d "{\"query\":\"{ product(id:\\\"$PID\\\"){ price } }\"}" | jq
# → price 999 (miss then cached)

# Failure does NOT invalidate (duplicate name → 409)
curl -s http://localhost:3000/graphql -H 'Content-Type: application/json' -d "{\"query\":\"{ products(page:1, limit:10){ meta{ totalItems } } }\"}" | jq
# ensure hit: log Cache HIT
curl -s http://localhost:3000/graphql -H 'Content-Type: application/json' -d '{"query":"mutation{ createProduct(createProductInput:{name:\"New Cake 9R-XYZ\", description:\"x\", price:1}){ id } }"}' | jq
# → GraphQL errors: 409 Product with same name or slug already exist
curl -s http://localhost:3000/graphql -H 'Content-Type: application/json' -d '{"query":"{ products(page:1, limit:10){ meta{ totalItems } } }"}' | jq
# → still HIT (no invalidation on failure)

# delete
curl -s http://localhost:3000/graphql -H 'Content-Type: application/json' -d "{\"query\":\"mutation{ removeProduct(id:\\\"$PID\\\"){ id } }\"}" | jq
docker exec mini-e-commerce-redis-1 redis-cli KEYS 'product:*'  # product:PID gone
curl -s http://localhost:3000/graphql -H 'Content-Type: application/json' -d "{\"query\":\"{ product(id:\\\"$PID\\\"){ id } }\"}" | jq
# → null (404-equivalent, not cached negative)
```

## 5. Manual — inventory isolation (SC-008)

```bash
# grep audit: only ProductsModule + CacheTestService inject CACHE_MANAGER
grep -rn CACHE_MANAGER src/modules/cart src/modules/inventory src/modules/reservation src/modules/order
# → 0 results (expected)

# Cart stock check never uses cache — verify log absence and DB path
# (Phase 1 cart add still uses InventoryService.getInventory DB-only)
```

## 6. Manual — fail-open (SC-007)

Simulate without real Redis outage (unit mocked path):

```bash
# In code: mocked cacheManager.get throws ECONNREFUSED → still 200 from DB
# Manual with real Redis: stop redis then query
docker-compose stop redis
curl -s http://localhost:3000/graphql -H 'Content-Type: application/json' -d '{"query":"{ products(page:1, limit:10){ meta{ totalItems } } }"}' | jq
# → 200 with DB data; logs: warn Cache GET failed for key products:list:1:10: ECONNREFUSED
docker-compose up -d redis
```

## 7. Verify (required gates)

```bash
npm run build
npm run lint
npm run test -- --runInBand          # 19+ suites + 8 new cache tests; no PG required for unit, FLUSHDB for integration
npm run test:e2e  # if PG+Redis available: register → browse products miss→hit → mutate → miss + price isolation
```

All must PASS. `specs/009-redis-caching/checklists/requirements.md` remains green.

