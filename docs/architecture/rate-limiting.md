# Rate Limiting — Phase 10

Per-route fixed-window throttling via shared Redis `CACHE_MANAGER` (`@keyv/redis` ioredis, `createKeyv(REDIS_URL)`). Fail-open on Redis down.

## Protected Routes

| Route | Dim | Limit | Key | Headers |
|------|-----|-------|-----|---------|
| `POST /auth/forgot-password` | IP | 5/h | `rl:POST /auth/forgot-password:ip:<ip>` | `Retry-After:3600` |
| `POST /auth/forgot-password` | email | 3/h | `rl:...:email:<lc>` | Limit 3 |
| `POST /auth/reset-password` | IP | 10/h | `rl:POST /auth/reset-password:ip:<ip>` | Limit 10 |
| `POST /auth/validate-reset-token` | IP | 10/h | `rl:...:ip:<ip>` | Limit 10 |
| `POST /auth/otp/request` | phone 5/h + IP 10/h | — | `rl:POST /auth/otp/request:phone:<phone>` + `...:ip:` | 5 / 10 |
| `POST /auth/otp/verify` | phone | 10/h | `rl:...:phone:<phone>` | Limit 10 |
| `GET /auth/google/callback` | IP | 20/h | `rl:GET /auth/google/callback:ip:<ip>` | Limit 20 |
| `POST /auth/login` | IP | 10/h | `rl:POST /auth/login:ip:<ip>` | Limit 10 |
| `POST /auth/register` | IP | 10/h | `rl:POST /auth/register:ip:<ip>` | Limit 10 |
| `POST /order/checkout` + alias `POST /order` | user else IP | 10/h (`ORDER_CHECKOUT_RL_MAX`) | `rl:POST /order/checkout:user:<sub>` | Limit 10 |
| `POST/PATCH /order/:id/complete` | user | 10/h (`ORDER_COMPLETE_RL_MAX`) | `rl:POST /order/:id/complete:user:<sub>` | Limit 10 |
| `POST /cart` `PATCH /cart/increase|decrease` `DELETE /cart*` | user | 60/h shared (`CART_RL_MAX`) | `rl:POST /cart:user:<sub>` | Limit 60 |
| `products:mutation` (GraphQL `createProduct/updateProduct...`) + `POST /inventory/:productId/increase|decrease` | admin user | 30/h (`PRODUCT_MUTATION_RL_MAX`) | `rl:products:mutation:user:<adminUuid>` | Limit 30 |

Excluded: `GET /products`, `GET /product/:id`, `GET /cart`, `GET /order` not throttled strict.

## Keys

`rl:{METHOD} {PATH}:{dim}:{value}` — `rl:` isolates from `expiration:*` and `products:*`. `ip = (x-forwarded-for.split(',')[0].trim()) || req.ip || unknown`; `email` lowercased; `user = req.user.sub ?? ip` for order/cart/product. Built via `buildRateLimitKey()` helper.

## Distributed vs In-Memory

- `REDIS_URL` set → `CACHE_MANAGER` shared store, two instances agree (A 5 + B 55 → B 61st 429).
- `REDIS_URL` empty → in-memory `cache-manager` fallback, log `Redis URL not set, using in-memory rate limit (non-distributed)` — per-instance counts.

## Fail-Open

Every `cache.get/set` wrapped `try/catch → Logger.warn RateLimit Redis fail-open for <routeKey>: <msg>` + allow. No `500`. Also metric placeholder `auth_rate_limit_fallback_total`.

## Guard Order

`RateLimitGuard` outermost before `JwtGuard`/`RolesGuard` (`@UseGuards(RateLimitGuard) @Auth()`), never inside `DataSource.transaction`. Therefore `429` never holds `FOR UPDATE` lock — spy `transaction` 0 calls.

## Headers

- Success: `X-RateLimit-Limit: <max>` + `X-RateLimit-Remaining: <max-count>`
- Throttled: `429` with `Retry-After: 3600` (= ceil(windowMs/1000)) + `X-RateLimit-Limit` + `X-RateLimit-Remaining: 0` via `HttpException.options.headers`, propagated by `AllExceptionsFilter.setHeader`. Swagger lists `429 Too Many Requests — Retry-After: 3600`.

## Config

Via `ConfigService.get('ORDER_CHECKOUT_RL_MAX')` etc, fallback to defaults in `DEFAULT_LIMITS`, clamped `windowMs >= 60000` else warn + fallback.

## Auth Module Export

`AuthModule` now exports `RateLimitGuard` (`exports: [AuthService, RateLimitGuard]`) so `OrderModule`, `CartModule`, `ProductsModule` import `AuthModule` to get guard DI without circular deps.

## Testing

- Unit `src/modules/auth/guards/rate-limit.guard.spec.ts` (mock `CACHE_MANAGER.get/set`, `ExecutionContext` req/res) covers 10→429, forgot 3/5 dual, order 10/user isolation, cart 60 shared, product 30/admin via `GqlExecutionContext` mock, fail-open throw→true, headers.
- Integration `FLUSHDB` verifies real Redis cross-instance shared counter and Redis-down warn.
- E2E `supertest` bursts x11/x61 and header presence.
