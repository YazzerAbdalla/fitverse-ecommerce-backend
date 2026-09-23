# Research: Rate Limiting / Distributed Throttling (Phase 10)

**Branch**: `010-rate-limiting` | **Date**: 2026-09-22 | **Spec**: [spec.md](./spec.md) | **Plan**: [plan.md](./plan.md)

All `NEEDS CLARIFICATION` from Technical Context resolved (0). Spec Session 2026-09-22 provides 5 clarifications. Research consolidates best practices and rejected alternatives for distributed fixed-window throttling with shared Redis and fail-open.

---

## D1: Redis primitive — `get → count+1 → set TTL windowMs` tolerated race vs `INCR + EXPIRE` atomic

- **Decision**: V1 keeps **`cache.get(key) → +1 → cache.set(key, count, windowMs)`** via `CACHE_MANAGER` (`cache-manager` + `@keyv/redis` ioredis) matching `src/modules/auth/guards/rate-limit.guard.ts:44-46` (`get ||0 +1`, `set(key,count,cfg.windowMs)`). Tolerates race on last permit (two concurrent reads of `9` both set `10`, allowing 11th). Plan allows tightening to atomic **`store.client.incr(key) + expire`** via `((cache as any).store?.client?.incr(key) ?? incr via ioredis)` without changing spec (behavior tightens, SCs still pass). No `INCR` on first hit without `EXPIRE` — always set TTL on write.
- **Rationale**: Preserves byte-equality with `005-auth-upgrades` guard (SC-008 non-regression). `cache-manager` abstraction hides ioredis; `CACHE_MANAGER` global `createKeyv(REDIS_URL)` already exposes `Cache` `get/set` that maps to Redis `GET`/`SET EX`. Race on single counter is acceptable because throttling is not financial consistency (unlike `Inventory` `FOR UPDATE` which is strict). Upgrading to `client.incr` is a one-line `try` improvement in plan Phase 1 without spec change, improving precision at scale.
- **Alternatives considered**:
  - Always `INCR+EXPIRE` via raw `ioredis` client — viable tighten, but requires reaching into `Keyv` private `client`; deferred to plan as optional tighten rather than mandated change (keeps CI in-memory fallback working).
  - Lua fixed-window `EVAL` or token-bucket `CL.THROTTLE` — rejected: over-engineered for V1 quotas (10/h), adds `scripts` maintenance; deferred to out-of-scope sliding-window Phase.
  - `@nestjs/throttler` (`ThrottlerGuard`) — rejected: would duplicate guard and its `throttler` storage contract; existing custom `RateLimitGuard` already ships B1 headers and per-email/phone two-bucket; no reason to add `@nestjs/throttler` dep per impressions at `docs/plan.md:2546`.

---

## D2: Limits — auth 5-20/h + checkout/complete 10/h/user + cart 60/h/user + product 30/h/admin via `ConfigService` clamped

- **Decision**: Carry exact `005-auth-upgrades` `LIMITS` (`forgot 5/IP+3/email`, `reset/validate 10/IP`, `otp/request 5/phone+10/IP`, `otp/verify 10/phone`, `google/callback 20/IP`, `login/register 10/IP`) plus new entries: `POST /order/checkout` + alias `POST /order` `10/h per user else IP` (`ORDER_CHECKOUT_RL_MAX` default 10, `ORDER_CHECKOUT_RL_WINDOW_MS` 3600_000), `POST/PATCH /order/:id/complete` `10/h per user` (`ORDER_COMPLETE_RL_MAX`), `POST /cart` `60/h per user` (`CART_RL_MAX`), `PATCH /cart/increase|decrease` + `DELETE /cart*` sharing same `60/h per user` bucket, `products:mutation` (GraphQL `createProduct/updateProduct/etc`) `30/h per admin user else IP` (`PRODUCT_MUTATION_RL_MAX`). Windows default `3600_000` ms, read via `ConfigService.get<string|number>` → `parseInt` clamped `windowMs >= 60_000` else fallback + `Logger.warn Invalid rate-limit window ...`.
- **Rationale**: `docs/plan.md` Phase 10 `Remaining work: Define protected endpoints / Define limits per endpoint`. Quotas allow normal shopping (add to cart dozens of times browsing) while breaking brute-force (login 10/h) and checkout spam that would hold `FOR UPDATE` locks. Per-user for checkout/cart vs per-IP for auth matches ownership: checkout belongs to `req.user.sub` (or IP fallback when JWT absent), auth anonymous is IP-based. Config via `ConfigService` follows `AGENTS.md` Configuration never hardcode hosts/limits. Previous PRD-style `005-auth-upgrades` research set `forgot 5/3` as baseline; kept.
- **Alternatives considered**:
  - Uniform `10/h` for all writes — rejected: would break cart UX (60/h desired).
  - Per-IP for checkout — rejected: same IP with multiple users (office NAT) would collide; per-user isolated per SC-003/SC-004.
  - Checkout `3/h` aggressive — rejected: would break test bursts (`checkout x11` legitimate in integration) and normal retries after `400 empty cart`.
  - Hardcoded `const LIMITS = {... max:10 ...}` literal only — rejected: violates `ConfigService` rule; kept as defaults with env override.

---

## D3: Keys — `rl:{METHOD} {PATH}:{DIM}:{VALUE}` with `x-forwarded-for` → `ip` + `email/phone` lowercase + `user.sub else ip`

- **Decision**: Deterministic pattern (FR-004) e.g., `rl:POST /auth/login:ip:1.1.1.1`, `rl:POST /auth/forgot-password:email:alice@example.com` (lowercased), `rl:POST /auth/otp/request:phone:+15551234`, `rl:POST /order/checkout:user:<uuid-sub>` else `:ip:<ip>` fallback, `rl:products:mutation:user:<uuid>`. Helpers `buildRateLimitKey(routeKey, dim, value)`, `extractIp(req): string` (`(headers['x-forwarded-for']?.split(',')[0].trim()) || req.ip || 'unknown'`), `extractEmail/Phone` from `req.body`, `getClientIdentity` (`req.user?.sub ?? ip`). No `user` key when `req.user` absent. Prefix `rl:` isolates from `expiration:*` and `products:*` namespaces.
- **Rationale**: Matches `src/modules/auth/guards/rate-limit.guard.ts:17-28` existing pattern (`rl:${routeKey}:ip:${ip}`, `:email:${email}`, `:phone:${phone}`). Uses `req.route?.path || req.path` mapping already (`rate-limit.guard.ts:37`). Lowercasing email prevents bypass via case. First `x-forwarded-for` value + trimming handles proxy chains; fallback guarantees deterministic key even when header absent. Isolation per SC-001–SC-004 (different IPs → different counters, different users → different checkout counters).
- **Alternatives considered**:
  - Key includes `role` or `query` — rejected: adds cardinality, not needed for per-user isolation.
  - Hash `email`/`phone` in key (privacy) — optional but not required V1; `Logger.warn` hashes never leak raw value anyway.
  - Use `req.headers['x-real-ip']` — rejected: non-standard, `x-forwarded-for` canonical.

---

## D4: Distributed — Yes via shared `CACHE_MANAGER` `REDIS_URL` vs in-memory fallback

- **Decision**: `RateLimitGuard` MUST use shared `CACHE_MANAGER` store backed by `@keyv/redis` + `ioredis` (same connection as `CacheModule.registerAsync` `createKeyv(REDIS_URL)` in `src/app.module.ts:36-43` and `BullMQ` shared `REDIS_URL`). Two instances with identical `REDIS_URL` share `rl:*` keys. When `REDIS_URL` is empty/undefined, `createKeyv(undefined)` falls back to in-memory `cache-manager` per-instance; guard logs `Logger.warn Redis URL not set, using in-memory rate limit (non-distributed)` and still functions per-instance (CI passes). No second ioredis client introduced.
- **Rationale**: `docs/plan.md` Phase 10 `Use Redis for shared state when multiple API instances`. Reuse existing infra per `AGENTS.md` Infrastructure `docker-compose up -d` (redis:8). Keeps cost 0 new connections. Cross-instance test via two `RateLimitGuard` instances sharing same `Cache` provider (unit shared Map, integration real Redis `FLUSHDB`) validates distribution SC-006. In-memory fallback documents non-distributed behavior for CI without Redis, avoiding `ECONNREFUSED` crash.
- **Alternatives considered**:
  - New dedicated `ioredis` client `new Redis(REDIS_URL)` for `rl:*` — rejected: doubles connections, diverges from product cache store; reuse `CACHE_MANAGER`.
  - `@nestjs/throttler` distributed storage — rejected: adds dep and storage contract mismatch.
  - Global `Map` per-process only — rejected: would violate Phase 10 distribution requirement, allowing N× quota with N instances.

---

## D5: Fail-open — every `get/set` in `try/catch` with `Logger.warn` + `Retry-After`+`X-RateLimit-*`

- **Decision**: Every `cache.get`/`cache.set` (and future `store.client.incr`) wrapped `try { ... } catch (e) { this.logger.warn(`RateLimit Redis fail-open for ${routeKey}: ${e}`); /* metric auth_rate_limit_fallback_total++ placeholder */ }` and returns `true` (allow). Success sets `res.setHeader('X-RateLimit-Limit', max)` + `X-RateLimit-Remaining` remains; failure on either IP or per-email bucket still allows (any Redis error → allow). `429` carries `Retry-After: floor(windowMs/1000)=3600` + `X-RateLimit-Limit/Remaining:0` via `HttpException.options.headers` so `AllExceptionsFilter` serializes and Swagger annotates `429`. No `500` on `ECONNREFUSED`.
- **Rationale**: Constitution Additional Constraints “Rate limiting MUST never compromise transactional correctness; use Redis only for shared limiter state” + Phase 9/5 precedent `Cache SET failed` + `RateLimit Redis fail-open` via `cacheManager.get/set` throwing → `warn + fallback`. Availability outweighs strict limiter during degraded Redis (SC-005). B1 `0020-RBAC` ADR full headers already settled (`Retry-After`+`X-RateLimit-*`).
- **Alternatives considered**:
  - Fail-closed (`throw 503`) — rejected: would take down checkout/catalog during Redis outage, contradict SC-005.
  - No header on success — rejected: B1 requires `X-RateLimit-Limit/Remaining` for client observability.
  - Swallow silently — rejected: no metric/logging hides degraded mode.

---

## D6: Guard outermost — before `JwtGuard`/`RolesGuard` and before `DataSource.transaction` never inside

- **Decision**: `RateLimitGuard` is outermost `UseGuards(RateLimitGuard, JwtGuard)` / `@Auth()` order in `src/modules/order/order.controller.ts` and `src/modules/cart/cart.controller.ts`. For resolver, `@UseGuards(RateLimitGuard)` on mutations, extracting `req` via `GqlExecutionContext.create(context).getContext().req` fallback to `context.switchToHttp().getRequest()`. Zero `cache.get/set` inside `OrderCheckoutService`/`OrderCompletionService`/`CartService`/`InventoryService`; they remain pure `dataSource.transaction(async manager => ... FOR UPDATE)`. Integration spy `dataSource.transaction` 0 calls on `429` proves invariant SC-007.
- **Rationale**: Keeps checkout/complete lock window minimal (spec Fr-007 P0 invariant). If guard were inside transaction, `429` would already hold `FOR UPDATE` and waste lock. Pre-transaction gate mirrors inventory reservation pattern `lock → check available → reservedAmount++` short tx. Existing `auth.controller.ts:39` already uses `@UseGuards(RateLimitGuard, LocalAuthGuard)` with rate outermost; reuse order.
- **Alternatives considered**:
  - Guard inside service (call `RateLimitGuard` from `OrderCheckoutService.checkout`) — rejected: mixes cross-cutting concern with domain, would require cache I/O inside tx scope.
  - Global `APP_GUARD ThrottlerGuard` around all routes — rejected: would throttle reads `GET /products` at same strict 10/h; spec FR-001 scoped per-route instead.

---

## Risk Mitigations

- **Non-atomic race on last permit**: Two concurrent `get(9)+set(10)` allows 11th — mitigated by noting V1 tolerance (throttling not financial) and optional atomic `client.incr` tighten later; probe via `jest` concurrency `Promise.all` in unit.
- **In-memory fallback non-distributed CI**: Detected by `REDIS_URL` check + log; integration uses shared `Map` to still validate fail-open and per-route logic; not considered distributed in CI docs.
- **Header propagation via exception filter**: `AllExceptionsFilter` must forward `ex.options.headers` to response; verified in `005-auth-upgrades` E2E already.

## Open items to verify in implementation

- Confirm `Cache` type is `import { Cache } from 'cache-manager'` via `@nestjs/cache-manager` `CACHE_MANAGER` (already `rate-limit.guard.ts:11`).
- Confirm `ConfigService` parsing path `ORDER_CHECKOUT_RL_MAX` etc via `configService.get<string|number>` → `parseInt` with NaN clamp.
- Confirm `ExecutionContext` `GqlExecutionContext` import for resolver guard (`@nestjs/graphql`), fallback `switchToHttp` for REST, and `req.route?.path || req.path` mapping correctness for `POST /order/checkout` alias.
- Confirm `POST /order/checkout` per-user bucket uses `req.user?.sub` else `ip` fallback (auth `JwtGuard` may not have populated `req.user` when guard first; ordering test needed).
