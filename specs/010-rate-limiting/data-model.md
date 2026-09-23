# Data Model: Rate Limiting / Distributed Throttling (Phase 10)

**Branch**: `010-rate-limiting` | **Date**: 2026-09-22 | **Spec**: [spec.md](./spec.md) | **Plan**: [plan.md](./plan.md)

No new PostgreSQL tables or migrations in Phase 10. All entities reuse Phases 1-9 schema; Phase 10 adds a derived, evictable **RateLimitBucket** (not a table) and reuses **RateLimitGuard** shared guard plus **RequestContext** (ephemeral, HTTP).

---

## 1. Existing Entities (unchanged schema, new guard wiring)

### 1.1 `User` (`src/modules/users/entity/user.entity.ts`)

```text
User
----
id              uuid PK @PrimaryGeneratedColumn('uuid')
email           varchar @Unique @Index
password        varchar nullable
emailVerified   boolean default false
phoneNumber     varchar nullable @Index
phoneVerified   boolean nullable
googleId        varchar nullable @Index
provider        enum local|google default local
role            enum UserRoles User|Admin|ContentManager default User
tokenVersion    int default 0
passwordChangedAt timestamptz nullable
marketingOptIn  boolean default false (Phase 18)
```

**Phase 10 delta**: No schema change. Used as identity for **per-user** buckets (`rl:POST /order/checkout:user:<sub>`). Guard reads `req.user.sub` (`JwtStrategy` payload `sub` UUID) when present; logs never store `sub` raw fallback only hashed prefix in warn.

### 1.2 `Order` + `OrderItem` / `Inventory` / `Reservation` / `Cart`

Unchanged. **Never gated by Redis** for business math. `POST /order/checkout` and `POST /order/:id/complete` mutation windows stay `DataSource.transaction(async manager => ... FOR UPDATE)`. Listed only to scope FR-007 invariant `available = stock - reservedAmount` not from `rl:*`.

### 1.3 `Product` (`src/modules/products/entities/product.entity.ts`)

```text
Product
-------
id          uuid PK
name        varchar @Unique
slug        varchar @Unique
description text nullable
price       int CHECK >=0
```

**Phase 10 delta**: GraphQL mutations `createProduct/updateProduct/etc` gain **per-admin** throttling `rl:products:mutation:user:<adminSub> → 30/h` via `ProductsResolver` guard. Product `price` unchanged; cache `product:{id}`/`products:list:*` from Phase 9 remains with fail-open coexisting with limiter.

---

## 2. New/Derived Models (not tables)

### 2.1 `RateLimitBucket` (derived, evictable, in Redis via `CACHE_MANAGER`)

Not a table. Redis `CacheManager` store (`createKeyv(REDIS_URL)` ioredis) ephemeral keyspace `rl:`:

```text
rl:{METHOD} {PATH}:{DIMENSION}:{VALUE} → count:number  TTL = windowMs

Examples:
  rl:POST /auth/login:ip:1.1.1.1                          → 7  (window 3600_000, max 10)
  rl:POST /auth/forgot-password:email:alice@example.com    → 2  (max 3)
  rl:POST /auth/forgot-password:ip:1.1.1.1                 → 4  (max 5, second bucket)
  rl:POST /order/checkout:user:3f7c...                     → 10 (max 10)
  rl:POST /order/:id/complete:user:3f7c...                 → 3  (max 10)
  rl:POST /cart:user:3f7c...                               → 60 (max 60 shared with PATCH/DELETE)
  rl:products:mutation:user:<adminUuid>                    → 30 (max 30)
```

**Behavior**: Fixed-window counter. On activation `count = (get(key)||0)+1; set(key,count,windowMs)`. On new window expiry key auto-deletes. **Loss-tolerant**: `FLUSHDB` resets all quotas but never corrupts orders. Not `CHECK`/`FK`; unique per `METHOD PATH DIM VALUE`. Two buckets for `forgot-password` (IP+email) and `otp/request` (IP+phone) are two keys checked in same `canActivate`; either exceeding → `429`.

Constraints: key built by pure `buildRateLimitKey(routeKey, dim, value)`; `email` lowercased, `phone` raw, `ip` via `x-forwarded-for` first-value trimmed else `req.ip` else `unknown`, `user` via `req.user.sub else ip`. Window clamped `≥60_000` else fallback `3600_000`+`warn`. Count is `int` but not DB `CHECK`.

State diagram (per-key):

```text
FIRST request for key ──get miss→ count 1 → set TTL windowMs → allow (Remaining max-1)
    │
    ├─ 2..max: get→ +1 → set → allow (Remaining max-count)
    │
    └─ max+1: get→ +1 → set → 429 Retry-After:=ceil(windowMs/1000), X-RateLimit-Remaining 0
           │
           └─ window expiry (TTL) → key deleted → next request is FIRST again
```

### 2.2 `RateLimitGuard` (shared, not a table)

`Injectable CanActivate` at `src/modules/auth/guards/rate-limit.guard.ts` (owned by `AuthModule`, exported):

```text
RateLimitGuard
--------------
injected: @Inject(CACHE_MANAGER) cache: Cache, ConfigService config, Logger logger
exposed: LIMITS: Record<string,{max:number, windowMs:number}>  // per-route, defaults FR-002 + ConfigService override
         canActivate(context: ExecutionContext): Promise<boolean>
         getLimitsForRoute(routeKey: string): Array<{max,windowMs,dim}>
         buildRateLimitKey(routeKey: string, dim: string, value: string): string // "rl:{routeKey}:{dim}:{value}"
         extractIp(req: Request): string // x-forwarded-for→req.ip→unknown
         extractEmail/Phone/User(req): string|null // lowercased, null if absent
         toTooManyException(key: string, limit: number, windowMs: number): HttpException // Retry-After + X-RateLimit-*

Routes wired: POST /auth/* (existing), POST /order/checkout (+alias), POST/PATCH /order/:id/complete, POST/PATCH/DELETE /cart, products:mutation GraphQL.

Guards applied in controllers/resolvers via @UseGuards(RateLimitGuard) per route or per controller (outermost before @Auth/JwtGuard). No business logic migrated.
```

Lifecycle: Instantiated once per `AuthModule`; per request `canActivate` does 1-2 `get/set` (success) with fail-open `try/catch`. No DB writes; no entity side-effect; idempotent across retries within window (+1 each).

### 2.3 `RateLimitConfig` (env-driven, not a table)

```text
ORDER_CHECKOUT_RL_MAX              string env → number, default "10"
ORDER_CHECKOUT_RL_WINDOW_MS        string → ms, default "3600000", clamped >=60000
ORDER_COMPLETE_RL_MAX              default "10"
ORDER_COMPLETE_RL_WINDOW_MS        default "3600000"
CART_RL_MAX                        default "60"
CART_RL_WINDOW_MS                  default "3600000"
PRODUCT_MUTATION_RL_MAX            default "30"
PRODUCT_MUTATION_RL_WINDOW_MS      default "3600000"
RATE_LIMIT_FAIL_OPEN_METRIC        string → "auth_rate_limit_fallback_total" placeholder
REDIS_URL / REDIS_HOST / REDIS_PORT existing (src/app.module.ts:36, 45-55) — reuse, never hardcode new client
```

All via `ConfigService.get<string>('ORDER_CHECKOUT_RL_MAX')` → `parseInt` with NaN fallback to FR-002 defaults + `Logger.warn Invalid rate-limit config ... fallback ...`. Guard logs once on first activation `Logger.log RateLimit guards: auth 5-20/h, checkout 10/h/user, cart 60/h/user, product 30/h/admin (REDIS_URL <set>, distributed)`.

### 2.4 `RequestContext` (ephemeral, HTTP, not persisted)

```text
RequestContext (per-request)
-----------------------------
req.method         string // GET, POST, PATCH, DELETE
req.route.path     string // e.g., "/auth/login" via req.route?.path || req.path || GqlExecutionContext info.fieldName→mapped guard key "products:mutation"
req.headers['x-forwarded-for'] string | undefined
req.ip             string
req.body           { email?: string, phoneNumber?: string, ... } // for per-email/phone bucket
req.user           { sub: string, role: UserRoles, ... } | undefined // set by JwtGuard but guard reads via Gql fallback req.user?.sub ?? ip
res                express.Response // for res.setHeader('X-RateLimit-*')

For GraphQL: context = GqlExecutionContext.create(ctx).getContext().req || ctx.switchToHttp().getRequest()
```

Not a table; validated by global `ValidationPipe` before controller but counter increments on **attempt** (pre-validation) per Edge Case.

---

## 3. Relationships & Indexes (Phase 10 reuse, no new PG index)

```text
User 1──0..∞ Order (FK userId, no throttle FK)
User 1──1 Cart (via userId)
RateLimitBucket (Redis, rl:* →count)  *──1 RequestContext  (derived, not FK)
RateLimitBucket ──not─→ Inventory/Reservation (isolated, never shared key)
Order ──depends on── RateLimitGuard (gate before transaction, not FK)
Cart  ──depends on── RateLimitGuard
Product (cache products:list:*) vs RateLimitBucket (rl:*) — separate namespaces "products:" vs "rl:" no collision
```

No new PG index. If `Order.userId` index not yet used for FK, reuse existing; no throttle-specific DB index needed. Counters live in Redis with TTL auto-eviction, no scan required.

---

## 4. Validation Rules (from FRs)

- `CACHE_MANAGER.get/set` key must be `rl:` prefixed string; crafting via helper not raw concatenation.
- Route absent from `LIMITS` map → guard returns `true` instantly (no Redis I/O) — covers `GET /products` not throttled.
- Limit path: `max = parseInt(env ?? default,10); if !isFinite(max) || max<=0 → fallback default + warn`.
- Window path: `windowMs = parseInt(env ?? 3600000,10); if !isFinite(windowMs) || windowMs<60000 → fallback 3600000 + warn`.
- `429` shape via `HttpException` `429` + `ex.options.headers { 'Retry-After': String(ceil(windowMs/1000)), 'X-RateLimit-Limit': String(limit), 'X-RateLimit-Remaining':'0' }`; success via `res.setHeader` per B1.
- **Never** `get/set` inside `OrderCheckoutService`/`OrderCompletionService`/`CartService`/`InventoryService` — enforced by spy in SC-007.

---

## 5. State Diagrams

```text
Guard activation (pre-transaction):
  Request ──RateLimitGuard.canActivate (outermost)──▶ routeKey in LIMITS? no → allow → JwtGuard/Auth → controller → transaction
                                         │
                                         └─yes → for each bucket(dim,value):
                                                try { count=(get||0)+1; set(count,TTL) } catch → warn fail-open → allow
                                                if count > max → 429 Retry-After
                                                else setHeader X-RateLimit-Limit/Remaining → check next bucket → all pass → allow
```

---

## 6. No Migration

Phase 10 requires **0 migrations**. Counters are ephemeral `rl:*` in Redis. If future Phase needs persisted limits per user, that migration is separate. Keep `synchronize:false`.
