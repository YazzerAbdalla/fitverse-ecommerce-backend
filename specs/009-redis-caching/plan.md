# Implementation Plan: Redis / Product Caching (Phase 9)

**Branch**: `009-redis-caching` | **Date**: 2026-09-22 | **Spec**: [spec.md](./spec.md)
**Input**: Feature specification from `/specs/009-redis-caching/spec.md` (Phase 9 — `docs/plan.md` §9 + 5 clarifications Session 2026-09-22: Q1 key `products:list:{page}:{limit}`, Q2 TTL list 60s single 300s, Q3 selective `keys(products:list:*)→del` vs `clear()` fallback, Q4 `product:{id}` cached no negative, Q5 fail-open)

## Summary

Harden the existing partially-cached catalog: `ProductsService.findAll` already does cache-aside `products:list:{page}:{limit}` (global TTL 60s) but has **no `product:{id}` single cache and no invalidation** on `create`/`createMany`/`update`/`updateMany`/`remove`/`resetAll`. Phase 9 V1 adds **products-only** cache-aside for both `findAll` and `findOne` (`product:{id}` 300s), **post-commit selective invalidation** (all `products:list:*` + affected `product:{id}` via `store.keys`→`del`, `clear()` only as fallback), **TTL config via `ConfigService`** (`PRODUCT_LIST_CACHE_TTL_MS` 60k / `PRODUCT_SINGLE_CACHE_TTL_MS` 300k clamped), and **fail-open** on every `get/set/del` (log `warn`, fallback to DB). No new tables/migrations; inventory/reservation/order/cart are **never cached** (constitution I/IV). Exit verified by real-Redis-or-mocked unit/integration hit/miss + invalidation + fail-open tests (`npm run test -- --runInBand`, `npm run build`).

## Technical Context

**Language/Version**: TypeScript 5.7.3 / Node 20, NestJS 11  
**Primary Dependencies**: `@nestjs/cache-manager` 3.1.3 + `@keyv/redis` 5.1.6 + `ioredis` 5.11 + `cache-manager` 7.2, `@nestjs/typeorm` 11 + `typeorm` 1.1 + `pg` 8.22, `@nestjs/graphql` 13 + `ApolloDriver`, `class-validator`/`class-transformer`, `Jest`+`ts-jest`+`supertest`. No new dependency required (Redis already via `CacheModule` global + BullMQ shared `REDIS_URL`).  
**Storage**: PostgreSQL 17 via TypeORM (authoritative; `synchronize:false`; **no new migration** — reuses `Product` table `@Unique name/slug`, `Inventory` 1-1). Redis 8 via `@nestjs/cache-manager` `createKeyv(REDIS_URL)` (ephemeral, loss-tolerant) — only `Product` rows + `{data,meta}` envelopes stored (`product:{id}` / `products:list:{page}:{limit}`). RabbitMQ 4 not used by cache path.  
**Testing**: Jest unit (mocked `CACHE_MANAGER` `{get,set,del,store:{keys}}` + `Logger` + `Repository<Product>` + `DataSource` for `updateMany`) + integration (real PostgreSQL `productsRepo` + mocked or real `cacheManager` `FLUSHDB`, `--runInBand`, hit/miss spy counts, invalidation, fail-open throw) + E2E `supertest` GraphQL `products`/`product` hit→mutate→miss; `npm run test`, `npm run build`, `npm run lint`.  
**Target Platform**: Linux server (NestJS HTTP + GraphQL via `docker-compose.yml`: postgres, redis, rabbitmq) — same as Phases 1-8, no frontend.  
**Project Type**: Modular monolithic backend — GraphQL `products` (`findAll`/`findOne` cached) + thin `ProductsResolver` (no business logic); `ProductsService` owns cache-aside.  
**Performance Goals**: Cached `findAll` hit avoids `findAndCount` (DB offload) and logs `Cache HIT` with p95 << DB 100ms (no hard SLA; verified by spy “no second DB call”). List TTL 60s (short, many rows stale fast), single 300s (longer per row); invalidation after commit <100ms best-effort. Thundering-herd duplicate `findAndCount` tolerated (last write wins).  
**Constraints**: `synchronize:false`; PostgreSQL authoritative (constitution I); cross-module via services only (V — `ProductsModule` `forwardRef(InventoryModule)` kept); `ValidationPipe` `whitelist+forbidNonWhitelisted+transform` + `AllExceptionsFilter` + `Logger` remain; invalidation **after DB commit**, outside `dataSource.transaction`; `CACHE_MANAGER` only in `ProductsModule` (+ `CacheTestService`), never in `cart/inventory/reservation/order`; `available = stock - reservedAmount` never derived from cache.  
**Scale/Scope**: Touches `src/modules/products/` only (`products.service.ts` cache-aside + invalidation helper, `products.module.ts` `ConfigService` TTL wiring, optional `products.cache.ts` helper); `src/app.module.ts` `CacheModule` `ttl` fallback `60*1000` kept; 0 new PG tables, 0 new queues; 8 SCs map to 8+ cache tests.

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-check after Phase 1 design.*

| Principle | Status | Evidence |
|-----------|--------|----------|
| **I. PostgreSQL is source of truth** | ✅ PASS | Cache is **derived, evictable** `Product` snapshot only; miss always reads `productsRepo.findOne/findAndCount`; availability `InventoryService.getInventory` / `FOR UPDATE` never consults cache (FR-007). Invalidation after commit, never inside tx; Redis `FLUSHDB` at any time safe, per A1/A3. |
| **II. Modular monolith — no premature microservices** | ✅ PASS | Augments single Nest process `ProductsService`; no new service/process, `ProductsModule` still `TypeOrmModule.forFeature([Product])` + `forwardRef(InventoryModule)` only. |
| **III. Inventory/Reservation separate domains, explicit lifecycle** | ✅ PASS | No new inventory state; `Product` has no `stock` field (Phase 1). Cache never encapsulates `stock/reservedAmount/available`; `available` stays getter `stock - reservedAmount` in `Inventory` entity (FR-007). |
| **IV. Concurrency safety at DB level (no overselling)** | ✅ PASS | Product caching does **not** replace inventory locking; `ReservationService.create` / `OrderCheckout/Completion` still `lock pessimistic_write` on `Inventory` inside `dataSource.transaction`. Product read path has no lock (correct — catalog reads are not transactional). No thundering-herd single-flight needed V1 (last write wins, FR-006 edge case). |
| **V. Module boundaries, service-only collaboration** | ✅ PASS | `CACHE_MANAGER` injected only in `ProductsService` (and existing `CacheTestService`); `Cart/Inventory/Reservation/Order` have zero `CACHE_MANAGER` injections (SC-008 audit). `ProductsResolver` stays thin (FR-008), service owns cache logic; no cross-module `@InjectRepository`. |
| **VI. Spec-driven development** | ✅ PASS | Spec `spec.md` + 5 clarifications Session 2026-09-22 (Q1 keys, Q2 TTLs, Q3 keys→del vs clear, Q4 single, Q5 fail-open) done before plan; no future phase (rate limiting Phase 10, async Phase 11) implemented; invalidation contract specified before coding. |
| **VII. Tests mandatory, DB-backed for consistency** | ✅ PASS | Real-PG integration required for `findAll`/`findOne` hit/miss counts + `create`/`update`/`updateMany`/`remove` invalidation (FR-009); unit mocks `CACHE_MANAGER` fail-open throw; cache tests never replace inventory concurrency tests. |
| **VIII. No invented APIs/payments/business rules** | ✅ PASS | No new routes: `products`/`product`/`createProduct`/`createManyProducts`/`updateProduct`/`removeProduct` unchanged contract; only `product:{id}` + list TTL internal. No `inventory:{id}`/`reservation:{id}` keys, no HTTP cache headers, no `GET /products/cache/stats` required V1 (optional). Empty-result 30s cache is explicit assumption not new query. |
| **IX. Documentation is part of work** | ✅ PASS | This plan + `research.md`, `data-model.md`, `contracts/`, `quickstart.md` under `specs/009-redis-caching/`; `AGENTS.md` marker updated to this plan; `docs/architecture/modules.md` or `docs/architecture/products-caching.md` updated; no ADR edit required beyond caching doc. |

**Gate result**: **PASS** — no violations. Post-design re-check (after Phase 1) below remains **PASS** (decisions D1-D6 preserve same invariants, no inventory cache).

## Project Structure

### Documentation (this feature)

```text
specs/009-redis-caching/
├── plan.md              # This file (/speckit.plan command output)
├── research.md          # Phase 0 output — decisions D1-D6, riesgos, TTL tradeoffs, keys→del vs clear
├── data-model.md        # Phase 1 output — Product (cached) vs Inventory (never cached), ProductCacheEntry, CacheTransaction helper
├── quickstart.md        # Phase 1 output — setup .env REDIS_URL, docker-compose up -d, manual hit→mutate→miss + fail-open verification
├── contracts/
│   └── products-cache.md        # Phase 1 output — GraphQL products/product cached contract (keys, TTLs, hit/miss logs, invalidation guarantees)
├── checklists/
│   └── requirements.md  # Spec quality checklist (pre-existing, all pass after 5 clarifies)
└── tasks.md             # Phase 2 output (/speckit.tasks — NOT created by /speckit.plan)
```

### Source Code (repository root)

```text
src/
├── modules/
│   ├── products/
│   │   ├── entities/
│   │   │   └── product.entity.ts              # unchanged (id, name @Unique, slug, description, price CHECK >=0, no stock)
│   │   ├── dto/
│   │   │   ├── create-product.input.ts        # unchanged
│   │   │   ├── update-product.input.ts        # unchanged
│   │   │   └── pagination.dto.ts              # unchanged (page, limit → skip)
│   │   ├── products.service.ts                # MODIFY — cache-aside findAll (products:list:{page}:{limit} 60s) + findOne (product:{id} 300s) + post-commit invalidate helper (keys(products:list:*)→del, product:{id}), fail-open try/catch, ConfigService TTLs, Logger.debug HIT/MISS, JSDoc + // hit guard comments
│   │   ├── products.resolver.ts               # unchanged (thin — parse input, call service, return; no cache logic)
│   │   ├── products.module.ts                 # MODIFY — inject ConfigService alongside CACHE_MANAGER for TTLs (if not already via CacheModule registerAsync), keep TypeOrmModule.forFeature([Product]) + forwardRef(InventoryModule), exports ProductsService
│   │   └── products.service.spec.ts           # MODIFY — extend unit tests (mock CACHE_MANAGER get/set/del/store.keys) for miss→hit, isolation, invalidation, fail-open, single
│   └── inventory/
│       └── entities/inventory.entity.ts       # unchanged (stock/reservedAmount/available, CHECKs) — never cached
│   ├── cart/
│   ├── reservation/
│   └── order/                                 # unchanged — checkout/completion still FOR UPDATE Inventory, never cache
├── app.module.ts                              # unchanged — CacheModule.registerAsync global ttl 60*1000 kept; PRODUCT_LIST/SINGLE TTLs read per-entry from ConfigService in ProductsService, not here
├── cache-test.service.ts                      # unchanged — onModuleInit SET connection_test_key 5000, log verified/failed but no crash
├── data-source.ts                             # unchanged (synchronize:false)
├── .env/.env.example                          # MODIFY — add PRODUCT_LIST_CACHE_TTL_MS=60000, PRODUCT_SINGLE_CACHE_TTL_MS=300000, REDIS_URL (already), document defaults & clamp minima
└── docs/architecture/
    └── modules.md or products-caching.md      # MODIFY — keys, TTLs, cache-aside flow, after-commit invalidation, fail-open, inventory never cached

```

**Structure Decision**: Single project (Option 1) — augment existing `src/modules/products/` `ProductsService` with cache-aside + selective invalidation; no new top-level module, no PG migration, no queue — consistent with `AGENTS.md` Module boundaries and Phase 3 `updateMany` transaction pattern.

## Complexity Tracking

> Fill ONLY if Constitution Check has violations that must be justified

| Violation | Why Needed | Simpler Alternative Rejected Because |
|-----------|------------|-------------------------------------|
| — | — | — |

*No violations — all gates PASS. No new API/state/cache beyond products.*

---

## Phase 0: Research (completed → research.md)

All `NEEDS CLARIFICATION` resolved (0 in Technical Context; 5 business clarifications in spec Session 2026-09-22). Key decisions: D1 keys `products:list:{page}:{limit}` vs `product:{id}` (docs/plan.md pattern), D2 TTL 60s/300s via ConfigService + clamp, D3 selective `store.keys→del` vs `clear()` fallback (expiration:tick:lock collateral), D4 single cached vs negative off, D5 fail-open every get/set/del, D6 after-commit invalidation outside tx. See `research.md` for rationale and alternatives.

## Phase 1: Design (completed)

- **Data model** → [data-model.md](./data-model.md): `Product` (only cached type) vs `Inventory` (never cached), `ProductCacheEntry` derived (list envelope + single), `CacheHelper` ephemeral (`buildKeyList`/`buildKeySingle`/`parseTtl`/`invalidateAllLists`/`invalidateSingle`).
- **Contracts** → [contracts/products-cache.md](./contracts/products-cache.md): GraphQL `products(page,limit)`/`product(id)` cache contract (keys, TTLs, HIT/MISS logs, fail-open 200, post-commit invalidation guarantees, SC-001..008 mapping).
- **Quickstart** → [quickstart.md](./quickstart.md): Env no Redis fallback in-memory, `docker-compose up -d`, manual curl `products` miss→hit→mutate→miss, single product miss→hit, `FLUSHDB`, Redis-down fail-open, `npm run test -- --runInBand` + `npm run build`.
- **Agent context** → `AGENTS.md` marker `<!-- SPECKIT START -->` … `<!-- SPECKIT END -->` updated to point to this plan (`specs/009-redis-caching/plan.md`).

### Agent context update

`AGENTS.md` marker updated via `setup-plan.ps1` + manual correction to this plan (step 3 of `/speckit.plan`). Verify with `grep -n SPECKIT AGENTS.md`.

## Re-evaluated Constitution Check (post-design)

No new code or decisions introduced in Phase 1 that would violate principles. Post-design gate remains **PASS** on all nine principles (same table as above). Completion reuses checkout-only reservation refactor and improves constitution I (cache remains read-only, inventory never cached).

## Next Steps (Phase 2 — not in this command)

`/speckit.tasks` will break Phase 9 into ordered tasks (e.g.: 1) failing unit `findAll` miss→hit + isolation `products:list:1:10` vs `2:10`; 2) failing `findOne` `product:{id}` miss→hit + no negative cache; 3) failing fail-open mocked throw → still 200 + warn; 4) implement `findAll` cache-aside (key `products:list:{page}:{limit}` + TTL 60s + try/catch) + `findOne` (300s); 5) failing invalidation on `create`/`update`/`remove` (all `products:list:*` + `product:{id}`); 6) implement post-commit helper `invalidateProductCaches(ids[])` with `store.keys(products:list:*)→del` selective + `clear()` fallback; 7) wire `ConfigService` TTLs + clamp + `Logger.log` on init + docs; 8) integration `FLUSHDB` miss→hit + mutate→miss + `updateMany` 5 invalidates + `npm run lint/build/test -- --runInBand` + GraphQL E2E).
