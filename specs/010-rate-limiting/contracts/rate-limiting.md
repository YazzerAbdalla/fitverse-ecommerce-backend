# Contract: Rate Limiting / Distributed Throttling (Phase 10)

**Branch**: `010-rate-limiting` | **Spec**: [spec.md](../spec.md) | **Plan**: [plan.md](../plan.md)

REST + GraphQL throttling contract for abuse-prone writes. E2E verified with `supertest` + real Redis `FLUSHDB` or shared Map.

---

## 1. Protected Routes & Limits

| Method | Path / Field | Auth | Dimension | Limit / Window | Key | 429 Headers |
|--------|--------------|------|-----------|----------------|-----|-------------|
| POST | `/auth/forgot-password` | public | IP | 5/hour | `rl:POST /auth/forgot-password:ip:<ip>` | `Retry-After:3600 X-RateLimit-Limit:5 Remaining:0` |
| POST | `/auth/forgot-password` | public | email | 3/hour | `rl:POST /auth/forgot-password:email:<email:lc>` | `Limit:3` |
| POST | `/auth/reset-password` | public | IP | 10/hour | `rl:POST /auth/reset-password:ip:<ip>` | `Limit:10` |
| POST | `/auth/validate-reset-token` | public | IP | 10/hour | `rl:POST /auth/validate-reset-token:ip:<ip>` | `Limit:10` |
| POST | `/auth/otp/request` | public | phone | 5/hour (+ IP 10/h) | `rl:POST /auth/otp/request:phone:<phone>` + `...:ip:<ip>` | `Limit:5` / `Limit:10` |
| POST | `/auth/otp/verify` | public | phone | 10/hour | `rl:POST /auth/otp/verify:phone:<phone>` | `Limit:10` |
| GET | `/auth/google/callback` | public | IP | 20/hour | `rl:GET /auth/google/callback:ip:<ip>` | `Limit:20` |
| POST | `/auth/login` | public | IP | 10/hour | `rl:POST /auth/login:ip:<ip>` | `Limit:10` |
| POST | `/auth/register` | public | IP | 10/hour | `rl:POST /auth/register:ip:<ip>` | `Limit:10` |
| POST | `/order/checkout` (+ alias `POST /order`) | `JwtGuard @Auth()` | user(`sub`) else IP | 10/hour (`ORDER_CHECKOUT_RL_MAX`) | `rl:POST /order/checkout:user:<uuid>` | `Limit:10` |
| POST | `/order/:id/complete` + `PATCH /order/:id/complete` | `JwtGuard @Auth()` | user | 10/hour (`ORDER_COMPLETE_RL_MAX`) | `rl:POST /order/:id/complete:user:<uuid>` | `Limit:10` |
| POST | `/cart` | `@Auth(User)` | user else IP | 60/hour (`CART_RL_MAX` shared) | `rl:POST /cart:user:<uuid>` | `Limit:60` |
| PATCH | `/cart/increase` | `@Auth(User)` | user | 60/hour shared | `rl:PATCH /cart/increase:user:<uuid>` | `Limit:60` |
| PATCH | `/cart/decrease` | `@Auth(User)` | user | 60/hour shared | `rl:PATCH /cart/decrease:user:<uuid>` | `Limit:60` |
| DELETE | `/cart/:cartItemId` | `@Auth(User)` | user | 60/hour shared | `rl:DELETE /cart:user:<uuid>` | `Limit:60` |
| DELETE | `/cart` | `@Auth(User)` | user | 60/hour shared | `rl:DELETE /cart:user:<uuid>` | `Limit:60` |
| Mutation | `createProduct` `createMany` `updateProduct` `updateMany` `removeProduct` `removeAllProducts` (GraphQL via `ProductsResolver`) | `JwtGuard @Auth(Admin)` | admin user else IP | 30/hour (`PRODUCT_MUTATION_RL_MAX`) | `rl:products:mutation:user:<adminUuid>` | `Limit:30` |
| POST | `/inventory/:productId/increase|decrease` | `@Auth(Admin?)` | admin user | 30/hour same bucket | `rl:products:mutation:user:<adminUuid>` | `Limit:30` |

Excluded: `GET /products` `GET /product/:id` `GET /cart` `GET /order` — not throttled at strict limits (reads `200` even after writes `429`).

---

## 2. Request/Response Shape

### 2.1 Success (under limit)

```
Request:  POST /auth/login {email,password}  with X-Forwarded-For: 1.1.1.1
Response: 200 {accessToken} plus headers
  X-RateLimit-Limit: 10
  X-RateLimit-Remaining: 7   // max - currentCount
  (optional) X-RateLimit-Reset: <epochSec when window resets>
No body change.

Same for authenticated:
Request:  POST /order/checkout {}  with Authorization: Bearer <jwt sub:A>
          POST /cart {productId, quantity:1}
Response: 201 {id,status:PENDING...} / 201 {cartId}  + headers above
```

For GraphQL via `POST /graphql` `mutation { createProduct(...) }`, same headers on HTTP response when resolver maps `info.fieldName` → `products:mutation` bucket; if mapping not ready, contract still verified via REST inventory mutation path.

### 2.2 Throttled (exceeds)

```
Request:  11th POST /auth/login same IP within hour
Response: 429
  Headers: Retry-After: 3600
           X-RateLimit-Limit: 10
           X-RateLimit-Remaining: 0
  Body: { statusCode: 429, message: "Too Many Requests", timestamp: "2026-09-22T...Z" }
        // via AllExceptionsFilter, never plain object
Controller/service not called (DataSource.transaction 0 calls).
```

For `POST /auth/forgot-password` with two buckets, whichever exceeded sets its `Limit` (3 for email vs 5 for IP) — see SC-002.

### 2.3 Fail-open (Redis down)

```
Given CACHE_MANAGER.get/set throws EconNREFUSED
When POST /auth/login or POST /order/checkout or POST /cart or createProduct
Then 200/201 from DB, Body normal, Logger.warn "RateLimit Redis fail-open for <routeKey>: <msg>"
     No 500, no 429, headers may be absent but not required.
```

---

## 3. Auth & Guards Order

```
CanActivate order per route:
  RateLimitGuard (outermost, before JwtGuard)
    ↓ (true)
  JwtGuard / LocalAuthGuard / GoogleAuthGuard / RolesGuard (via @Auth)
    ↓
  Controller/Resolver (thin) → Service (business + DataSource.transaction FOR UPDATE)
```

Example controller wiring:

```ts
@Post('checkout')
@UseGuards(RateLimitGuard)           // 1st
@Auth()                               // 2nd (JwtGuard+RolesGuard)
@ApiBearerAuth('JWT-auth')
@ApiResponse({ status:429, description:'Too Many Requests — Retry-After: 3600' })
async checkout(@CurrentUser('sub') userId: string) { return this.orderCheckoutService.checkout(userId); }
```

GraphQL resolver:

```ts
@Mutation(() => Product)
@UseGuards(RateLimitGuard)
updateProduct(@Args('id') id: string, @Args('updateProductInput') input: UpdateProductInput) {
  return this.productsService.update(id, input);
}
// guard extracts req via GqlExecutionContext.create(ctx).getContext().req || ctx.switchToHttp().getRequest()
```

---

## 4. Limits Config

All limits via `ConfigService.get<string>('ORDER_CHECKOUT_RL_MAX')` etc with FR-002 defaults and clamped `windowMs >= 60_000`. Will not duplicate `.env` values — reference.

---

## 5. Test Snippets

### 5.1 Unit (mocked `CACHE_MANAGER`)

```ts
const mockCache = { get: jest.fn().mockResolvedValue(0), set: jest.fn().mockResolvedValue(undefined) };
const module = await Test.createTestingModule({
  providers: [RateLimitGuard, { provide: CACHE_MANAGER, useValue: mockCache }, { provide: ConfigService, useValue: { get: (k) => defaults[k] } }, Logger],
}).compile();
guard = module.get(RateLimitGuard);
// first 10 → true, 11th throw { get:429, options:{headers:{'Retry-After':'3600'}} }
```

### 5.2 Integration (real Redis)

```ts
// FLUSHDB, call canActivate 11x same IP/user, 11th expect HttpException 429
// two guards share same provider .store -> distributed cross-instance count 61 → 429
// fail-open: const failingGuard = module.get(RateLimitGuard); jest.spyOn(cache,'get').mockRejectedValue(new Error('ECONNREFUSED'));
```

### 5.3 E2E (`supertest`)

```ts
const login = await request(app).post('/auth/login').set('X-Forwarded-For','1.1.1.1').send({email, password});
for(let i=0;i<10;i++) await request(app).post('/auth/login').set('X-Forwarded-For','1.1.1.1').send({email,password});
const r = await request(app).post('/auth/login').set('X-Forwarded-For','1.1.1.1').send({email,password});
expect(r.status).toBe(429);
expect(r.headers['retry-after']).toBe('3600');
```

---

## 6. Non-Goals

- No sliding-window/Lua, no global reads throttling, no payment/refresh-token 429 extension beyond existing `005-auth-upgrades`.
