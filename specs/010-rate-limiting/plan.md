# Implementation Plan: Rate Limiting / Distributed Throttling (Phase 10)

**Branch**: `010-rate-limiting` | **Date**: 2026-09-22 | **Spec**: [spec.md](./spec.md)
**Input**: Feature specification from `/specs/010-rate-limiting/spec.md` (Phase 10 — `docs/plan.md` §10 + 5 clarifications Session 2026-09-22: Q1 protected set & limits auth 5-20/h + checkout/complete 10/h/user + cart 60/h/user + product 30/h/admin, Q2 distributed Yes via shared `CACHE_MANAGER` `REDIS_URL`, Q3 `cache.get→count+1→set` tolerated race vs `INCR+EXPIRE` atomic tighten, Q4 fail-open never break, Q5 inventory never inside guard)

## Summary

Generalize the existing `RateLimitGuard` (Phase 5 `005-auth-upgrades` ships `forgot 5/3`, `reset/validate 10`, `otp 5/phone+10/IP`, `google 20`, `login/register 10` with `Retry-After`+`X-RateLimit-*` fail-open) to every abuse-prone write: **checkout** (`POST /order/checkout` 10/h per user), **order completion** (`POST/PATCH /order/:id/complete` 10/h per user), **cart writes** (`POST /cart` + `PATCH increase/decrease` + `DELETE` 60/h per user), and **admin product mutations** (GraphQL `createProduct/updateProduct/etc` 30/h per admin). Keep the **same Redis infra** (`CacheModule` global `createKeyv(REDIS_URL)` + `BullMQ` shared connection, `CacheTestService` ping) for **distributed counters** (`rl:{METHOD} {PATH}:{DIM}:{VALUE}`), keep **fail-open** on every `get/set` (log `warn`, allow), and keep **guard outermost before `DataSource.transaction`** so throttling never holds inventory `FOR UPDATE`. No new tables/migrations; limits configurable via `ConfigService` env `*_RL_MAX/_WINDOW_MS`, clamped.

## Technical Context

**Language/Version**: TypeScript 5.7.3 / Node 20, NestJS 11  
**Primary Dependencies**: `@nestjs/cache-manager` 3.1.3 + `@keyv/redis` 5.1.6 + `ioredis` 5.11 + `cache-manager` 7.2, `@nestjs/config` + `ConfigService`, `@nestjs/passport` + `passport-jwt` + `bcrypt`, `@nestjs/typeorm` 11 + `typeorm` 1.1 + `pg` 8.22, `@nestjs/graphql` 13 + `ApolloDriver` (GraphQL product mutations), `class-validator`/`class-transformer`, `Jest`+`ts-jest`+`supertest`. No new dependency (reuse `CACHE_MANAGER` global).  
**Storage**: PostgreSQL 17 via TypeORM (authoritative; `synchronize:false`; **no new migration** — counters ephemeral in Redis only). Redis 8 via `@nestjs/cache-manager` `createKeyv(REDIS_URL)` (ephemeral, loss-tolerant) — only `rl:*` counter keys `rl:{METHOD} {PATH}:{DIM}:{VALUE} → count` with TTL `windowMs`; RabbitMQ 4 not used by limit path.  
**Testing**: Jest unit (mocked `CACHE_MANAGER` `{get,set}` + `Logger` + `ConfigService` + `ExecutionContext` `req.route.path`/`req.method`/`req.ip`/`req.headers`/`req.body`/`req.user`/`res.setHeader` per FR-009) + integration (real Redis `FLUSHDB` or shared Map via same `Cache` provider, `--runInBand`, shared-counter two-instance test, Redis-down throw) + E2E `supertest` `POST /auth/login x11` + `POST /order/checkout x11` + `POST /cart x61` + `GET /cart` still `200`; `npm run test`, `npm run build`, `npm run lint`, `npm run test:e2e`.  
**Target Platform**: Linux server (NestJS HTTP + GraphQL via `docker-compose.yml`: postgres, redis, rabbitmq) — same as Phases 1-9, no frontend.  
**Project Type**: Modular monolithic backend — REST `auth`/`order`/`cart`/`inventory` + GraphQL `products`; `RateLimitGuard` shared guard.  
**Performance Goals**: Guard `canActivate` p95 <5ms Redis `get+set` (no DB), distributed counter visible cross-instance within window, throttle check before any `dataSource.transaction`/`FOR UPDATE` so lock hold time unchanged; 429 body `{statusCode:429, message, timestamp}` with `Retry-After`+`X-RateLimit-*` headers per 0011 B1. Tolerance: concurrent burst race on last permit may allow 11th (`get+set` non-atomic) — allowed, see D1.  
**Constraints**: `synchronize:false`; PostgreSQL authoritative (constitution I); guard **per-route** not global `APP_GUARD` (FR-001), `ValidationPipe` `whitelist+forbidNonWhitelisted+transform` + `AllExceptionsFilter` + `Logger` remain; fail-open on every Redis error (FR-005/SC-005); headers `Retry-After = windowMs/1000` (FR-006); `x-forwarded-for` first-value trimmed → `ip` (FR-004); `available = stock - reservedAmount` never derived from Redis, checkout/complete `FOR UPDATE` stays untouched.  
**Scale/Scope**: Touches `src/modules/auth/guards/rate-limit.guard.ts` (extend `LIMITS` + helpers), `src/modules/auth/auth.module.ts` (export guard), `src/modules/order/order.controller.ts` (add `UseGuards(RateLimitGuard)` to checkout/complete), `src/modules/cart/cart.controller.ts` (add to cart writes), `src/modules/products/products.resolver.ts` (add per-admin guard or service-level check), optional `src/modules/inventory/inventory.controller.ts` (Admin increase/decrease), `src/app.module.ts` `CacheModule` unchanged, `.env`/`.env.example` new `*_RL_MAX/_WINDOW_MS`; 0 new PG tables, 0 new queues; 8 SCs map to 8+ throttling tests.

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-check after Phase 1 design.*

| Principle | Status | Evidence |
|-----------|--------|----------|
| **I. PostgreSQL is source of truth** | ✅ PASS | Counters are **derived, evictable** Redis `rl:*` only; miss/Redis-down falls back to allowing request, never feeding `Inventory.reservedAmount/stock` or `Reservation.status`/`Order.status`. Inventory path `OrderCheckoutService`/`OrderCompletionService` stays `dataSource.transaction → FOR UPDATE Inventory → available = stock - reservedAmount` (FR-007). Flush Redis resets quotas but never corrupts orders (A1). |
| **II. Modular monolith — no premature microservices** | ✅ PASS | Single Nest process augmentation `RateLimitGuard` shared; no new service/process, reuses `CacheModule` global + `BullMQ` `REDIS_URL`. Guard provider exported by `AuthModule`, imported by `OrderModule`/`CartModule`/`ProductsModule` only via DI. |
| **III. Inventory/Reservation separate domains, explicit lifecycle** | ✅ PASS | Guard touches no domain state; `Product` has no `stock`, `Inventory` `stock/reservedAmount` checks stay inside checkout/complete transactions (same as Phase 6/7). No new inventory fields. |
| **IV. Concurrency safety at DB level (no overselling)** | ✅ PASS | Throttle check is **before** `DataSource.transaction`; `429` spy proves 0 `transaction`/`FOR UPDATE` calls (SC-007). Therefore lock ordering `sortedIds` deterministic and short transaction unchanged; throttling does not replace `pessimistic_write`. Race on counter (get+set) is tolerated, not used for inventory. |
| **V. Module boundaries, service-only collaboration** | ✅ PASS | `RateLimitGuard` lives in `AuthModule` (`src/modules/auth/guards/rate-limit.guard.ts`) and is injected via `CACHE_MANAGER` + `ConfigService`; no cross-module `@InjectRepository`. Controllers stay thin (`UseGuards(RateLimitGuard)` per route, FR-008). New modules import guard via `AuthModule` export, no repo leakage. |
| **VI. Spec-driven development** | ✅ PASS | Spec `spec.md` + 5 clarifications Session 2026-09-22 (Q1 protected set/limits, Q2 distributed Yes, Q3 get+set vs INCR tighten, Q4 fail-open, Q5 inventory never) done before plan; no future phase (async Phase 11, idempotency Phase 12) implemented; counters ephemeral, not future Store. |
| **VII. Tests mandatory, DB-backed for consistency** | ✅ PASS | Real-Redis-or-mocked integration required for shared-counter + fail-open + per-user isolation (FR-009); unit mocks `CACHE_MANAGER` fail-open throw; E2E `supertest` x11 bursts verify `429` no `Order` row for 11th. Inventory concurrency tests untouched and still prove only one succeeds. |
| **VIII. No invented APIs/payments/business rules** | ✅ PASS | No new routes: `POST /auth/*`, `POST /order/checkout`, `POST /order/:id/complete`, `POST/PATCH/DELETE /cart`, GraphQL product mutations all pre-existing contracts; only adds per-route `LIMITS` entries + `429` headers. No `inventory:{id}`/`reservation:{id}` throttle keys enlarging contract. Limits are business tuning, not API. |
| **IX. Documentation is part of work** | ✅ PASS | This plan + `research.md`, `data-model.md`, `contracts/`, `quickstart.md` under `specs/010-rate-limiting/`; `AGENTS.md` marker updated to this plan; `docs/architecture/rate-limiting.md` (or `docs/architecture/modules.md` extension) + Swagger `429` annotations. |

**Gate result**: **PASS** — no violations. Post-design re-check (after Phase 1) below remains **PASS** (decisions D1-D6 preserve same invariants, no inventory gating).

## Project Structure

### Documentation (this feature)

```text
specs/010-rate-limiting/
├── plan.md              # This file (/speckit.plan command output)
├── research.md          # Phase 0 output — decisions D1-D6, limits tradeoffs, keys, fail-open, distributed
├── data-model.md        # Phase 1 output — RateLimitBucket (derived), RateLimitGuard, RequestContext
├── quickstart.md        # Phase 1 output — setup .env *_RL_MAX, docker-compose up -d, manual burst→429 + Redis-down fail-open
├── contracts/
│   └── rate-limiting.md # Phase 1 output — REST+GraphQL throttling contract (protected routes, limits table, headers, fail-open, 429 shape)
├── checklists/
│   └── requirements.md  # Spec quality checklist (pre-existing, all pass after 5 clarifies)
└── tasks.md             # Phase 2 output (/speckit.tasks — NOT created by /speckit.plan)
```

### Source Code (repository root)

```text
src/
├── modules/
│   ├── auth/
│   │   ├── guards/
│   │   │   ├── rate-limit.guard.ts          # MODIFY — extend LIMITS with order:checkout/complete + cart + product mutation entries, add ConfigService-driven limits (ORDER_CHECKOUT_RL_MAX etc), helpers buildRateLimitKey/getLimitsForRoute/extractIp/userKey/tooMany, per-route two-bucket (IP+email/phone) already, per-user (req.user.sub else ip) for checkout/cart, fail-open try/catch + Logger.warn, JSDoc + // intent comments
│   │   │   ├── rate-limit.guard.spec.ts     # MODIFY — extend unit tests for new routes (order 10/user, cart 60/user, product 30/admin, distributed shared Map, fail-open throw)
│   │   │   └── test/
│   │   │       └── rate-limit.integration.spec.ts # MODIFY — extend integration (real Redis FLUSHDB) for new routes, two-instance shared counter, Redis-down true
│   │   └── auth.module.ts                   # MODIFY — export RateLimitGuard (provider already, add exports if not), inject ConfigService alongside CACHE_MANAGER
│   ├── order/
│   │   ├── order.controller.ts              # MODIFY — add @UseGuards(RateLimitGuard) to POST checkout (and alias POST /order) and POST/PATCH :id/complete, order @UseGuards order so RateLimitGuard is outermost before Auth (or per-method decorated before @Auth); JSDoc preserved
│   │   ├── order.module.ts                  # MODIFY — import AuthModule or forwardRef to get RateLimitGuard provider (if not global), keep DataSource injection
│   │   └── order.controller.spec.ts         # MODIFY — add E2E/unit for 429 no-transaction spy
│   ├── cart/
│   │   ├── cart.controller.ts               # MODIFY — add @UseGuards(RateLimitGuard) to POST /cart, PATCH increase/decrease, DELETE :cartItemId and DELETE /cart (per-user 60/h shared bucket), keep @Auth(User) on controller (guard already outermost per method)
│   │   └── cart.service.ts                  # unchanged (getUserCart stays, no lock)
│   ├── products/
│   │   ├── products.resolver.ts             # MODIFY — add @UseGuards(RateLimitGuard) to GraphQL mutations createProduct/createMany/updateProduct/removeProduct/removeAllProducts (per-admin 30/h) via @UseGuards at resolver or per-mutation; map GqlExecutionContext → req for ip/user extraction, or defer to REST inventory mutation if GQL mapping TODO — document
│   │   ├── products.module.ts               # MODIFY — import AuthModule to get guard if not global, keep TypeOrmModule.forFeature([Product]) + forwardRef(InventoryModule)
│   │   └── entities/product.entity.ts        # unchanged
│   └── inventory/
│       └── inventory.controller.ts          # MODIFY (optional) — add @UseGuards(RateLimitGuard) to POST :productId/increase|decrease (Admin) with product mutation bucket 30/h if exposed
├── app.module.ts                            # unchanged — CacheModule.registerAsync global ttl 60*1000 kept; PRODUCT_* TTLs remain, RATE_LIMIT_* env read in RateLimitGuard via ConfigService not here
├── cache-test.service.ts                    # unchanged — onModuleInit SET connection_test_key 5000, log verified/failed but no crash (fail-open precedent)
├── data-source.ts                           # unchanged (synchronize:false)
├── .env/.env.example                        # MODIFY — add ORDER_CHECKOUT_RL_MAX=10 ORDER_CHECKOUT_RL_WINDOW_MS=3600000 ORDER_COMPLETE_RL_MAX=10 ORDER_COMPLETE_RL_WINDOW_MS=3600000 CART_RL_MAX=60 CART_RL_WINDOW_MS=3600000 PRODUCT_MUTATION_RL_MAX=30 PRODUCT_MUTATION_RL_WINDOW_MS=3600000 RATE_LIMIT_FAIL_OPEN_METRIC=auth_rate_limit_fallback_total plus existing REDIS_URL
└── docs/architecture/
    └── rate-limiting.md or modules.md       # MODIFY — protected routes map + limits table + key pattern rl:{METHOD} {PATH}:{DIM}:{VALUE} + shared Redis vs in-memory fallback + fail-open rule + inventory never inside guard + Swagger 429 annotations
```

**Structure Decision**: Single project (Option 1) — augment existing `RateLimitGuard` shared guard with per-route `LIMITS` entries + `ConfigService` limits + `Order`/`Cart`/`Products` controller `@UseGuards` wiring; no new top-level module, no PG migration, no queue — consistent with `AGENTS.md` Module boundaries and Phase 5 guard precedent.

## Complexity Tracking

> Fill ONLY if Constitution Check has violations that must be justified

| Violation | Why Needed | Simpler Alternative Rejected Because |
|-----------|------------|-------------------------------------|
| — | — | — |

*No violations — all gates PASS. No new API/state/cache beyond `rl:*` counters.*

---

## Phase 0: Research (completed → research.md)

All `NEEDS CLARIFICATION` resolved (0 in Technical Context; 5 business clarifications in spec Session 2026-09-22). Key decisions: D1 primitive `get+set` tolerated race vs `INCR+EXPIRE` atomic tighten, D2 limits auth 5-20/h + checkout/complete 10/h/user + cart 60/h/user + product 30/h/admin via ConfigService clamped, D3 keys `rl:{METHOD} {PATH}:{DIM}:{VALUE}` with `x-forwarded-for`→`ip` + `email/phone` lowercase + `user.sub else ip`, D4 distributed Yes via shared `CACHE_MANAGER` `REDIS_URL` vs in-memory fallback, D5 fail-open every `get/set` with `Logger.warn`+`Retry-After`, D6 guard outermost before `JwtGuard`/`RolesGuard`+`DataSource.transaction` never inside. See `research.md` for rationale and alternatives.

## Phase 1: Design (completed)

- **Data model** → [data-model.md](./data-model.md): `RateLimitBucket` derived ephemeral Redis (`rl:* → count` TTL `windowMs`), `RateLimitGuard` shared `CanActivate` (`LIMITS` per-route, helpers `buildRateLimitKey/extractIp/tooMany/getLimitsForRoute`), `RequestContext` (`req.method/route.path/headers/body/user/res` plus GraphQL `GqlExecutionContext`), `RateLimitConfig` env (`ORDER_CHECKOUT_RL_MAX` etc via `ConfigService`).
- **Contracts** → [contracts/rate-limiting.md](./contracts/rate-limiting.md): REST+GraphQL throttling contract (protected routes, limits table, key patterns, success headers `X-RateLimit-*`, failure `429 Retry-After:3600` + `X-RateLimit-Limit/Remaining:0`, fail-open `200` on Redis down, `429` shape `{statusCode:429, message, timestamp}`, SC-001..008 mapping, Swagger `429` annotations).
- **Quickstart** → [quickstart.md](./quickstart.md): Env no Redis fallback in-memory, `docker-compose up -d`, manual curl bursts `POST /auth/login x11` + `POST /order/checkout x11` (per-user) + `POST /cart x61` + Redis `FLUSHDB` distributed two-instance, Redis-down `ECONNREFUSED` fail-open verify, `npm run test -- --runInBand` + `npm run build` + `npm run test:e2e`.
- **Agent context** → `AGENTS.md` marker `<!-- SPECKIT START -->` … `<!-- SPECKIT END -->` updated to point to this plan (`specs/010-rate-limiting/plan.md`).

### Agent context update

`AGENTS.md` marker updated via manual edit to this plan (step 3 of `/speckit.plan`). Verify with `grep -n SPECKIT AGENTS.md`.

## Re-evaluated Constitution Check (post-design)

No new code or decisions introduced in Phase 1 that would violate principles. Post-design gate remains **PASS** on all nine principles (same table as above). Completion extends checkout/cart with throttling without growing `FOR UPDATE` lock window and keeps `CACHE_MANAGER` shared-store-only (no inventory cache).

## Next Steps (Phase 2 — not in this command)

`/speckit.tasks` will break Phase 10 into ordered tasks (e.g.: 1) failing unit `POST /auth/login 10→429` no regress + `forgot 5/3` two-bucket; 2) failing `POST /order/checkout 10/user→429` + per-user isolation + `0 transaction` spy + `POST /order/:id/complete 10/user`; 3) failing `POST /cart 60/user→429` + `DELETE` shared bucket + product admin `30/h` via resolver; 4) failing distributed two-instance shared counter + fail-open `ECONNREFUSED→true` + `X-RateLimit-Limit/Remaining` on success; 5) implement guard `LIMITS` + `ConfigService` limits + helpers `buildRateLimitKey/extractIp`; 6) wire `@UseGuards(RateLimitGuard)` on `OrderController` checkout/complete + `CartController` writes + `ProductsResolver` mutations; 7) wire `.env.example` + Swagger `429` + docs `rate-limiting.md`; 8) integration `FLUSHDB` real Redis burst `x11/x61` + `FLUSHDB` distributed + `npm run lint/build/test -- --runInBand` + E2E `supertest` `login x11` + `checkout x11` + `cart x61`).
