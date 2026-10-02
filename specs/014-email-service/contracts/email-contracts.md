# Contracts — Phase 18 Email Service

**Branch**: `014-email-service` | **Spec**: [spec.md](../spec.md) | **Plan**: [plan.md](../plan.md)

All routes use global `ValidationPipe whitelist+forbidNonWhitelisted+transform` and global `AllExceptionsFilter {statusCode,message,timestamp}`. `401` via `JwtGuard`/`tokenVersion` mismatch, `400` via `BadRequestException`, `429` via `RateLimitGuard` fail-open with `Retry-After` + `X-RateLimit-*` forwarded by filter.

---

## 1. GET /auth/verify-email

- **Auth**: public (no `JwtGuard`)
- **RateLimit**: `10/h per IP` (`rl:GET /auth/verify-email:ip:<ip>` `CACHE_MANAGER INCR+EXPIRE 3600` outermost before `ValidationPipe` + `DataSource.transaction`, fail-open `Logger.warn` + allow on `ECONNREFUSED`, `0 transaction` on `429`)
- **Query**: `VerifyEmailDto` — `email: string @IsEmail`, `token: string @IsString @Length(64,64) @Matches(/^[0-9a-f]{64}$/)`
- **Handler**: `hash=sha256(token)`, `SELECT User by email` unknown → `400 {message:"Invalid or expired verification token"}` (do not `404` leak); else `SELECT EmailVerificationToken WHERE tokenHash=hash AND userId=user.id FOR UPDATE` inside `dataSource.transaction` verify `found && usedAt IS NULL && expiresAt > NOW()` else `400`; on success `UPDATE token usedAt=NOW() + User.emailVerified=true` commit, optional `emit auth.email_verified` after commit.
- **Success**: `200 {verified:true, emailVerified:true}`
- **Errors**: `400` invalid/expired/used/wrong email (`AllExceptionsFilter`), `429` rate-limit (`Retry-After: 3600`, `X-RateLimit-Limit:10`, `X-RateLimit-Remaining:0`), `422` validation (`Length(64,64)`), `500` unexpected
- **Swagger**: `@ApiOperation(summary:'Verify email via link') @ApiQuery name=email token @ApiResponse 200 @ApiResponse 400 @ApiResponse 429`, public
- **Edge**: concurrent `Promise.all([verify,verify])` same `raw` → `FOR UPDATE` single-winner `200+400`

**Example Request**

```http
GET /auth/verify-email?token=abc123...64hex&email=user@example.com HTTP/1.1
Host: localhost:3000
```

**Example Success 200**

```json
{ "verified": true, "emailVerified": true }
```

**Example 400**

```json
{ "statusCode": 400, "message": "Invalid or expired verification token", "timestamp": "2026-09-23T00:00:00.000Z" }
```

---

## 2. POST /auth/verify-email

Identical to GET but body JSON. Alias for non-link clients / frontend POST.

- **Auth**: public
- **RateLimit**: `10/h per IP` (`rl:POST /auth/verify-email:ip:<ip>` separate key, same `10/3600` policy, outermost)
- **Body**: `VerifyEmailDto` `{email, token}` same validators
- **Success**: `200 {verified:true, emailVerified:true}`
- **Errors**: same as GET + `400` `forbidNonWhitelisted` if extra fields
- **Swagger**: `@ApiOperation(summary:'Verify email via body')`

**Example Request**

```http
POST /auth/verify-email HTTP/1.1
Content-Type: application/json

{ "email": "user@example.com", "token": "abc123...64hex" }
```

---

## 3. POST /auth/resend-verification

- **Auth**: public
- **RateLimit**: dual buckets `5/h per IP` (`rl:POST /auth/resend-verification:ip:<ip>`) **and** `3/h per email` (`rl:POST /auth/resend-verification:email:<email>`) either `429` before `FOR UPDATE` + `60s cooldown per email` via `Redis SET resend:cooldown:<email> NX EX 60` — if `0` return `429 Retry-After 60` immediately, `0 transaction`. All fail-open `Logger.warn` + allow on `CACHE_MANAGER throw`.
- **Body**: `ResendVerificationDto {email @IsEmail}`
- **Handler**:
  - Lookup `User by email`:
    - `!found` → return `200 {message:"If an account exists, a verification email has been sent."}` (`0` `EmailVerificationToken` row, `0` `EmailProvider.send`, `Logger.debug anti-enum`)
    - `found && emailVerified true` → return `200 {message:"Email already verified"}` distinct (no token/email, disclosure clarified 2026-09-23)
    - `found && emailVerified false` + cooldown ok → inside `dataSource.transaction` `UPDATE EmailVerificationToken SET usedAt=NOW() WHERE userId=:id AND usedAt IS NULL` (invalidate priors) + `INSERT {userId, tokenHash=sha256(crypto.randomBytes(32).hex), expiresAt=now+24h}` then after commit `emit email.verification_requested {userId,email,raw,expiresAt}` → worker `EmailProvider.send verify` + `NotificationLog` optional; return same anti-enum `200 {message:"If an account exists..."}` (unless verified distinct above)
- **Success**: `200 {message:"If an account exists, a verification email has been sent."} | {message:"Email already verified"}`
- **Errors**: `429` rate-limit/cooldown (`Retry-After: 3600` or `60`), `400` validation (`@IsEmail`), `500`
- **Swagger**: public, `@ApiResponse 200 @ApiResponse 429`

**Example**

```http
POST /auth/resend-verification HTTP/1.1
Content-Type: application/json

{ "email": "user@example.com" }
// 200 If an account exists...
// If verified: 200 { "message":"Email already verified" }
// If cooldown: 429 { statusCode:429, message:"Too Many Requests" } header Retry-After: 60
```

---

## 4. POST /auth/forgot-password (Wired — existing, now emits)

- **Auth**: public (existing)
- **RateLimit**: existing Phase 10 `5/h per IP + 3/h per email` via `RateLimitGuard`
- **Body**: `ForgotPasswordDto {email @IsEmail}`
- **Handler**: Phase 16 `FOR UPDATE` invalidate priors `PasswordResetToken SET usedAt=NOW() WHERE userId AND usedAt IS NULL` + `INSERT {hash=sha256(raw), expiresAt=now+15m}` inside `dataSource.transaction` + **now after commit** `emit auth.password_reset_requested {userId,email,raw,expiresAt}` consumed by `EmailWorker` → `EmailProvider.send(to:email, subject:"Reset your password", template:'reset', vars:{link:${FRONTEND_URL}/reset-password?token=<raw>&email=, expiresIn:'15m'})` + `NotificationLog template:reset`.
- **Success**: `200 {message:"If an account exists, a password reset email has been sent."}` anti-enum (also for unknown email `0` rows `0` sends)
- **Errors**: `400` validation, `429` rate-limit
- **Note**: `POST /auth/validate-reset-token` and `POST /auth/reset-password` remain unchanged (`FOR UPDATE` single-use `usedAt` → `400` on reuse/expired, `tokenVersion++` on reset).

---

## 5. POST /admin/notifications/sales

- **Auth**: `@Auth(Admin)` `JwtGuard + RolesGuard` (spec FR-010: Admin only V1, not CoAdmin/ContentManager)
- **RateLimit**: `10/h per admin user` (`rl:POST /admin/notifications/sales:user:<sub>` `INCR+EXPIRE 3600` outermost before `JwtGuard`, `0 BullMQ add` on `429`, fail-open `Logger.warn`)
- **Body**: `CreateSalesNotificationDto {title: string @IsString @Length(1,200) @IsNotEmpty, body: string @IsString @IsNotEmpty, productIds?: string[] @IsOptional @IsUUID('4', {each:true}) }`
- **Handler**: Validate `Admin`, `productIds` existence if provided (`400`/`404` if nonexistent, no job enqueued), then `BullMQ queue.add('notification.sendBulk', {campaignId: uuid(), template:'sales', subject:title, body, productIds}, {jobId: campaignId, attempts:3, backoff:{type:'exponential', delay:1000}})` ephemeral (no `sales_campaign` table V1 per clarification) → `NotificationBulkProcessor @Processor('notification')` pages `Users WHERE marketingOptIn=true AND emailOptIn=true AND emailVerified=true ORDER BY id LIMIT EMAIL_SALES_BATCH_SIZE 500` cursor, resolves channels per user via `NotificationDispatcher` (`system` always + `email` iff three-flag gate), for each user `Redis SET NX notification:send:sales:<campaignId>:<userId> EX 86400` (Redis-primary, PG `@Unique(eventId,channel)` backstop) → `0` skip duplicate, `1` → channel sends + upsert `Notification`/`NotificationDelivery` + `INSERT NotificationLog {userId, template:'sales', subject:title, productId|orderId nullable, provider, messageId, sentAt}` per batch (`EntityManager`), `Logger.log campaignId hashPrefix`.
- **Success**: `202 {jobId: string (campaignId), message:"Bulk notification enqueued"}` (Swagger `202`)
- **Errors**: `401` unauth, `403` forbidden (non-Admin), `400` validation (`title 1-200`), `404` `productId` not found, `429` rate-limit
- **Swagger**: `@ApiBearerAuth @ApiOperation(summary:'Enqueue sales bulk') @ApiResponse 202 @ApiResponse 401 @ApiResponse 403 @ApiResponse 429`
- **Idempotency**: `SET NX 24h` Redis-primary + PG `@Unique(eventId,channel)` backstop; replay `same campaignId` job (manual retry) → `0` new sends/rows; new `campaignId` with same `title` → new send (intended).

**Example**

```http
POST /admin/notifications/sales HTTP/1.1
Authorization: Bearer <Admin JWT>
Content-Type: application/json

{ "title": "Sale -20%", "body": "All products this week", "productIds": ["uuid-1"] }
// 202 { "jobId":"3fa85f64-...", "message":"Bulk notification enqueued" }
```

---

## 6. PATCH /users/me/preferences + GET /users/me

- **PATCH /users/me/preferences**
  - **Auth**: `JwtGuard @Auth()` any role
  - **Body**: `UpdatePreferencesDto {marketingOptIn?: boolean @IsOptional @IsBoolean, emailOptIn?: boolean @IsOptional @IsBoolean}` (either-or, at least one flag)
  - **Handler**: inside `dataSource.transaction` `SELECT User WHERE id=:currentUser.sub FOR UPDATE` → apply provided flags, save, return `200 {marketingOptIn, emailOptIn}`; `GET /users/me` returns `User` including `marketingOptIn` + `emailOptIn` + `emailVerified`.
  - **Success**: `200 {marketingOptIn: true|false, emailOptIn: true|false}`
  - **Errors**: `401` unauth, `400` validation (no flag provided / wrong types), `500`

- **GET /users/me** (existing + extended)
  - **Auth**: `JwtGuard`
  - **Success**: `200 {id, firstName, lastName, email, role, marketingOptIn, emailOptIn, emailVerified, ...}` without password
  - **Errors**: `401`

- **RegisterDto extension** (no new route): `POST /auth/register` now accepts optional `marketingOptIn?: boolean @IsOptional @IsBoolean` (default `false` if omitted) and `emailOptIn?: boolean @IsOptional @IsBoolean` (default `true`) stored directly on `User`.

**Example**

```http
PATCH /users/me/preferences HTTP/1.1
Authorization: Bearer <JWT>
Content-Type: application/json

{ "marketingOptIn": true }
// 200 { "marketingOptIn": true, "emailOptIn": true }
```

---

## 7. product.created internal hook (no REST, but contract for worker)

- **Trigger**: `ProductsService.create` (GraphQL `createProduct` Admin) after `DataSource.transaction` commit → `notificationService.onProductCreated(product)` fire-and-forget outside transaction `queue.add('notification.new_product', {productId: product.id, name, price})`
- **Worker**: `NotificationBulkProcessor` handling `notification.new_product` pages three-flag-gated users, `SET NX notification:send:new_product:<productId>:<userId> EX 86400` per user → channel sends (`template:'new_product'` `vars:{productName:name}`) + `Notification`/`Delivery` upserts + `NotificationLog template:'new_product' productId`, dedup same as sales.

---

## 8. Rate-limit headers & error envelope

On success: `X-RateLimit-Limit: <max>` `X-RateLimit-Remaining: <max-count>`.

On `429`:

```http
HTTP/1.1 429 Too Many Requests
Retry-After: 3600
X-RateLimit-Limit: 3
X-RateLimit-Remaining: 0

{ "statusCode":429, "message":"Too Many Requests", "timestamp":"2026-09-23T00:00:00.000Z" }
```

`AllExceptionsFilter` forwards `HttpException` `options.headers` → `res.setHeader`.

**Swagger**: Each throttled route annotated `@ApiResponse 429` + `ApiHeader Retry-After`.

---

## 9. DTOs Summary (class-validator)

```ts
class VerifyEmailDto { @IsEmail() email: string; @IsString() @Length(64,64) @Matches(/^[0-9a-f]{64}$/) token: string; }
class ResendVerificationDto { @IsEmail() email: string; }
class CreateSalesNotificationDto { @IsString() @Length(1,200) title: string; @IsString() body: string; @IsOptional() @IsUUID('4', {each:true}) productIds?: string[]; }
class TestEmailDto { @IsEmail() to: string; @IsOptional() @IsString() @MaxLength(200) subject?: string; @IsOptional() @IsString() @MaxLength(2000) body?: string; }
class UpdatePreferencesDto { @IsOptional() @IsBoolean() marketingOptIn?: boolean; @IsOptional() @IsBoolean() emailOptIn?: boolean; }
class UserRegisterDto extended { ... existing firstName/lastName/email/password + @IsOptional() @IsBoolean() marketingOptIn?: boolean + @IsOptional() @IsBoolean() emailOptIn?: boolean; }
class NotificationHistoryQueryDto { @IsOptional() page?: number; @IsOptional() limit?: number; @IsOptional() isRead?: boolean; @IsOptional() channel?: 'SYSTEM'|'EMAIL'; @IsOptional() type?: string; @IsOptional() userId?: string (Admin only); }
```

---

## 10. POST /admin/notifications/test-email (SMTP config probe)

- **Auth**: `@Auth(Admin)` `JwtGuard + RolesGuard`
- **RateLimit**: `10/h per admin user` (`rl:POST /admin/notifications/test-email:user:<sub>`)
- **Body**: `TestEmailDto {to @IsEmail, subject? @MaxLength(200), body? @MaxLength(2000)}`
- **Handler**: `EmailChannel.send({to, subject ?? 'Mini E-Commerce SMTP test', template:'test', vars:{body}})` directly (bypasses outbox/dedup/history — config probe, not a business notification) → `200 {to, provider, messageId, delivered}` where `provider` echoes `EMAIL_PROVIDER` so `noop` vs real SMTP is unambiguous.
- **Success**: `200 {to, provider: 'smtp'|'resend'|'noop', messageId, delivered:true}`
- **Errors**: `401`, `403` (non-Admin), `400` validation, `429`, `500` (SMTP transport failure, e.g. bad creds — surfaces, never swallowed)

**Example**

```http
POST /admin/notifications/test-email HTTP/1.1
Authorization: Bearer <Admin JWT>
Content-Type: application/json

{ "to": "you@example.com", "subject": "SMTP test" }
// 200 { "to":"you@example.com", "provider":"resend", "messageId":"<...>", "delivered":true }
```

---

## 11. History + WebSocket realtime (US6/US7)

- **REST** (all `@Auth()`, owner-scoped): `GET /notifications?page=&limit=&isRead=&channel=&type=` → `200 {data, meta}` (`createdAt DESC`, `Admin` may `?userId=`); `GET /notifications/unread-count` → `200 {unreadCount}`; `PATCH /notifications/:id/read` → `200 {id, isRead:true, readAt}` (idempotent, `403` non-owner); `PATCH /notifications/read-all` → `200 {updated:n}`. History routes carry no strict `RateLimitGuard` bucket in V1 (documented gap — PG-indexed reads mitigate abuse; throttle with dashboard phase).
- **WS** (`src/modules/notifications/notifications.gateway.ts`, `@WebSocketGateway({namespace:'notifications', cors:true})`): connect with `Authorization: Bearer <accessToken>` (handshake `auth`/query/header) → server verifies JWT → joins room `user:<sub>`; `SystemChannel` emits `notification:new {id, type, title, body, channel, eventId, createdAt}` to the room; client ack drives `DELIVERED`, offline stays `SENT` until fetch. `wscat -c "ws://localhost:3000/notifications?token=<JWT>"`.
