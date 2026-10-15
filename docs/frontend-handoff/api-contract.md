# API Contract (verified against code)

Conventions: base `REST_API_BASE_URL` (default `http://localhost:3000`), GraphQL `GRAPHQL_ENDPOINT` (`…/graphql`), Swagger UI `/api`. Auth header `Authorization: Bearer <accessToken>` unless "public". `credentials:'include'` always (refresh cookie). Optional `x-request-id` / `x-correlation-id` on order/payment writes (server generates `randomUUID()` otherwise). Wire statuses are real: Nest `POST→201` unless `@HttpCode` noted; DTO routes 400 on unknown fields; DTO-less routes (checkout/complete/cancel) ignore extras.

## REST

### API-REST-001 `POST /auth/register` (public, RL 10/h/IP)
Body: `{firstName!:string≤30, lastName!:string≤30, email!:IsEmail, password!:string≥8, marketingOptIn?:bool, emailOptIn?:bool}`. 201 `{message:'User created successfuly.', data:SafeUser}`. Errors: 400 validation/dup (`'This email already exist.'`), 409 race, 429. Ev: `auth.controller.ts:104`, `user-register.dto.ts:15-44`.

```json
// POST /auth/register
{"firstName":"Alaa","lastName":"Test","email":"a@test.com","password":"Password123!"}
// → 201 {"message":"User created successfuly.","data":{"id":"…","firstName":"Alaa","lastName":"Test","email":"a@test.com","role":"User","provider":"local","phoneNumber":null,"phoneVerified":false,"emailVerified":false,"marketingOptIn":false,"emailOptIn":true}}
```

### API-REST-002 `POST /auth/login` (public, RL 10/h/IP, `@HttpCode(200)`)
Body `{email!, password!}`. 200 `{message:'User loged in successfuly', accessToken, refreshToken}` + `Set-Cookie: refresh_token=…; HttpOnly; SameSite=Strict; Path=/auth`. Malformed → 400 (guard pre-validates); bad creds → 401. Ev: `auth.controller.ts:124-147`.

### API-REST-003 `POST /auth/refresh` (public, dual RL 10/h/IP + 5/h/hash6)
Body `{refreshToken?:64hex}` — `{}` valid (cookie path `req.cookies.refresh_token` → raw `Cookie` parse; body wins). 201 `{accessToken, refreshToken}` + rotated cookie + maybe `X-Email-Unverified:true`. Errors: 400 (non-hex), 401 `'Invalid or expired refresh token'` (unknown/expired/revoked/reused; reuse also revokes ALL sessions), 429. Single-flight required (concurrent same-token → one 201, rest 401). Ev: `auth.controller.ts:307-340`, `auth.service.ts:312-464`.

### API-REST-004 `POST /auth/logout` (public, RL 20/h/IP)
Body/cookie same optional resolution. Always 201 `{message:'Logged out'}` (idempotent, never 401/404). No server cookie-clear. Ev: `auth.controller.ts:343-357`.

### API-REST-005 `POST /auth/logout-all` (`@Auth()`, RL 10/h/user)
No body; `sub` from JWT. 201 `{message:'All sessions revoked'}` (`tokenVersion++` + bulk revoke). 401/429. Ev: `auth.controller.ts:359-376`.

### API-REST-006 `GET /auth/verify-email?email=&token=` (public, RL 10/h/IP)
Query both required, token 64hex. 200 `{verified:true, emailVerified:true}`. Any failure → 400 `'Invalid or expired verification token'` (never 404). Ev: `auth.controller.ts:199-222`.

### API-REST-007 `POST /auth/verify-email` (public, RL 10/h/IP)
Same DTO in body. Identical semantics; wire **201**. Ev: `auth.controller.ts:224`.

### API-REST-008 `POST /auth/resend-verification` (public, dual RL 5/h/IP + 3/h/email; plus 60s cooldown)
Body `{email!}`. 200-shapes (wire 201): unknown → `'This email is not registered or already verified. If an account exists, a verification email has been sent.'`; verified → `'Email already verified'`; else → `'If an account exists, a verification email has been sent.'`. 429 two flavors: `Retry-After:60` (cooldown) vs `Retry-After:3600` (hourly). Ev: `auth.controller.ts:228-262`, `auth.service.ts:810-867`.

### API-REST-009 `POST /auth/forgot-password` (public, dual RL 5/h/IP + 3/h/email)
Body `{email!}`. Always 201-shape `{message:'If an account exists, a reset link has been sent.'}`. Only 400/429. Ev: `auth.controller.ts:151-165`.

### API-REST-010 `POST /auth/validate-reset-token` (public, RL 10/h/IP) — ADVISORY ONLY
Body `{email!, token:64hex}`. 201 `{valid:true}` vs 400. Never trust for submit. Ev: `auth.controller.ts:167-181`.

### API-REST-011 `POST /auth/reset-password` (public, RL 10/h/IP) — AUTHORITY
Body `{email!, token:64hex, newPassword!:8..72, ≠email}`. 201 `{message:'Password reset successful.'}` + kills all sessions (`tokenVersion++`). Errors 400 (reuse/expired/weak), 429. Ev: `auth.controller.ts:183-197`, `auth.service.ts:602-647`.

### API-REST-012 `GET /auth/google` → 302; API-REST-013 `GET /auth/google/callback` → 200 `{accessToken, refreshToken}` + cookie; API-REST-014 `GET /auth/google/link` (`@Auth()`) → 200 `{message:'Google linked.'}`
Redirect-based (not fetch). Errors: 400 unverified Google email, 409 double-link, 401 OAuth denial. RL 20/h/IP on callback. Ev: `auth.controller.ts:379-427`.

### API-REST-015/016 `POST /auth/otp/request|verify` → unconditional **501** `'WhatsApp OTP not enabled — password login only. TODO future.'` (DTO validated first, so malformed still 400). Do not call. Ev: `auth.controller.ts:278-305`.

### API-REST-017 `GET /users/me` (`@Auth()`)
200 SafeUser `{id,firstName,lastName,email,role,provider,phoneNumber|null,phoneVerified,emailVerified,marketingOptIn,emailOptIn}`. 401/404. Ev: `users.controller.ts:40-58`.

### API-REST-018 `PATCH /users/me/preferences` (`@Auth()`, no RL)
Body `{marketingOptIn?:bool, emailOptIn?:bool}` (either-or; neither → 400). 200 `{marketingOptIn,emailOptIn}`. Ev: `users.controller.ts:68-69`, `users.service.ts:311-341`.

### API-REST-020 `GET /cart` (`@Auth(User)`, no RL)
200 `Cart` (auto-creates). Admin → 403. Ev: `cart.controller.ts:34-43`.

### API-REST-021 `POST /cart` (`@Auth(User)`, RL 60/h/user shared)
Body `{productId!:uuid, quantity!:int≥1}` (extras → 400). Appends or increments. 201 `Cart` (code; Swagger says CartItem — trust code). Errors: 400 qty, 404 product, 409 over-available, 429, 403 Admin. Ev: `cart.controller.ts:45-78`.

### API-REST-022/023 `PATCH /cart/increase|decrease` (`@Auth(User)`, same bucket)
Body `{productId!:uuid, quantity?:int≥1=1}`. 200 `CartItem`. Increase: 409 over-available. Decrease: 400 if result <1 (use remove). 404 not-in-cart. Ev: `cart.controller.ts:80-148`.

### API-REST-024 `DELETE /cart/:cartItemId` (`@Auth(User)`, same bucket)
No validator on param. 200 `Cart`. 404 cart/item missing. Ev: `cart.controller.ts:150-171`.

### API-REST-025 `DELETE /cart` (`@Auth(User)`, same bucket)
200 emptied `Cart` immediately (background delete). Ev: `cart.controller.ts:173-191`.

### API-REST-026 `POST /order/checkout` (`@Auth()`, RL 10/h/user) + API-REST-027 alias `POST /order` (deprecated)
**No body DTO — send `{}`; extras ignored (not 400).** 201 `{id,userId,status:'PENDING',total,createdAt,expiresAt,reservationId,items:[{id,productId,quantity,unitPrice,unit_price,subtotal,productName}]}`. Errors: 400 empty/dup-qty, 404 product/inventory, 409 insufficient/CHECK, 401, 429. Ev: `order.controller.ts:48-109`.

### API-REST-028 `POST /payments/intent` (`@Auth()`, RL 10/h/user, owner-only, `@HttpCode` absent → 201)
Body `{orderId!:uuid}` (extras → 400). Idempotent: same-order PENDING → same row. Errors: 400/401/403 non-owner/404 order/409 non-PENDING-or-terminal/429. Ev: `payment.controller.ts:64-85`.

### API-REST-029 `POST /payments/:id/confirm` (`@Auth()`, RL 10/h/user, `@HttpCode(200)`)
Body `{result!:'success'|'declined', failureReason?:'card_declined'|'insufficient_funds'|'expired_card' (required iff declined)}`. 200 `{payment, order}`: success → SUCCEEDED+COMPLETED; declined → FAILED+FAILED (hold released). Terminal re-confirm → 200 zero-delta (not 409). 400/403/404/429. Ev: `payment.controller.ts:96-124`.

### API-REST-030 `GET /inventory/:productId` (`@Auth()`)
UUID pipe. 200 `{id,productId,stock,reservedAmount,available,createdAt,updatedAt}` (`available=stock−reserved`). 400 bad UUID, 404 no row. Ev: `inventory.controller.ts:32-45`.

### API-REST-031 `GET /inventory/:productId/availability?quantity=` (`@Auth()`)
Same + `quantity:int≥1`. 200 `{available,requested,sufficient}`. 400/404. Ev: `inventory.controller.ts:47-62`.

### API-REST-032/033 `POST /inventory/:productId/increase|decrease` (`@Auth(Admin)`, no RL) — NOT for storefront
Body `{quantity!:int≥1}`. 200 view. Decrease → 409 below-zero/below-reserved. Ev: `inventory.controller.ts:66-107`.

### API-REST-034 `POST /payments/:id/cancel` (`@Auth()`, RL, `@HttpCode(200)`, owner-only)
No body. 200 CANCELLED pair; terminal → 409. Ev: `payment.controller.ts:134-156`.

### API-REST-035 `POST /order/:id/complete` (`@Auth()`, RL 10/h/user) + API-REST-036 `PATCH` alias — ADMIN FALLBACK, not shopper path
No body (extras ignored). 200 enriched order + `reservation` (or null). Idempotent COMPLETED→COMPLETED 200. 403/404/409/429. Ev: `order.controller.ts:123-216`.

### API-REST-037 `POST /order/:id/cancel` (`@Auth()`; guard present but **no route key → effectively unthrottled**)
No body; reason hardcoded `'user'`. 200 `{id,status,total,userId,reason:'user',reservationId}`. Idempotent re-cancel 200. COMPLETED → 409 (no refund). Cart stays cleared. Ev: `order.controller.ts:226-271`.

### API-REST-038 `GET /order?page&limit&status&userId` (`@Auth()`, no RL)
`page` dflt 1, `limit` dflt 20 clamp ≤100 — **no NaN/negative guard** (validate client-side); `status` unvalidated raw string; `userId` Admin-only (non-Admin silently self-scoped, not 403). 200 `{data:[Order+items.product+reservationId+expiresAt], meta}` newest-first. Ev: `order.controller.ts:273-295`, `order.service.ts:38-101`.

### API-REST-039 `GET /order/:id` (`@Auth()`, no RL)
200 single order + items. 403 non-owner, 404. Ev: `order.controller.ts:297-307`.

### API-REST-040 `POST /reservations` — shopper gets deterministic **403** `'Reservation can only be created via POST /order/checkout'` (Admin-only 201). API-REST-041/042 `PATCH /reservations/:id/{complete,cancel}` — shopper **403** `'Reservation transitions via Order lifecycle only'`. Never call as shopper. Ev: `reservation.controller.ts:36-129`.

### API-REST-043 `GET /reservations/:id` (owner-or-Admin) → 200 Reservation+items; API-REST-044 `GET /reservations?page&limit&userId` → 200 `{data,meta}` (`+page` NaN-unguarded, clamp 100; status list RESERVED→COMPLETED|EXPIRED|CANCELLED). No RL. Ev: `reservation.controller.ts:54-77`.

### API-REST-045 `GET /payments?page&limit&status&userId` (`@Auth()`, owner-or-Admin, no RL) — STRICT
Bad page/limit/status → 400 (unlike orders); cross-user list non-Admin → 403. 200 `{data:Payment[], meta}` with `totalPages=0` when empty. `createdAt DESC`. Ev: `payment.controller.ts:169-192`.

### API-REST-046 `GET /payments/:id` → 200 Payment; 403/404. Ev: `payment.controller.ts:202-216`.

### API-REST-047 `GET /notifications?page&limit&isRead&channel&type&userId` (`@Auth()`, no RL)
`limit` 1..100 dflt 20; `channel` case-insensitive SYSTEM|EMAIL; `userId` Admin-only (cross-scope → 403). 200 `{data:Notification[], meta}` newest-first. 400/401/403. Ev: `notifications.controller.ts:127-174`.

### API-REST-048 `GET /notifications/unread-count` → 200 `{unreadCount}`. API-REST-049 `PATCH /notifications/:id/read` → 200 `{id,isRead:true,readAt}` (idempotent; 403/404). API-REST-050 `PATCH /notifications/read-all` → 200 `{updated}`. All `@Auth()`, no RL. Ev: `notifications.controller.ts:187-263`.

### API-REST-051 `POST /admin/notifications/sales` (`@Auth(Admin)`, RL 10/h, `@HttpCode(202)`) + API-REST-052 `POST /admin/notifications/test-email` (same guard) + API-REST-053/054 `GET /admin/outbox` / `PATCH /admin/outbox/:id/requeue` (`@Auth(Admin)`, no RL) — ADMIN/OPS ONLY, never storefront. Ev: `notifications.controller.ts:52-117`, `outbox.controller.ts:30-125`.

## GraphQL (Apollo code-first; public reads; errors → `GraphQLError {extensions.code}`, NOT the REST envelope)

### API-GQL-001 `query products($page:Int=10, $limit:Int=10): ProductPagination!`
No auth. Args `@Min(1)`, no max; key `products:list:v{n}:{page}:{limit}` TTL 60s (min 5s) fail-open; deterministic `created_at ASC, id ASC`. Returns `{data:[Product], meta:{totalItems,itemCount,itemsPerPage,totalPages,currentPage}}`. Ev: `schema.gql:51-54`, `products.resolver.ts:33-36`, `products.service.ts:542-579`.

```graphql
query { products(page:1, limit:10) { data { id name slug description price created_at } meta { totalItems itemCount itemsPerPage totalPages currentPage } } }
```

### API-GQL-002 `query product($id:String!): Product!`
No auth, no validator on `id`. Cache `product:{id}` TTL 300s, no negative cache. Missing → null → GraphQL error (treat as 404). Ev: `schema.gql:52`, `products.service.ts:590-622`.

### API-GQL-003..007 mutations (`createProduct`, `createManyProducts`, `updateProduct`, `removeProduct`, `removeAllProducts`) — EXIST but MUST NOT be exposed in the storefront (RL-only 30/h/admin, no `@Auth()`; `removeProduct` returns `DeleteResult` despite schema; `updateMany` has no resolver). Ev: `schema.gql:21-27`, `products.resolver.ts:16-66`.

## Error reference (REST unless noted)

Envelope `{statusCode, message, timestamp}`; `message` = `exception.getResponse()` (validation keeps nested body). 429 carries `Retry-After + X-RateLimit-Limit + X-RateLimit-Remaining:0` (success carries Limit/Remaining). GraphQL: `errors[0].extensions.code` + message.

| Code | When (frontend action) |
|---|---|
| 200 | reads; login; confirm/cancel/re-confirm/re-cancel/idempotent replays (explicit `@HttpCode`); verify-GET; Google callback/link; prefs; cart increase/decrease/remove/clear; order complete/cancel; payment confirm/cancel; notification reads. |
| 201 | all other POST creates (register, refresh, logout, resend, forgot/validate/reset, verify-POST, cart add, checkout, payment intent). Do not assert 200 on POST. |
| 202 | sales enqueue only (admin). |
| 400 | DTO validation/extras (DTO routes only); cart qty floor; decline-without-reason; strict payment-list pagination; forgot/reset/verify token shape (non-64hex never hits DB); newPassword rules. Show inline, do not retry as-is. |
| 401 | missing/bad/expired JWT; bad login creds; unknown/expired/revoked/reused refresh (reused = theft: all sessions dead); non-owner reads via owner-check paths. Refresh-once then redirect if still 401 (never loop on refresh-401). |
| 403 | wrong role (Admin-on-cart, shopper-on-admin, non-owner order/payment/notification, shopper-on-reservation-write with fixed 403 copy). Show access-denied, do not retry. |
| 404 | product/inventory/order/payment/reservation/notification missing; orphan inventory row; product-null via GraphQL error. |
| 409 | insufficient/over-available stock; bad order/reservation/payment transitions; dup product in cart; CHECK violations (`23514`); race dup register; terminal payment intent; payment-cancel on terminal. Contention copy + recovery (never auto-retry checkout/intent). |
| 429 | throttled (see guard table). Countdown from `Retry-After` (60s cooldown vs 3600 hourly), disable submit. Fail-open means 429 can disappear — never depend on it for logic. |
| 500/501 | unexpected/SMTP failure; OTP routes always 501 (do not call). |
