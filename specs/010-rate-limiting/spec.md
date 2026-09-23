# Feature Specification: Rate Limiting / Distributed Throttling

**Feature Branch**: `010-rate-limiting`  
**Created**: 2026-09-22  
**Status**: Draft  
**Input**: User description: "phase 10"  
**Source**: `docs/plan.md` Phase 10 — Rate Limiting (§10, `Status: PARTIALLY DONE / INFRASTRUCTURE DIRECTION EXISTS`), constitution I/III/IV (PostgreSQL authoritative, Redis cache-only, never source for inventory/reservation/order), existing `src/modules/auth/guards/rate-limit.guard.ts` (Redis `CACHE_MANAGER` `get/set` with `windowMs`, limits `forgot 5/h/IP+3/h/email`, `reset/validate 10/h/IP`, `otp 5/h/phone+10/h/IP/10/h/phone`, `google/callback 20/h/IP`, `login/register 10/h/IP`, fail-open with `Logger.warn` + `Retry-After` + `X-RateLimit-*`), `src/app.module.ts` (`CacheModule` global `createKeyv(REDIS_URL)` + `BullMQ` shared connection), `src/modules/auth/auth.controller.ts` (`@UseGuards(RateLimitGuard)` on `POST /auth/*`)

---

## 1. Overview

Phases 1-9 built a transactionally correct product → inventory → reservation → checkout → order-completion pipeline with product catalog caching (Phase 9 `products:list:{page}:{limit}` 60s + `product:{id}` 300s, selective invalidation, fail-open). `Auth` already has per-route Redis rate limiting via `RateLimitGuard`, but the rest of the surface — **checkout**, **order completion**, **cart mutations**, and **product mutations** — has no shared throttling. Phase 10 was therefore reserved in `docs/plan.md` as the **rate-limiting phase**: define protected endpoints, define per-endpoint limits, decide on distributed state, reuse Redis as shared counter, and prove both limit and degraded-Redis paths.

This spec is the user request `phase 10`. **Decision for Phase 10 V1**: **Extend `RateLimitGuard` to every abuse-prone write** while keeping the **same Redis infra** (`CACHE_MANAGER` via `@keyv/redis` ioredis) and the **same fail-open invariant** (Redis down → allow request, never block catalog or checkout). No new infrastructure, no new DB table, no inventory check inside the limit — limits are checked **before** the `DataSource.transaction`, never inside it.

### Goal

Abuse-prone endpoints are throttled per identity/IP via a **shared Redis counter** when multiple API instances run, callers receive standard `429` headers, and a Redis outage **never breaks** a valid checkout, cart, or catalog request nor compromises `FOR UPDATE` inventory correctness. — `docs/plan.md` Phase 10 Exit Criteria (adapted).

---

## 2. User Scenarios & Testing

### User Story 1 — Brute-force protection on auth endpoints stays enforced (Priority: P1)

An anonymous attacker repeatedly calls `POST /auth/login` or `POST /auth/forgot-password` (and `POST /auth/register`, `POST /auth/reset-password`, `POST /auth/validate-reset-token`) from a single IP. After 10 `login` attempts in one hour (or 5 `forgot-password`/IP + 3 `/email`), the next call receives `429 Too Many Requests` with `Retry-After: 3600` and `X-RateLimit-Limit/Remaining/Reset`, while a legitimate user from a different IP is still allowed. Headers are correct on both success (`Remaining` decrements) and failure (`Remaining: 0`).

**Why this priority**: Auth is the highest-risk abuse surface (credential stuffing, reset spamming). It already ships in `005-auth-upgrades` and **must not regress** when the guard is generalized. Every other story builds on the same guard.

**Independent Test**: With `CACHE_MANAGER` mocked as `{get,set}` (or real Redis `FLUSHDB`), call `POST /auth/login` 10 times from `x-forwarded-for: 1.1.1.1` → first 10 return `200/401` (guard passed) and each response header `X-RateLimit-Limit: 10` with `Remaining:9..0`. 11th call → `429` with `Retry-After: 3600` and `X-RateLimit-Limit:10 Remaining:0`. Repeat from `2.2.2.2` → `200` again (IP isolation). Call `POST /auth/forgot-password {email:a@b}` 3 times → 4th with same email → `429 X-RateLimit-Limit:3` even if IP differs, while different email still allowed until IP limit 5 hit.

**Acceptance Scenarios**:
1. **Given** fresh Redis, **When** `POST /auth/login` called 10 times from same IP within hour, **Then** each of the 10 succeeds (guard returns `true`, headers `X-RateLimit-Limit:10 Remaining:10-n`), and 11th returns `429` with `Retry-After:3600` and `X-RateLimit-Remaining:0` without touching `AuthService`.
2. **Given** `POST /auth/forgot-password {email:v@ictim}` called 3 times, **When** 4th with same email (different or same IP), **Then** `429 X-RateLimit-Limit:3`, while `POST /auth/forgot-password {email:other@b}` from same IP still allowed until the per-IP 5 limit → 6th `429 X-RateLimit-Limit:5`.
3. **Given** two different IPs `A` and `B`, **When** `A` exhausts `POST /auth/login` 11th → `429`, **Then** `B`'s next `POST /auth/login` still returns `200/401` (counter isolated by `rl:POST /auth/login:ip:<ip>` key).

---

### User Story 2 — Checkout and order completion are throttled per user to prevent inventory-lock abuse (Priority: P1)

A logged-in shopper repeatedly calls `POST /order/checkout` (which locks `Inventory FOR UPDATE` and creates `Order PENDING + Reservation RESERVED`) or `POST /order/:id/complete` (which does `stock-=qty reserved-=qty`) in a tight loop. After exceeding the configured quota, further calls receive `429` **before** any `dataSource.transaction` or inventory lock is entered. A different user is unaffected, and a shopper who stays under the quota completes normally.

**Why this priority**: These are the only paths that mutate `Inventory.reservedAmount/stock`; abusive bursts can create lock contention and oversell-like pressure even though the DB prevents corruption. Throttling at the gate keeps the transaction short and the system stable. Equal to Story 1.

**Independent Test**: Authenticated as `userA` (JWT `sub`), call `POST /order/checkout {}` 10 times within hour (with cart seeded each time) → first 10 complete to `201` (or `400` empty cart but guard counted), 11th → `429` with `X-RateLimit-Limit:10` for `POST /order/checkout:user:<userId>`; same IP but different user `userB` still gets `201`. Likewise `POST /order/:id/complete` 10/ hour per user → 11th `429`. Spy `DataSource.transaction` not called on `429` path.

**Acceptance Scenarios**:
1. **Given** userA has valid cart, **When** `POST /order/checkout` called 10 times quickly, **Then** each returns `201 {id,status:PENDING}` (or `400` for empty cart after first but guard still counted) with `X-RateLimit-Remaining:9..0`, and 11th returns `429 {statusCode:429, message:"Too Many Requests"}` plus headers `Retry-After:3600 X-RateLimit-Limit:10`.
2. **Given** userA exhausted `POST /order/checkout`, **When** userB (different `sub`) calls `POST /order/checkout` from same IP, **Then** returns `201` (per-user key `rl:POST /order/checkout:user:<userB>` isolated), proving rate key is **user** not IP for checkout.
3. **Given** a pending order `orderId` for userA, **When** `POST /order/:id/complete` called 11th time within hour, **Then** `429 X-RateLimit-Limit:10` and controller never entered `dataSource.transaction(() => orderCompletionService.complete(...))` (spy 0 calls), so no inventory lock occurred.

---

### User Story 3 — High-frequency cart and admin product mutations are throttled with shared Redis, yet reads survive Redis outage (Priority: P2)

A shopper scripts `POST /cart` and `PATCH /cart/increase` in a loop, and an `Admin` bulk-edits products via GraphQL `updateMany`. Both are capped (cart writes ~60/hour per user, product mutations ~30/hour per admin) using the **same distributed counter** — two API instances sharing `REDIS_URL` agree on the count (key in Redis, not in-memory). When Redis is down, **all still succeed** via fail-open (warning logged), because availability of the catalog and cart outweighs strict throttling in a degraded state.

**Why this priority**: P2 because cart/product spam is lower risk than auth/checkout, but distributed enforcement and fail-open are the reliability properties that make Phase 10 viable at scale. Without shared Redis, two instances would each allow double the quota; without fail-open, a Redis outage would take down checkout.

**Independent Test**: With mocked `CACHE_MANAGER` throwing on `get/set`, call `POST /cart {productId,quantity}` and `POST /order/checkout` → assert each still returns `201/200` from DB and `Logger.warn RateLimit Redis fail-open for ...`. With real Redis (or two mocked `Cache` instances sharing underlying store), call `POST /cart` 60 times via instance A then once via instance B as same user → 61st `429` (shared count). Then call `GET /products` (listing) 60+ times → `GET` is not throttled strict (optional lenient 100/hour/IP or not limited) to avoid breaking browsing — verify `RateLimitGuard` returns `true` for unconfigured route.

**Acceptance Scenarios**:
1. **Given** user X did 60 `POST /cart` within hour, **When** 61st `POST /cart` (or `PATCH /cart/increase`) from same user, **Then** `429 Retry-After:3600 X-RateLimit-Limit:60` without creating a cart row, while `GET /cart` still returns `200` (reads not throttled at same limit).
2. **Given** admin did 30 `updateProduct` GraphQL mutations within hour, **When** 31st `updateProduct` (or `createProduct`/`updateMany`) from same admin, **Then** `429 X-RateLimit-Limit:30`, while another admin's first mutation still `200`.
3. **Given** Redis is unreachable (`CACHE_MANAGER.get` throws `ECONNREFUSED`), **When** any rate-limited route (`POST /auth/login`, `POST /cart`, `POST /order/checkout`, GraphQL product mutation) is called, **Then** response is `200/201` (or `400` for validation) with data from DB, log warns `RateLimit Redis fail-open for <routeKey>: <error>` and no `500`, headers may be absent but request not blocked.

---

### User Story 4 — Operators can verify rate-limit behavior and that throttling never holds inventory locks (Priority: P2)

An operator (or CI) runs `npm run test -- --runInBand` and `npm run test:e2e` and inspects Swagger. They see per-endpoint limits documented, headers on every throttled response, and a guarantee that the guard executes **before** `JwtGuard`/controller transaction. Integration tests show `POST /order/checkout` under `429` never called `InventoryService` or `DataSource.transaction`, and the filter returns `{statusCode:429, message, headers}` with `Retry-After`.

**Why this priority**: P2 transparency invariant. Without it, limits are unverifiable and regressions (guard inside transaction, missing headers, or silently disabled on Redis down) would ship undetected.

**Independent Test**: Spy `DataSource.transaction` and `InventoryService.getInventory` while triggering `429` on `POST /order/checkout` as above → 0 calls. Assert `AllExceptionsFilter` serializes `HttpException` `429` with `timestamp` and that `RateLimitGuard` wrote `X-RateLimit-*` via `res.setHeader` on success and via `ex.options.headers` on failure. Swagger `@ApiResponse 429` lists `Retry-After`.

**Acceptance Scenarios**:
1. **Given** `POST /order/checkout` would `429`, **When** that request is processed, **Then** `dataSource.transaction` spy called 0 times and `ReservationService.create` / `InventoryService` spy 0, proving guard rejected before any DB lock.
2. **Given** `POST /auth/login` successful, **When** response inspected, **Then** headers `X-RateLimit-Limit:10`, `X-RateLimit-Remaining:N`, (and optional `X-RateLimit-Reset`) present; on `429` headers `Retry-After:3600 X-RateLimit-Limit: X-RateLimit-Remaining:0` present via exception filter.
3. **Given** Swagger at `/api`, **When** docs loaded, **Then** each throttled route lists `429 Too Many Requests` with `Retry-After` description and example limits (Auth, Checkout, Complete, Cart, Product mutations) per FR-002.

---

### Edge Cases

- What happens when `REDIS_URL` is unset/empty (CI without Redis) or `createKeyv(undefined)` falls back to in-memory? → Guard still uses `CACHE_MANAGER.get/set` (in-memory store per instance), limits still enforced per instance but not distributed; logs `Logger.warn Redis URL not set, using in-memory rate limit (non-distributed)`.
- What happens when `CACHE_MANAGER.get/set` throws mid-window (network partition, `ECONNREFUSED`, timeout) on **both** IP and per-email/phone keys? → Catch all Redis errors, `Logger.warn RateLimit Redis fail-open for <routeKey>: <msg>`, increment placeholder metric `auth_rate_limit_fallback_total`, return `true` (allow). No `500` even if second key throws.
- What happens when `x-forwarded-for` is missing, malformed, or contains multiple IPs (`"a,b,c"`)? → Use first value trimmed (`split(',')[0].trim()`), fallback `req.ip || 'unknown'`; never throw on header missing, always produce a deterministic key `rl:<route>:ip:<ip>`.
- What happens when `VerificationPipe` rejects body (e.g., `{})` before guard? → Guard runs **before** controller but **after** routing; if DTO throws `400`, Redis count was already incremented (counter increments on attempt, not on success). This is intentional (attempt counted), documented; alternative would be post-success counting, but pre-increment matches auth Phase 5 decision.
- What happens when an **authenticated** route uses user-scoped limit (`POST /order/checkout:user:<sub>`, `POST /cart:user:<sub>`) but JWT is missing/invalid? → `JwtGuard`/`Auth` would have already returned `401` before limit? Order: guards are `@UseGuards(RateLimitGuard, JwtGuard)`? Checkout uses `@Auth()` which applies `JwtGuard`+`RolesGuard`; `RateLimitGuard` must be **outermost** (first) so it still limits anonymous flood before auth, but per-user key falls back to IP when `req.user?.sub` absent. Implementation extracts `req.user?.sub` if present, else `ip`.
- What happens when a single request increments **two** counters (e.g., `POST /auth/forgot-password` per-IP 5 + per-email 3)? → Both keys checked atomically in same activation; if either exceeds, `429` with the limit that was exceeded (`X-RateLimit-Limit:3` for email vs `5` for IP); success requires both under limit.
- What happens when `windowMs` is misconfigured (0, negative, non-numeric env)? → Clamp to `3600_000` default with `Logger.warn Invalid rate-limit window ... fallback to 3600000`.
- What happens when concurrent bursts race for last permit (two requests at count 9/10 simultaneously)? → Both `get+set` may read 9 and set 10, allowing 11th incorrectly — tolerated V1 (cache `get+set` is not atomic `INCR` via ioredis). Future may use `CACHE_MANAGER.store.client.incr` + `expire` atomic, but V1 documents the race as low-risk and acceptable because correctness is about throttling, not financial consistency (unlike inventory which uses `FOR UPDATE`).
- What happens when `GET /products` (catalog browsing) is hammered? → V1 does **not** strictly throttle reads at 10/hour (would break UX). If a global read guard added, it is lenient `100/hour/IP` or disabled; throttling reads is out of scope and Swagger does not list `429` for `GET /products`.
- What happens when GraphQL product mutations hit rate limit? → GraphQL resolver context is HTTP `req` via `context: ({req}) => ({req})`; guard reads same `req.method req.route.path` mapping (`POST /graphql` not useful) — instead map `info.fieldName` (`createProduct` → limit 30/hour per admin). If mapping not possible V1, REST `/products` mutations remain covered and GraphQL rate limiting is TODO with same Redis keys via `GqlExecutionContext`.
- What happens when a throttled request already holds inventory `FOR UPDATE`? → It cannot — `RateLimitGuard.canActivate` runs **before** `controller → service → dataSource.transaction`. Therefore `429` path performs zero DB `SELECT FOR UPDATE`, proven by spy.

---

## 3. Requirements

### Functional Requirements

- **FR-001**: System MUST define the **protected endpoints** explicitly and apply `RateLimitGuard` only there (no global `APP_GUARD` blanket). Required protected set V1:
  - Auth: `POST /auth/forgot-password`, `POST /auth/reset-password`, `POST /auth/validate-reset-token`, `POST /auth/otp/request`, `POST /auth/otp/verify`, `GET /auth/google/callback`, `POST /auth/login`, `POST /auth/register` (carried from `005-auth-upgrades`)
  - Order: `POST /order/checkout` (alias `POST /order`), `POST /order/:id/complete` + `PATCH /order/:id/complete`
  - Cart: `POST /cart`, `PATCH /cart/increase`, `PATCH /cart/decrease`, `DELETE /cart/:cartItemId`, `DELETE /cart`
  - Product mutations (Admin): GraphQL `createProduct`, `createManyProducts`, `updateProduct`, `updateMany`, `removeProduct`, `removeAllProducts` — REST `inventory/:productId/increase|decrease` if exposed to `Admin`
  - Optional lenient: `GET /cart`, `GET /order`, `GET /inventory/:productId` at `100/hour/IP` (not strict, documented as out-of-scope if not implemented)
  - Excluded: `GET /products` / `GET /product/:id` catalog reads (uncapped or `1000/hour/IP` future) — must not be throttled at auth-level strictness
  Routes not in the map MUST pass untouched (`canActivate` returns `true` immediately).

- **FR-002**: System MUST enforce **limits per endpoint/use case** configurable via `ConfigService` with defaults (values valid unless overridden via `.env`):
  | Route | Dimension | Limit / Window | Key |
  |-------|-----------|---------------|-----|
  | `POST /auth/forgot-password` | per IP | `5/hour` | `rl:POST /auth/forgot-password:ip:<ip>` |
  | `POST /auth/forgot-password` | per email | `3/hour` | `rl:POST /auth/forgot-password:email:<email>` |
  | `POST /auth/reset-password` | per IP | `10/hour` | `rl:POST /auth/reset-password:ip:<ip>` |
  | `POST /auth/validate-reset-token` | per IP | `10/hour` | `rl:POST /auth/validate-reset-token:ip:<ip>` |
  | `POST /auth/otp/request` | per phone | `5/hour` + per IP `10/hour` cooldown 60s | `rl:POST /auth/otp/request:phone:<phone>` + `...:ip:<ip>` |
  | `POST /auth/otp/verify` | per phone | `10/hour` | `rl:POST /auth/otp/verify:phone:<phone>` |
  | `GET /auth/google/callback` | per IP | `20/hour` | `rl:GET /auth/google/callback:ip:<ip>` |
  | `POST /auth/login` | per IP | `10/hour` | `rl:POST /auth/login:ip:<ip>` |
  | `POST /auth/register` | per IP | `10/hour` | `rl:POST /auth/register:ip:<ip>` |
  | `POST /order/checkout` (+ alias) | per user (`req.user.sub`) else per IP | `10/hour` (override `ORDER_CHECKOUT_RL_MAX`) | `rl:POST /order/checkout:user:<sub>` else `:ip:<ip>` |
  | `POST /order/:id/complete` + `PATCH` alias | per user | `10/hour` (`ORDER_COMPLETE_RL_MAX`) | `rl:POST /order/:id/complete:user:<sub>` |
  | `POST /cart` | per user else IP | `60/hour` (`CART_RL_MAX`) | `rl:POST /cart:user:<sub>` |
  | `PATCH /cart/increase` | per user | `60/hour` | `rl:PATCH /cart/increase:user:<sub>` |
  | `PATCH /cart/decrease` | per user | `60/hour` | `rl:PATCH /cart/decrease:user:<sub>` |
  | `DELETE /cart*` | per user | `60/hour` shared bucket with above | `rl:DELETE /cart:user:<sub>` |
  | `createProduct` / `updateProduct` / GraphQL mutations | per admin user else IP | `30/hour` (`PRODUCT_MUTATION_RL_MAX`) | `rl:products:mutation:user:<sub>` |
  All windows default `3600_000 ms` (1h) unless `*_RL_WINDOW_MS` env overrides; values parsed via `ConfigService.get<number/string>` clamped `windowMs >= 60_000` else fallback + `Logger.warn`.

- **FR-003**: System MUST be **distributed** when `REDIS_URL` is set. `RateLimitGuard` MUST use the shared `CACHE_MANAGER` store backed by `@keyv/redis` + `ioredis` (same connection as `CacheModule` + `BullMQ`), not an in-memory `Map`. Two API instances with identical `REDIS_URL` share the same `rl:*` keys. When `REDIS_URL` is empty, guard MUST log `Logger.warn Redis URL not set, using in-memory rate limit (non-distributed)` and still function per instance (acceptable for CI/non-distributed dev). No second Redis client is introduced.

- **FR-004**: System MUST derive **rate-limit keys** deterministically. Pattern:
  ```
  rl:{METHOD} {PATH}:{DIMENSION}:{VALUE}
  rl:POST /auth/login:ip:1.2.3.4
  rl:POST /auth/forgot-password:email:alice@example.com
  rl:POST /order/checkout:user:<uuid-sub>  (or :ip:<ip> when unauthenticated)
  rl:products:mutation:user:<uuid>         (GraphQL admin)
  ```
  Dimension extraction: `ip = (req.headers['x-forwarded-for']?.split(',')[0].trim()) || req.ip || 'unknown'`; `email = req.body?.email` lowercase; `phone = req.body?.phoneNumber`; `user = req.user?.sub ?? ip` for authenticated writes. Keys MUST use same casing/prefix as existing `expiration:tick:lock` namespace does not collide (`rl:` isolated). All key construction MUST be pure helper `buildRateLimitKey(routeKey, dim, value)`.

- **FR-005**: System MUST be **fail-open on Redis/cache failures** everywhere. Every `cache.get(key)` / `cache.set(key, count, windowMs)` (or `store.client.incr` future) is wrapped in `try { ... } catch (e) { Logger.warn(RateLimit Redis fail-open for <routeKey>: <msg>); /* metric auth_rate_limit_fallback_total++ placeholder */ }` and returns `true` (allow). Failure on either per-IP or per-email/phone key still allows. Fail-open applies to **all** FR-001 routes; product/catalog `GET` already fail-open for cache.

- **FR-006**: System MUST return **standard headers** on both success and limit per existing `0011-auth-upgrades` B1 decision:
  - On success: `res.setHeader('X-RateLimit-Limit', String(max))` and `res.setHeader('X-RateLimit-Remaining', String(Math.max(0, max - count)))` (and optionally `X-RateLimit-Reset: <epochSec>` window end).
  - On `429`: throw `HttpException('Too Many Requests', 429)` with `ex.options = { headers: { 'Retry-After': '3600', 'X-RateLimit-Limit': String(limit), 'X-RateLimit-Remaining':'0' } }` so `AllExceptionsFilter` serializes `{statusCode:429, message, timestamp}` and Swagger `Retry-After` is visible. Header window `Retry-After` value MUST equal `Math.ceil(windowMs/1000)`.
  No custom body — use `HttpStatus.TOO_MANY_REQUESTS`.

- **FR-007**: System MUST **never compromise transactional inventory correctness** with rate limiting. Required invariant:
  - `RateLimitGuard.canActivate` runs **before** `JwtGuard`/`RolesGuard` (outermost `UseGuards` order) and **before** any `DataSource.transaction` or `Repository` call.
  - No `cache.get/set` inside `OrderCheckoutService.checkout`, `OrderCompletionService.complete`, `ReservationService.create`, `InventoryService.*`, or `CartService.*`; those services remain pure DB transactions with `FOR UPDATE` + `available = stock - reservedAmount` checks.
  - Integration spy confirms `429` path had `0` calls to `dataSource.transaction` and `0` calls to `Inventory` locking.
  `docs/plan.md` rule `Rate limiting must never compromise transactional inventory correctness` is P0.

- **FR-008**: System MUST keep **API surface and guard boundaries thin** and observable. `RateLimitGuard` is a single `Injectable CanActivate` implementing `canActivate(context: ExecutionContext): Promise<boolean>`, injected with `@Inject(CACHE_MANAGER) cache: Cache`, `Logger`, `ConfigService` for limits. Controllers stay thin (`@UseGuards(RateLimitGuard)` per route or per controller) — no business logic migrates. Guard MUST have class-level `/** This guard is responsible for distributed per-route rate limiting (Redis shared, fail-open) ... */` and each helper (`buildRateLimitKey`, `getLimitsForRoute`, `toTooManyException`, `extractIp/email/phone/userKey`) with `/** @param @returns @throws */` JSDoc per `AGENTS.md` §3, plus `//` intent comment for every multi-predicate branch (e.g., `// per-email only if body.email present, else skip`).

- **FR-009**: System MUST provide **DB/Redis-backed tests proving the throttling contract** (per Testing Rules — unit mocked, integration real Redis when available, E2E supertest):
  - **Unit (mocked `CACHE_MANAGER` as `{get,set}` jest.fn, mocked `Logger`, `ConfigService`, `ExecutionContext` with `req.route.path`, `req.method`, `req.ip`, `req.headers`, `req.body`, `req.user`, `res.setHeader`):**
    - `POST /auth/login` 10 → 11th 429 with B1 headers, IP isolated.
    - `POST /auth/forgot-password` 3/email + 5/IP → 4th email 429 Limit 3, 6th IP 429 Limit 5.
    - `POST /order/checkout` per-user 10/hour → 11th 429, different user still 200, `cache.get` called with `user:<sub>` key, `dataSource.transaction` not called on 429.
    - `POST /cart` 60/hour per user → 61st 429.
    - Redis `get/set` throwing → still `true` + `Logger.warn RateLimit Redis fail-open`.
    - Success path sets `X-RateLimit-Limit/Remaining` correctly (`Remaining = max - count`).
    - GraphQL product mutations 30/hour per admin → 31st 429.
  - **Integration (real Redis if `REDIS_URL` reachable else mocked `CACHE_MANAGER` with shared Map):**
    - Real guard with `Test.createTestingModule` + `CacheModule` (or in-memory fallback) `FLUSHDB`, call `canActivate` 11 times same IP → 10 `true`, 11th `HttpException 429`.
    - Two guard instances sharing same `CACHE_MANAGER` store → counts shared (instance A 5 + instance B 6 → B's 11th 429).
    - Checkout 10/user distributed shared → second instance sees limit.
    - Redis-down simulation (client `get` = `() => Promise.reject(new Error('ECONNREFUSED'))`) → all routes `true` + `warn`.
  - **E2E (supertest + JWT `Authorization: Bearer <accessToken>`):**
    - `POST /auth/register` → `POST /auth/login` x11 → 11th `429 {statusCode:429}` with `Retry-After` header.
    - `POST /order/checkout` x11 authenticated → 11th `429`, no `Order` created (count `Order` table `count ==10`).
    - `POST /cart` x61 then `GET /cart` → `POST` 61st 429, `GET` 200.
  - All existing suites must still pass (`npm run test -- --runInBand`, `npm run build`, `npm run test:e2e`).

- **FR-010**: System MUST be **configurable and observable**:
  - New env variables (`.env` + `.env.example`, read via `ConfigService`, never hard-coded `LIMITS` literals alone):
    ```
    ORDER_CHECKOUT_RL_MAX=10
    ORDER_CHECKOUT_RL_WINDOW_MS=3600000
    ORDER_COMPLETE_RL_MAX=10
    ORDER_COMPLETE_RL_WINDOW_MS=3600000
    CART_RL_MAX=60
    CART_RL_WINDOW_MS=3600000
    PRODUCT_MUTATION_RL_MAX=30
    PRODUCT_MUTATION_RL_WINDOW_MS=3600000
    RATE_LIMIT_FAIL_OPEN_METRIC=auth_rate_limit_fallback_total  # metric name placeholder
    ```
    plus reuse existing `REDIS_URL`/`REDIS_HOST`/`REDIS_PORT` for store. If env missing or NaN, guard falls back to FR-002 defaults + `Logger.warn Invalid rate-limit config ...`.
  - On `onModuleInit` or first activation, `Logger.log RateLimit guards: auth 5-20/h, checkout 10/h/user, cart 60/h/user, product 30/h/admin (REDIS_URL <set|unset>, distributed|in-memory)`.
  - Swagger: each throttled route annotated `@ApiResponse({status:429, description:'Too Many Requests — Retry-After: <sec> + X-RateLimit-*'})`. `docs/architecture/rate-limiting.md` (or extend `docs/architecture/modules.md`) documents protected routes map, limits table, key pattern `rl:{method} {path}:{dim}:{value}`, shared Redis vs in-memory fallback, fail-open rule, and that inventory is never gated by cache.

---

### Key Entities

- **RateLimitBucket (derived, Redis ephemeral)**: Not a DB table. Stored in Redis via `CACHE_MANAGER` as `rl:{METHOD} {PATH}:{DIMENSION}:{VALUE} → count:number` with TTL `windowMs`. Loss-tolerant (evictable, resets each hour); correctness never depends on its existence. Example keys: `rl:POST /auth/login:ip:1.1.1.1 → 7` (window 1h). Atomicity desired via `INCR + EXPIRE` but V1 tolerates `get+set` race (see edge case).

- **RateLimitGuard**: `Injectable CanActivate` at `src/modules/auth/guards/rate-limit.guard.ts` (shared). Owned by `AuthModule` but imported where needed or provided via global token. Methods: `canActivate(context)` (entry, outermost), `getLimitsForRoute(routeKey): {max, windowMs}[]` (one or two buckets per route), `buildRateLimitKey(routeKey, dim, value): string`, `extractIp(req): string`, `toTooManyException(key, limit, windowMs): HttpException`, `getClientIdentity(req): string` (user.sub else ip). Guards `Auth`, `Order`, `Cart`, `Inventory` (optional), `Products` (GraphQL) by decoration.

- **RequestContext**: Express `Request` (`req.method`, `req.route.path` or `req.path`, `req.headers['x-forwarded-for']`, `req.ip`, `req.body.email/phoneNumber`, `req.user.sub/role` injected by `JwtGuard` but guard reads it after). Response `res` for `setHeader`. For GraphQL, `GqlExecutionContext.create(context).getContext().req`. Defined to specify guard input without tying to implementation detail.

- **Order / Inventory / Reservation / Cart / Product (existing)**: Explicitly **never** consulted by guard for business math; mentioned only to scope invariant FR-007 (`available = stock - reservedAmount` stays in `DataSource.transaction`, not in guard).

---

## 4. Success Criteria

### Measurable Outcomes

- **SC-001**: With Redis empty (`FLUSHDB`), `POST /auth/login` from a single IP 10 times returns `true` each with `X-RateLimit-Limit:10 Remaining:9..0`, and the 11th call throws `HttpException 429` with `Retry-After:3600 X-RateLimit-Limit:10 Remaining:0` and does not reach `AuthService`. A call from a different IP immediately after still returns `true` (counter isolated by `rl:POST /auth/login:ip:<ip>`). Verified by unit spy (`cache.get` key isolated) and integration `Test.createTestingModule` 11x loop.

- **SC-002**: `POST /auth/forgot-password {email:v@ictim}` 3 times succeeds, 4th with same email throws `429 Limit:3` (`rl:...:email:<email>` bucket) even from different IP, while `POST /auth/forgot-password {email:other@b}` from same IP succeeds until its per-IP 5 bucket 6th throws `429 Limit:5`. Both buckets tracked (`cache.get` called for both keys each activation).

- **SC-003**: Authenticated `userA` calling `POST /order/checkout` 10 times within hour (each with fresh cart row) succeeds to `201` (or `400` empty cart but counted) with `X-RateLimit-Limit:10` decrementing, and 11th returns `429 Limit:10` **before** `dataSource.transaction` (spy 0 calls) and before any inventory lock; `userB` from same IP calling once still gets `201`, proving per-user isolation via `rl:POST /order/checkout:user:<sub>`.

- **SC-004**: Same per-user isolation for `POST /order/:id/complete` (`10/hour/user`) and `POST /cart` (`60/hour/user`): 60 `POST /cart` for user X succeed, 61st `429 Limit:60` without inserting a cart row, while `GET /cart` (or `GET /products`) same user still `200`. GraphQL `updateProduct`/`createProduct` for admin 30/hour → 31st `429 Limit:30` per `rl:products:mutation:user:<adminSub>`.

- **SC-005**: **Fail-open invariant**: With `CACHE_MANAGER.get` (or `set`) mocked to `Promise.reject(new Error('ECONNREFUSED'))`, every protected route (`POST /auth/login`, `POST /order/checkout`, `POST /cart`, GraphQL product mutation) still returns `200/201` from DB, `Logger.warn RateLimit Redis fail-open for <routeKey>: ECONNREFUSED` was emitted, and no `500`. Success headers may be absent but request not blocked — proven in unit (throw mock) and integration (client stub).

- **SC-006**: **Distribution**: Two `RateLimitGuard` instances sharing the same underlying store (real Redis or shared Map in test via same `Cache` provider) agree on quota — instance A does 5 `POST /cart` for same user, instance B does 55 more, then B's 61st `POST /cart` throws `429`. Equivalent for `POST /order/checkout` (A 5 + B 6 → B's 11th 429). Proves `rl:*` keys are in shared Redis, not per-process memory, when `REDIS_URL` set; when unset, test logs `in-memory (non-distributed)` and counts are per-instance by design (CI passes).

- **SC-007**: **Inventory lock never held under 429**: Under `429` for `POST /order/checkout` or `POST /order/:id/complete`, spies prove `dataSource.transaction` called `0` times, `ReservationService.create` `0`, `InventoryService.getInventory` `0` — guard rejected before checkout/complete transaction building `sortedIds + FOR UPDATE`.

- **SC-008**: **Headers + docs + non-regression**: Every `200` response from a throttled route carries `X-RateLimit-Limit` and `X-RateLimit-Remaining` via `res.setHeader`; every `429` carries `Retry-After` (= `windowMs/1000`) + `X-RateLimit-Limit/Remaining:0` via exception headers and is serialized as `{statusCode:429, message:'Too Many Requests', timestamp}` by `AllExceptionsFilter`. Swagger lists `429` with `Retry-After` for each route. `npm run test -- --runInBand` (≥20 suites, including 8+ new rate-limit unit/integration) + `npm run build` + `npm run test:e2e` (auth + checkout + cart flows) pass; existing `005-auth-upgrades` limits (`forgot 5/3, reset 10, otp, login 10`) byte-equal.

---

## 5. Assumptions

- **A1**: PostgreSQL is authoritative; Redis + `CACHE_MANAGER` (`@keyv/redis` + ioredis) is **shared state only** for counters and product cache — never for `Inventory.stock/reservedAmount`, `Reservation.status`, `Order.status` (constitution I/III, `AGENTS.md` Architecture). A `FLUSHDB` at any time resets quotas but never corrupts orders (correctness over strictness).

- **A2**: Phases 0-9 entities and constraints stay as shipped: `Product` no `stock`, `@Unique(name/slug)`, price `>=0`; `Inventory` 1-1 `stock/reservedAmount` `CHECK >=0` `reserved <= stock`; `Cart/CartItem` eager `product`; `Reservation` `status+expiresAt` composite index; `Order PENDING|COMPLETED|CANCELLED|FAILED` checkout-only. `synchronize:false`, existing migrations intact.

- **A3**: `CacheModule` global `createKeyv(REDIS_URL)` + `ttl:60*1000` ms is already provisioned (`docker-compose.yml` `redis:8` + `REDIS_URL`, `BullMQ` shared connection, `CacheTestService` ping `SET connection_test_key working 5000` on `onModuleInit` but not crashing). Phase 10 **reuses** this store for `rl:*` keys; no second `ioredis` client introduced.

- **A4**: Existing `RateLimitGuard` semantics are kept: V1 uses `cache.get::<number> → +1 → cache.set(key,count,windowMs)` (non-atomic, tolerated race, see edge case); `LIMITS` map carried from `005-auth-upgrades` `forgot 5/3, reset/validate 10, otp 5/phone+10/IP/10/phone, google 20, login/register 10` stays byte-equal for regression SC-008. Upgrading to `store.client.incr + expire` atomic is allowed in plan without changing tests (behavior tightens but SCs still pass).

- **A5**: `RateLimitGuard` is **per-route**, not global `APP_GUARD`. Routes absent from map return `true` instantly (no Redis I/O). That keeps `GET /products` product reads hot (no throttling) and avoids throttling `PATCH /users/me/preferences` etc. until separately justified.

- **A6**: Authenticated routes key on `req.user?.sub` (`JWT` `sub` UUID) when present else IP. `JwtGuard`/`Auth` still runs but **after** guard to ensure anonymous flood can be limited before DB lookup; per-user limit is primary for checkout/cart, per-IP fallback prevents unauthenticated bypass.

- **A7**: Header contract follows `docs/decisions/0011-auth-upgrades` **B1 full headers**: `Retry-After` + `X-RateLimit-Limit/Remaining/Reset`. `X-RateLimit-Reset` (epoch sec when window resets) is optional — `Retry-After` + `Limit/Remaining` required to pass SC. `AllExceptionsFilter` already maps `ex.options.headers` to response.

- **A8**: Testing uses mocked `CACHE_MANAGER` (`jest.fn().mockResolvedValue`) for deterministic unit suites; integration may use real Redis when `REDIS_URL` reachable via `FLUSHDB` but must still pass with mocked shared Map when Redis absent (same as expiration worker fail-open). `jest` is `ts-jest` with `--runInBand --forceExit`, existing `transformIgnorePatterns` for `@nestjs/bullmq` ESM already present.

- **A9**: `x-forwarded-for` vs `req.ip` extraction is deterministic: first comma-separated value trimmed, fallback to `req.ip`, fallback to `'unknown'` (never throws). Logging prefixes hashed buckets never leak raw email/phone in `Logger.warn`.

- **A10**: V1 quotas (auth 5-20/h, checkout/complete 10/h, cart 60/h, product mutation 30/h) are chosen to allow normal shopping (add to cart dozens of times browsing) while breaking brute-force/abuse; they are deliberately not tight (e.g., not checkout 3/h which would break test bursts). Tenants may tighten via `ORDER_CHECKOUT_RL_MAX` etc. without code change (FR-010).

---

## 6. Dependencies

- Phases 0-9 (`Product`, `Inventory` 1-1, `Reservation` composite index, `Order` checkout-only `PENDING|COMPLETED|CANCELLED|FAILED`, `Cart` eager, `Users` `tokenVersion`, `synchronize:false`).
- `CacheModule` global (`@nestjs/cache-manager` + `@keyv/redis` + ioredis) + `BullModule` shared `REDIS_URL` + `CacheTestService` (connection ping) — no new infra.
- Global `ValidationPipe` (`whitelist+forbidNonWhitelisted+transform`) + `AllExceptionsFilter` (`429` serialization with `Retry-After`) + `Logger` (fail-open warn + metric placeholder).
- Existing `AuthModule` (`TypeOrmModule.forFeature([PasswordResetToken, OtpVerification])`, `JwtModule`, `PassportModule`, `RateLimitGuard` provider) — guard generalizes to `OrderModule`, `CartModule`, `ProductsModule`.
- Existing `OrderModule` (`OrderCheckoutService` + `OrderCompletionService` `dataSource.transaction` `FOR UPDATE` + deterministic lock ordering) — guard must precede, not replace.
- `UserRoles` `Admin|User|ContentManager` via `RolesGuard` and `@Auth()` (product mutations admin-gated at 30/h per admin in V1, cart/order per user).
- Config: `.env` `REDIS_URL`, plus new `*_RL_MAX/_RL_WINDOW_MS` per FR-010.

---

## 7. Out of Scope (this phase)

- Per-endpoint sliding-window or token-bucket via `ioredis` `EVAL`/`CL.THROTTLE` — V1 keeps simple fixed-window `get+set` (or `INCR+EXPIRE` if atomic via `store.client.incr`) with tolerated race; no Lua scripts.
- Full `GET` catalog throttling (`GET /products` listing) — reads are not limited at auth strictness; if added, at `1000/hour/IP` future (Phase 20 dashboard).
- Refresh token rotation throttling (Phase 17 `POST /auth/refresh 10/hour/IP + 5/hour/token`) — orthogonal, keeps same `RateLimitGuard` pattern but lives in `005-auth-upgrades` + `17-refresh-token` spec, not here.
- Resilience beyond fail-open: circuit breaker, `X-RateLimit-Reset` precision beyond `Retry-After`, or metrics exporter `auth_rate_limit_fallback_total` Prometheus counter — metric name placeholder only, not wired to Grafana in V1.
- Redis persistence, clustering/sentinel, eviction tuning — ops concern; V1 single-node `redis:8` via `REDIS_URL`.
- RabbitMQ/BullMQ fan-out for throttling events — publishing `rate_limit.exceeded {ip,route}` after commit is allowed but not required V1.
- New DB migration for this phase — none expected (counters ephemeral in Redis). If constraints needed, separate migration but no throttling table.
- GraphQL full `info.fieldName` rate limiting beyond `product:*` mutations — if `GqlExecutionContext` mapping not ready V1, REST `products` remains sufficient, GraphQL listed as follow-up.

---

## 8. Clarifications

### Session 2026-09-22 (Phase 10 kickoff)

- Q: Which endpoints are protected in V1 and at what limits? → **A: Auth 5-20/h (existing 005 FR-014 kept), Order checkout/complete 10/h per user, Cart writes 60/h per user, Product mutations 30/h per admin** (FR-001/FR-002). Reads (`GET /products`, `GET /cart`) not strictly throttled (or lenient 100/h `TODO`) — protects abuse without breaking browsing.
- Q: Is distributed limiting required when multiple API instances run? → **A: Yes via shared `CACHE_MANAGER` backed by `REDIS_URL`** (FR-003). Same `rl:*` keys on shared Redis; `FLUSHDB` resets quotas but two instances agree on counts. In-memory fallback only when `REDIS_URL` empty (CI non-distributed, logged).
- Q: What Redis primitive powers the counter? → **A: V1 `cache.get → count+1 → cache.set(key,count,windowMs)` (cache-manager)** matching existing auth guard, tolerated race; plan may switch to atomic `store.client.incr + expire` without changing spec (behavior tightens). Both map to `INCR+EXPIRE` via ioredis.
- Q: What happens when Redis is unavailable? → **A: Fail-open — allow request, `Logger.warn RateLimit Redis fail-open for <route>: <msg>`, no `500`** (FR-005/SC-005) consistent with Phase 5 expiration worker and Phase 9 product cache. Counter correctness is availability over strictness.
- Q: Must rate limiting ever touch inventory arithmetic? → **A: Never — guard is outermost `UseGuards(RateLimitGuard)` before controller → `dataSource.transaction`, no `InventoryService` call in guard, `429` spy proves `transaction` 0 calls** (FR-007/SC-007). Constitution I preserved.

No `[NEEDS CLARIFICATION]` markers remain at spec authoring time. If plan research surfaces an atomic `INCR+EXPIRE` via `store.client.incr` vs `cache-manager` `get+set` trade-off, or a GraphQL `info.fieldName` → `Max` mapping, ≤1 focused clarification will be opened and the spec patched.

---

## 9. Acceptance Scenarios (for planning)

1. Auth burst: `POST /auth/login` 10 → `200`, 11th `429 Retry-After:3600 X-RateLimit-Limit:10` same IP; different IP `200`.
2. Forgot per-email+IP: 3 × same email `200`, 4th `429 Limit:3` + per-IP 6th `429 Limit:5` isolated.
3. Checkout per-user: `userA` 10 × `POST /order/checkout` `201`, 11th `429 Limit:10` before `transaction`; `userB` 1 × still `201`.
4. Cart 60/h/user: 60 × `POST /cart`/`PATCH` same user `201`, 61st `429 Limit:60` no row; `GET /cart` still `200`.
5. Product admin 30/h: 30 × `updateProduct` same admin `200`, 31st `429 Limit:30` isolated per admin.
6. Fail-open: mocked throw `CACHE_MANAGER.get/set` → all throttled routes still `200/201` + `Logger.warn`.
7. Distributed: two guards share store → A5 + B55 `POST /cart` then B61 `429` shared counter.
8. Inventory safety: `429` on checkout/complete → `dataSource.transaction` 0 calls, no `Inventory` lock, no `reservedAmount` mutation.

