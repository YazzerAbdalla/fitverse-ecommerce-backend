# Research: Cache Constraints Indexes

**Branch**: `020-cache-constraints-indexes` | **Date**: 2026-10-09
All Technical Context unknowns resolved from repo evidence; no external research needed.

## D1. `clear()` replacement: selective delete + version-stamp fallback

- **Decision**: Delete both `cacheManager.clear()` paths (`products.service.ts:197-201` in `invalidateAllLists`, `:607-614` in `resetAll`). Primary path stays `store.keys('products:list:*') → del` + `del product:{id}`. When `store.keys` is unavailable, use a version stamp: `GET/INCR products:cache-version`, list keys become `products:list:v{version}:{page}:{limit}`; invalidation = `INCR` version (old entries expire via TTL). No path flushes the store.
- **Rationale**: Shared Redis holds `rl:*` (throttling), `expiration:tick:lock` + poison, `notification:processed:*` + dedup, resend cooldowns. A flush silently disables rate limiting, expiry single-winner, and idempotency (REFACTOR_PLAN CACHE-1a, spec SC-002).
- **Alternatives considered**: Separate Redis DB for product cache — rejected (infra/compose change, out of demo scope); keep `clear()` with warn — rejected (warn does not prevent the correctness incident).

## D2. Cache-key shape: keep, plus completeness test

- **Decision**: Keep `products:list:{page}:{limit}` and `product:{id}`. `findAll` today accepts only `{page, limit}`, so current keys are already complete for current params. Add a unit test asserting every `findAll` input participates in the key — future filter/sort params fail the test until the key extends (enforces spec FR-004 by construction).
- **Rationale**: Full key redesign (hashed normalized-query keys) is spec-deferred post-demo; no query params exist to include.
- **Alternatives considered**: Hashed full-query keys now — rejected (premature; zero params to normalize).

## D3. TTL unit pinned to milliseconds

- **Decision**: ms. Evidence: `cache-manager` v6 + `@keyv/redis` accept ms (`notifications.worker.ts:123` comments "cache-manager ttl in ms"; `otp.store.ts`/`rate-limit.guard.ts` pass `ttlMs`); `CacheModule` `ttl: 60*1000` (`app.module.ts:45`) and service `set(key, v, ttl)` with `60_000/300_000` (`products.service.ts:423-425,466-468`) are consistent ms. Document defaults (list 60_000, single 300_000) in contract; existing `parseTtlMs` warn-on-fallback stays.
- **Rationale**: Resolves REFACTOR_PLAN CACHE-1b ms-vs-s ambiguity without changing values.
- **Alternatives considered**: Seconds — rejected (would halve/1000x existing effective TTLs; breaking-config decision, out of scope).

## D4. Deterministic list order

- **Decision**: `findAndCount({ order: { created_at: 'ASC', id: 'ASC' } })`. `created_at` exists on `Product`; `id` breaks ties.
- **Rationale**: Unordered pagination shifts rows between miss/hit and across pages; stable order is required for SC-001. `id`-tiebreak keeps it total.
- **Alternatives considered**: `ORDER BY id` only — rejected (creation-time order is the least surprising demo default); no order — rejected (current defect).

## D5. Singleflight: deferred

- **Decision**: No coalescing (clarified 2026-10-09). Concurrent cold-cache identical requests each load the source; both succeed.
- **Rationale**: 0.5-day budget; cross-instance coordination is new infra, in-process-only guard has marginal value.
- **Alternatives considered**: In-process promise map — rejected for this slice (kept as post-demo option with key redesign).

## D6. Constraint backstops: audit-first, known gap `Product.price`

- **Decision**: Audit live/dev data for violations before writing the migration. Known DDL regardless of audit: `@Check('"price" >= 0')` on `Product` (`product.entity.ts:37-39` bare column today). Already-covered (no DDL): `Inventory` triple-check + uniques, `ReservationItem.quantity > 0` + uniques, `Order.total >= 0`, `OrderItem.quantity/unit_price` checks + uniques (verified via entity grep 2026-10-09).
- **Rationale**: A `CHECK` on a table with violating rows fails migration; audit-first (clarified 2026-10-09) makes the migration safe.
- **Alternatives considered**: Unconditional strict add — rejected (migration-failure risk); non-validated constraints — rejected (PG `NOT VALID` then validate adds steps for zero demo benefit).

## D7. Index audit: ≤3, evidence-gated

- **Decision**: Audit with `EXPLAIN` on: expiry scan (`status+expiresAt` — already indexed, re-proof), order-by-user, inventory-by-product, order-items-by-order (all indexed — re-proof), order-by-createdAt range (likely **missing** — prime candidate for revenue/date-range reads). Add ≤3 only with observed-pattern evidence; record each with its `EXPLAIN` in `data-model.md` §Audit.
- **Rationale**: `docs/plan.md` Phase 13 forbids blind indexes; spec FR-010/SC-004 cap at 3.
- **Alternatives considered**: Pre-picking the 3 without audit — rejected (would violate the plan's verify-query-patterns rule).

## D8. Test strategy

- **Decision**: Extend unit `products.service.spec.ts` (mocked `CACHE_MANAGER` matrix exists: T009/T024/T028-T031) with key-completeness, no-`clear()`, order-passthrough, TTL-warn tests. New real-Redis `products-cache.integration.spec.ts` (namespace-preservation + live miss/hit/invalidation). Real-PG constraint-rejection + `EXPLAIN` suites. Never-authoritative proof across warm/cold/down.
- **Rationale**: Constitution VII — consistency-affecting behavior proved on real PG; cache shares a store with correctness-critical keys, so real-Redis proof required.
- **Alternatives considered**: Mocked-only — rejected (cannot prove namespace preservation or `EXPLAIN`).
