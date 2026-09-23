# Feature Specification: Email Service — Phase 18

**Feature Branch**: `014-email-service`  
**Created**: 2026-09-23  
**Status**: Draft  
**Input**: User description: "phase 18 email service"
**Source**: `docs/plan.md` §18 (Phase 18 — Email Service, planned 2026-09-23, before Phase 14 Testing), `src/modules/auth/auth.service.ts` + `auth.controller.ts` (Phase 16: `emailVerified boolean default false`, `PasswordResetToken {hash, expires 15m, usedAt}`, `register → bcrypt 10` without email, `requestPasswordReset` with `FOR UPDATE` + `tokenVersion++`), `src/modules/users/entity/user.entity.ts` (no `marketingOptIn`, no `EmailVerificationToken`), `specs/005-auth-upgrades/spec.md` + `specs/013-refresh-token/spec.md` (auth baseline), constitution I/III (PostgreSQL authoritative, Redis/RabbitMQ not authoritative, publish after commit)

---

## 1. Overview

Phase 16 added `emailVerified` flag and `PasswordResetToken` but left actual sending as `Logger.log + TODO publish auth.password_reset_requested`. `register` creates a user with `emailVerified=false` but never sends a verification link. `POST /auth/forgot-password` returns `200` anti-enumeration but no worker consumes the event. Marketing notifications for sales/new-products do not exist.

Phase 18 closes these gaps by delivering **async email after commit** via a provider abstraction (`EmailProvider` with `Noop` for dev/test, `Smtp/Ses/SendGrid` for prod) and `RabbitMQ/BullMQ` workers, without blocking PostgreSQL transactions or making Redis/RabbitMQ authoritative:

```text
Register → DB commit User(emailVerified false)
        → requestEmailVerification: invalidate priors + insert EmailVerificationToken {hash=sha256(raw 64 hex), expiresAt=now+24h}
        → after commit: emit email.verification_requested {userId,email,rawToken} → EmailWorker → EmailProvider.sendVerification(to, link https://app/.../verify-email?token=<raw>&email=..., template verify)
GET|POST /auth/verify-email {email,token} → FOR UPDATE EmailVerificationToken(hash) → verify not expired/used → SET usedAt=NOW() + User.emailVerified=true → 200 {verified:true}, second use 400
POST /auth/resend-verification {email} → 200 anti-enum, invalidate priors, new token, rate-limit 3/h per email + 5/h per IP + cooldown 60s
POST /auth/forgot-password {email} → existing PasswordResetToken flow now actually consumed → EmailProvider.sendPasswordReset(to, link reset?token=<raw>, expires 15m)
POST /admin/notifications/sales {title,body,productIds?} (Admin) → 202 bulk job → worker pages Users WHERE marketingOptIn=true AND emailVerified=true, Redis SET NX dedup 24h per user/template/campaign + NotificationLog, idempotent on retry
PATCH /users/me/preferences {marketingOptIn} → opt-in gate for sales/news; verify/reset are always sent regardless of opt-in
```

This phase is **orthogonal** to Phases 7-8 (order) and 9-13 (infra) and must ship **before** `Phase 14 — Testing` so final `npm run test:e2e` can cover `register → verify-email → login → forgot-password → reset → order` and bulk idempotency without `console.log` stubs.

### Goal

After `POST /auth/register 201`, the user receives a verification email with a 24h single-use link; `GET|POST /auth/verify-email` with that link sets `emailVerified=true` exactly once (concurrent same token → one `200` one `400`); `POST /auth/resend-verification` is anti-enumeration with cooldown; `POST /auth/forgot-password` actually sends a reset email (15m) without leaking existence; admin sales broadcasts via `POST /admin/notifications/sales` enqueue a BullMQ bulk job that delivers only to `marketingOptIn=true && emailVerified=true` users with `24h` Redis dedup and `NotificationLog` audit, idempotent on retry. — `docs/plan.md` §18.10 Exit Criteria.

---

## User Scenarios & Testing *(mandatory)*

### User Story 1 — Verify email after register via link (Priority: P1)

A new user registers `POST /auth/register {firstName,lastName,email,password, marketingOptIn?} → 201` (user created `emailVerified false`). After the DB commit, the system creates an `EmailVerificationToken` `{userId, tokenHash=sha256(raw 64 hex), expiresAt=now+24h, usedAt NULL}` and, outside the transaction, the `EmailWorker` sends a verification email to `email` with a link `https://app.example.com/verify-email?token=<raw>&email=<email>` (template `verify`). The user opens the link `GET /auth/verify-email?token=<raw>&email=<email>` (or `POST /auth/verify-email {email,token}` for body) and receives `200 {verified:true}`; `EmailVerificationToken.usedAt` is set and `User.emailVerified` becomes `true`. Second use of the same `raw` returns `400 Invalid or expired token`. The verification email is sent regardless of `marketingOptIn`.

**Why this priority**: Core onboarding — without verification, `emailVerified` never becomes `true`, which gates sales/news and is required for eventual trust (Phase 16 left it `false` with no path to `true`). All other email flows are blocked if verification cannot complete.

**Independent Test**: Can be fully tested by `POST /auth/register → capture rawToken via test hook AuthService.lastVerificationToken or NoopEmailProvider.lastVars → GET /auth/verify-email?token=&email= → 200 {verified:true} → SELECT user.emailVerified true, token usedAt not null → second GET same raw 400 → SELECT inventory/order unchanged 0`.

**Acceptance Scenarios**:

1. **Given** a `POST /auth/register` with valid fields creates `User emailVerified false`, **When** the request commits, **Then** system inside `dataSource.transaction` does `UPDATE EmailVerificationToken SET usedAt=NOW() WHERE userId=:id AND usedAt IS NULL` (invalidate priors) + `INSERT {userId, tokenHash=sha256(raw), expiresAt=now+24h}` and after commit enqueues/emits `email.verification_requested {userId,email,rawToken,expiresAt}`; worker calls `EmailProvider.send(to:email, subject:"Verify your email", template:'verify', vars:{firstName, link:https://app/...?token=<raw>&email=})` and inserts `NotificationLog {userId, template:'verify', subject, sentAt}` (if audit enabled). `raw` is never logged.
2. **Given** a valid `EmailVerificationToken` `hash` `expiresAt > NOW()` `usedAt NULL` for user `u`, **When** `GET /auth/verify-email?token=<raw>&email=u.email` inside `dataSource.transaction` with `SELECT EmailVerificationToken WHERE tokenHash=hash AND userId=u.id FOR UPDATE` loads the row, **Then** system verifies `user exists && !usedAt && expiresAt > NOW()`, sets `token.usedAt=NOW()`, updates `User.emailVerified=true` (if false), commits, returns `200 {verified:true}` and optionally emits `auth.email_verified` after commit. `POST /auth/verify-email {email,token}` behaves identically.
3. **Given** a `token` already `usedAt NOT NULL` (second use) or `expiresAt <= NOW()` (24h elapsed) or `tokenHash` not found / wrong `email`, **When** `GET|POST /auth/verify-email` is called, **Then** system returns `400 Bad Request {message:"Invalid or expired verification token"}` and does not mutate `User.emailVerified` or `Inventory/Order`.
4. **Given** a valid `token` `rawA` for user `u`, **When** `GET /auth/verify-email` is called concurrently twice with same `rawA` via `Promise.all` in `dataSource.transaction` with `FOR UPDATE`, **Then** exactly one succeeds `200 {verified:true}` (`usedAt` set, `emailVerified true`), the other returns `400` (`usedAt` already set), `EmailVerificationToken` row `usedAt NOT NULL` exactly once, no double `emailVerified` toggle.

---

### User Story 2 — Resend verification anti-enumeration with cooldown (Priority: P1)

A user who did not receive the first email (or whose token expired) calls `POST /auth/resend-verification {email} → 200 {message:"If an account exists, a verification email has been sent."}` regardless of whether `email` exists (anti-enumeration). If `email` maps to `User emailVerified false` and cooldown has passed, the service invalidates prior active tokens `SET usedAt=NOW() WHERE userId AND usedAt IS NULL` and creates a new `EmailVerificationToken` `expires 24h` and re-emits the worker event. If `emailVerified true`, returns `200` with no new email (or `200` already verified, without leaking). Rate limits: `3/hour per email` and `5/hour per IP` plus a `60s` per-email cooldown via Redis `SET NX EX 60` fail-open; exceeding returns `429`.

**Why this priority**: Resend is the recovery path for Story 1 — without cooldown + anti-enum, the endpoint leaks user existence and can be spammed to flood the provider.

**Independent Test**: Real PG with `FLUSHDB` Redis mock: `POST /auth/register → POST /auth/resend-verification {email} 200 → SELECT count active EmailVerificationToken 1 (second token)` then `POST /auth/resend-verification` within `60s` `429 cooldown`; `POST /auth/resend-verification {email:"notfound@example.com"} 200`; `4th POST /auth/resend-verification {same email} within hour 429`.

**Acceptance Scenarios**:

1. **Given** an existing user `u` `emailVerified false` with one active `EmailVerificationToken` `t1` `usedAt NULL`, **When** `POST /auth/resend-verification {email: u.email}` where Redis `resend:email:<u.email>` not in cooldown, **Then** inside `dataSource.transaction` system does `UPDATE usedAt=NOW() WHERE userId=:id AND usedAt IS NULL` (`t1` invalidated) + `INSERT t2 {tokenHash=sha256(newRaw), expiresAt=now+24h}` and after commit emits `email.verification_requested` for `newRaw`, returns `200 {message:"If an account exists..."}`, `t1 usedAt NOT NULL` `t2 usedAt NULL`. If `u.emailVerified true`, return `200 {message:"Email already verified"}` without new token/email.
2. **Given** `POST /auth/resend-verification {email}` called with `email` not found, **When** handled, **Then** system returns `200 {message:"If an account exists, a verification email has been sent."}` without creating `EmailVerificationToken`, without `EmailProvider.send`, and without revealing existence (`Logger.debug resend anti-enum email=<email>` hashed or not logged).
3. **Given** `POST /auth/resend-verification {email: u.email}` called twice within `60s`, **When** second call hits Redis `GET resend:cooldown:<email>` exists, **Then** returns `429 {message:"Too Many Requests", retryAfter 60}` with `Retry-After` header, `DataSource.transaction` `0` calls on `429` path before validation.

---

### User Story 3 — Password-reset email actually sends (upgrade of Phase 16) (Priority: P2)

An unauthenticated user calls `POST /auth/forgot-password {email} → 200` anti-enumeration (existing Phase 16 behavior: `UPDATE PasswordResetToken SET usedAt=NOW() WHERE userId AND usedAt IS NULL` + `INSERT {hash, expiresAt=now+15m}`). Phase 18 wires the existing publish to a real worker: after commit, the service emits `auth.password_reset_requested {userId,email,rawToken,expiresAt}` via `RabbitMQ`/`BullMQ`; `EmailWorker` calls `EmailProvider.sendPasswordReset(to:email, link:https://app.example.com/reset-password?token=<raw>&email=..., template:'reset', expiresIn 15m)` with the raw link. The user then calls `POST /auth/validate-reset-token {email,token} → 200 {valid:true}` and `POST /auth/reset-password {email,token,newPassword} → 200` which inside `FOR UPDATE` sets `PasswordResetToken.usedAt` and `User.tokenVersion++` + `passwordChangedAt`. Anti-enumeration and `15m` TTL remain as in Phase 16.

**Why this priority**: Phase 16 already satisfied `forgot-password → 200` but never delivered email — manual E2E `docs/manual-e2e-test-flow.md:§1.6` documents only `Logger.log`. Without wiring, `reset-password` is unreachable except by capturing `rawToken` via test hook.

**Independent Test**: Mock `EmailProvider`: `POST /auth/forgot-password {email: u.email} 200 → assert EmailProvider.send called once with template:'reset' and to===u.email and link contains raw hex 64 + email` (capture via `NoopEmailProvider.lastLink`); `POST /auth/validate-reset-token` with that `raw` `200`; `POST /auth/reset-password 200 → SELECT PasswordResetToken usedAt NOT NULL, User.tokenVersion 1, GET /order with old accessToken 401`.

**Acceptance Scenarios**:

1. **Given** existing user `u` `emailVerified false`, **When** `POST /auth/forgot-password {email: u.email}` commits `PasswordResetToken {hash=sha256(raw), expiresAt=now+15m}`, **Then** after commit the publisher enqueues `auth.password_reset_requested`; worker calls `EmailProvider.send(to:u.email, subject:"Reset your password", template:'reset', vars:{link, expiresIn:'15m'})` with `EMAIL_FROM` as `from`, logs `Logger.log password reset email enqueued userId=:id hashPrefix=abc123...` (never `raw`), returns initial `POST` `200` anti-enum immediately without waiting for provider I/O.
2. **Given** `POST /auth/forgot-password {email:"unknown@example.com"}`, **When** handled, **Then** returns `200` anti-enum with same message, `PasswordResetToken` `0` rows, `EmailProvider.send` `0` calls.
3. **Given** a `PasswordResetToken` `hash` `expiresAt > NOW()` `usedAt NULL` for `u`, **When** `POST /auth/validate-reset-token {email:u.email, token:raw}` with `hash=sha256(raw) FOR UPDATE` succeeds, **Then** returns `200 {valid:true}`; with `expiresAt <= NOW()` or `usedAt NOT NULL` returns `400`.

---

### User Story 4 — Sales and new-product bulk notifications with opt-in gate and idempotency (Priority: P2)

An `Admin` creates a sales broadcast `POST /admin/notifications/sales {title, body, productIds?} → 202 {jobId}` (protected `@Auth(Admin)`). The service enqueues a `BullMQ` job `notification.sendBulk {template:'sales', subject:title, body, productIds, campaignId}`. The `NotificationWorker` (`@Processor concurrency 5`) after commit pages `Users WHERE marketingOptIn=true AND emailVerified=true` with cursor (`EMAIL_SALES_BATCH_SIZE 500`) and for each user does: check `Redis SET NX notification:send:sales:<campaignId>:<userId> EX 24h` — if `0` (already sent) skip; otherwise call `EmailProvider.send(to:user.email, subject:title, template:'sales', vars:{firstName, productName})`, then `INSERT NotificationLog {userId, template:'sales', subject:title, productId|orderId nullable, provider:'noop', sentAt}`. Users with `marketingOptIn=false` or `emailVerified=false` are skipped. Similarly, when admin creates a product via `GraphQL createProduct` (or `POST /admin/products` if dashboard exists), after commit the system emits `product.created {productId,name,price}` which fans out to opted-in users with template `'new_product'` using the same dedup `notification:send:new_product:<productId>:<userId>` `24h`.

Idempotent: retrying the bulk job or replaying `product.created` does not send duplicates — `SET NX 24h` + `NotificationLog` guard ensures `0` duplicate sends.

**Why this priority**: Marketing fan-out is the only bulk path; without opt-in gate it violates policy, without dedup it spams on retry, without audit it is unobservable.

**Independent Test**: Seed `10` users `5 marketingOptIn true emailVerified true`, `3 optIn true but emailVerified false`, `2 optIn false`. `POST /admin/notifications/sales {title:"Sale", body:"-20%"} as Admin → 202`. Await worker `drain`. Assert `NotificationLog count 5`, `EmailProvider.send callCount 5`, `Redis GET notification:send:sales:<campaignId>:<skippedUser> 0`. Replay same `campaignId` job → `NotificationLog count still 5`, `EmailProvider.send 0 new calls` (dedup `SET NX 0`). Unit mock `CACHE_MANAGER`.

**Acceptance Scenarios**:

1. **Given** `Users` with mixed `marketingOptIn`/`emailVerified`, **When** `POST /admin/notifications/sales {title, body}` succeeds as `Admin` and worker processes `notification.sendBulk`, **Then** for each `user` where `marketingOptIn=true && emailVerified=true` the worker does `Redis SET NX notification:send:sales:<campaignId>:<userId> EX 86400` `1` → `EmailProvider.send` `1` + `NotificationLog` insert `1`; for users failing the gate, `SET NX` not attempted `0` sends. All provider I/O outside any `DataSource.transaction` that created the `campaign` (publish after commit per `AGENTS.md`).
2. **Given** a `product.created {productId}` event after `createProduct` commit, **When** `NotificationWorker` handles `notification.new_product {productId}`, **Then** it pages opted-in verified users and for each does `SET NX notification:send:new_product:<productId>:<userId> EX 86400` per user, `EmailProvider.send` with `template:'new_product'` `vars:{productName}`, `NotificationLog` `template:'new_product' productId`.
3. **Given** the same bulk `campaignId` job is retried (BullMQ attempt `2` or manual requeue), **When** worker processes it again, **Then** `Redis SET NX` returns `0` for every user already sent `EX 24h` not yet expired, so `EmailProvider.send` `0` new calls, `NotificationLog` duplicate `0` rows (optional `@Unique(userId, template, campaignId|productId)` guard prevents insert). System returns `200` for the job with log `bulk dedup skipped count=5`.
4. **Given** `POST /admin/notifications/sales` is called by `Customer` or `ContentManager` without `Admin`, **When** handled, **Then** returns `403 Forbidden` with `AllExceptionsFilter {statusCode:403}` and no `BullMQ add` call, no `NotificationLog`.

---

### User Story 5 — Preference opt-in and read own verification state (Priority: P3, supporting)

An authenticated user `GET /users/me` sees `{marketingOptIn, emailVerified}` and can `PATCH /users/me/preferences {marketingOptIn: boolean} → 200 {marketingOptIn}` (`JwtGuard`). Changing `marketingOptIn false → true` makes the user eligible for future sales/news bulk (past campaigns are not retroactively sent). `marketingOptIn` defaults `false`.

**Why this priority**: Gate correctness depends on explicit opt-in — without a preferences endpoint, sales eligibility cannot be tested and GDPR-like policy is unenforced.

**Independent Test**: Real PG: `POST /auth/register {marketingOptIn:false} 201 → GET /users/me 200 emailVerified false marketingOptIn false → PATCH /users/me/preferences {marketingOptIn:true} 200 → SELECT User marketingOptIn true`.

**Acceptance Scenarios**:

1. **Given** an authenticated user `u` `marketingOptIn false`, **When** `PATCH /users/me/preferences {marketingOptIn:true}` inside `dataSource.transaction` `SELECT User FOR UPDATE WHERE id=:u.id`, **Then** sets `marketingOptIn=true`, returns `200`, next `POST /admin/notifications/sales` bulk includes `u`.
2. **Given** an authenticated user `u`, **When** `GET /users/me` with `Authorization: Bearer`, **Then** returns `200 {id, email, marketingOptIn, emailVerified, role}` without password.

---

### Edge Cases

- What happens when `POST /auth/register` succeeds but `requestEmailVerification` throws (DB down after `User` commit)? → `register` already committed `201` is not rolled back — `Logger.error` with `hashPrefix` and client still `201 {message:"Verification email will be sent"}`; verification can be recovered via `POST /auth/resend-verification` (fire-and-forget after commit, never throw to caller).
- What happens when `GET /auth/verify-email?token=<raw>&email=<otherEmail>` with `raw` for `u1` but `email` for `u2`? → `hash` lookup `WHERE tokenHash=hash AND userId=user(email).id` fails (`userId` mismatch) → `400` without leaking whether `hash` exists for other user.
- What happens when `expiresAt` is exactly `NOW()`? → Expired, `400` (`expiresAt > NOW()` strict, `CHECK expiresAt > createdAt` at INSERT uses `now + 24h` so `>` holds at creation).
- What happens when `EmailVerificationToken` `tokenHash` collision (`crypto.randomBytes(32)` ~2^-256 negligible) hits `UQ hash WHERE revokedAt IS NULL`? → Service catches `23505` → retry `crypto.randomBytes` once else `500` with `Logger.error` (no `raw`).
- What happens when `POST /auth/resend-verification` is called `4th` time within `1h` for same email? → `RateLimitGuard` `3/h per email` → `429 Retry-After 3600` before `DataSource.transaction` (outermost guard), `0` DB calls on `429` path.
- What happens when `POST /auth/resend-verification` and `GET /auth/verify-email` race with same `old token` where resend invalidates `old` `SET usedAt=NOW()` and verify tries `FOR UPDATE old`? → `FOR UPDATE` serializes — one wins, other sees `usedAt NOT NULL` → `400` (verify) or `200` (resend creates new `t2`).
- How does system handle `EmailProvider` transient `5xx` (SMTP timeout) during `verify` vs `sales` bulk? → `EmailWorker` for `verify/reset` BullMQ `attempts 3` `backoff exponential` `1s·2^n`; on final fail log `Logger.error provider=SMTP hashPrefix=... msg=...` but do not rollback already-committed `EmailVerificationToken/PasswordResetToken` (async after commit never rolls back business). For bulk `sales`, per-user send failure does not abort pagination — failed user `SET NX` not set so retry can re-send just that user.
- What happens when `Redis` unavailable? → `RateLimitGuard` fail-open (log `warn` + allow `true`), bulk `SET NX` → `Logger.warn Redis fail-open for notification dedup evt=...` then fallback to `NotificationLog @Unique` guard: if `NotificationLog` insert would duplicate, skip send (so no spam on retry even without Redis). Verify/reset token ops do not use Redis inside `FOR UPDATE`.
- What happens when `POST /admin/notifications/sales` is called with `productIds` containing non-existent `id`? → `400` validation (or `404` if strict), no job enqueued, no `NotificationLog`.
- What happens when `User` is deleted while `EmailVerificationToken` row exists? → FK `ON DELETE CASCADE` removes token rows (consistent with `PasswordResetToken`).
- What happens when `EmailProvider` is `noop` in `dev/test`? → `NoopEmailProvider` `send` returns `{messageId: 'noop-<uuid>'}` and `Logger.log [NoopEmail] to=<email> template=verify subject=... vars link=...` without network, for unit/e2e capture.
- What happens when `marketingOptIn` `PATCH` is unauthenticated? → `401 Unauthorized` via `JwtGuard`, no DB mutation.

---

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: System MUST add `EmailVerificationToken` entity in PostgreSQL (source of truth, not Redis) with fields `id uuid PK @PrimaryGeneratedColumn('uuid')`, `userId uuid FK → User.id ON DELETE CASCADE @Index`, `tokenHash varchar(255) @Index` (`sha256` hex 64 chars), `expiresAt timestamptz` (`CHECK expiresAt > createdAt`), `usedAt timestamptz nullable` (`NULL`=active, single-use set on verify or on resend invalidation), `createdAt @CreateDateColumn`, plus indexes `IDX_email_verification_token_userId`, `IDX_email_verification_token_tokenHash`, `IDX_email_verification_token_expiresAt`, composite `IDX_email_verification_token_userId_expiresAt`. No partial unique required (multiple per user, old rows invalidated via `usedAt`). `synchronize:false`, migration only (`17xxxxxxxxxx-AddEmailVerificationAndMarketingOptIn`). Retention: nightly purge `DELETE WHERE (usedAt IS NOT NULL AND usedAt < NOW() - INTERVAL '7 days') OR (expiresAt < NOW() - INTERVAL '7 days')`; `NotificationLog` retained indefinitely.

- **FR-002**: System MUST alter `User` (`src/modules/users/entity/user.entity.ts`) to add `marketingOptIn boolean default false` (GDPR-like opt-in for sales/news), expose via `GET /users/me` and `PATCH /users/me/preferences` (`UsersService`), keep `emailVerified boolean default false` already present (Phase 16). Migration adds column `marketingOptIn boolean NOT NULL DEFAULT false`; existing rows default `false`.

- **FR-003**: System MUST add audit `NotificationLog` entity (`notification_log`) with `id uuid PK`, `userId uuid FK → User.id ON DELETE CASCADE @Index`, `template varchar` (`verify|reset|sales|new_product`) `@Index`, `subject varchar`, `productId uuid nullable FK → Product.id ON DELETE SET NULL @Index`, `orderId uuid nullable FK → Order.id ON DELETE SET NULL @Index`, `provider varchar` (`noop|smtp|ses|sendgrid`), `messageId varchar nullable`, `sentAt timestamptz @CreateDateColumn` plus indexes `(userId, sentAt)`, `(template, sentAt)`. Writes are inside worker after provider `send`, never inside `verifyEmail` `FOR UPDATE`.

- **FR-004**: System MUST define `EmailProvider` interface `send(to: string, subject: string, template: 'verify'|'reset'|'sales'|'new_product', vars: Record<string,any>): Promise<{messageId:string}>` and implementations `NoopEmailProvider` (dev/test, `Logger.log`, returns `noop-<uuid>`), `SmtpEmailProvider` (`nodemailer` with `SMTP_HOST/PORT/USER/PASS/SECURE` via `ConfigService`), optionally `Ses/SendGrid` wrappers; provider selection `EMAIL_PROVIDER` (`ConfigService` `EMAIL_PROVIDER` default `noop`, never hardcode), all via `AuthModule`/`NotificationModule` `providers: {provide:'EMAIL_PROVIDER', useClass: <impl>}`. Never store or log `rawToken` — log `hashPrefix = tokenHash.slice(0,6)` only.

- **FR-005**: System MUST keep `AuthService.register(dto)` existing (`bcrypt 10`, `UsersService.createNewUser`) and **after commit** call `requestEmailVerification(email)` fire-and-forget (never throw to caller, `Logger.error` on failure only) — `requestEmailVerification(email)` does `SELECT User by email`; if `!found` return `void` (anti-enum `Logger.debug`); if `emailVerified true` return `void` (no email, `200` already verified semantics); otherwise inside `dataSource.transaction` with `EntityManager` do `UPDATE EmailVerificationToken SET usedAt=NOW() WHERE userId=:id AND usedAt IS NULL` (`AND expiresAt > NOW()` optional) + `INSERT {userId, tokenHash=sha256(raw 64 hex via crypto.randomBytes(32)), expiresAt=now+VERIFICATION_TOKEN_TTL(24h)}`, then after commit emit `email.verification_requested {userId, email, rawToken, expiresAt}` via `RabbitMQ` `client.emit` or `BullMQ queue.add('email.verify', {userId,email,rawToken})` outside the `dataSource.transaction` (constitution async rule).

- **FR-006**: System MUST expose public `GET /auth/verify-email?token=&email=` and `POST /auth/verify-email {email, token}` (both without `JwtGuard`) with DTOs `VerifyEmailDto { @IsEmail() email, @IsString() @Length(64,64) @Matches(/^[0-9a-f]{64}$/) token }` reused, global `ValidationPipe`. Handler does `hash=sha256(raw)`, lookup `User by email` `404`? vs `400` — return `400 {message:"Invalid or expired verification token"}` for unknown `email` (do not `404` leak). Then `SELECT EmailVerificationToken WHERE tokenHash=hash AND userId=user.id FOR UPDATE` inside `dataSource.transaction` (EntityManager), verify `found && usedAt IS NULL && expiresAt > NOW()`, else `throw BadRequestException 400` (expired/used/wrong). On success inside same transaction set `token.usedAt=NOW()` + `UPDATE User SET emailVerified=true WHERE id=:userId` (if not already), commit, after commit optional `client.emit('auth.email_verified', {userId, email})`. Return `200 {verified:true, emailVerified:true}`. `GET` form documented as `Verify via link` for Swagger.

- **FR-007**: System MUST expose public `POST /auth/resend-verification {email}` with `ResendVerificationDto { @IsEmail() email }` anti-enumeration `200 {message:"If an account exists, a verification email has been sent."}` for `!found` or `emailVerified false` eligible case. For `emailVerified true`, return `200 {message:"Email already verified"}` (distinct verified message, no token/email). Guarded by `RateLimitGuard` (see FR-009) outermost before `ValidationPipe` and `DataSource.transaction`. On eligible user (`found && emailVerified false`) inside `dataSource.transaction` invalidate priors `SET usedAt=NOW() WHERE userId AND usedAt IS NULL` + `INSERT new hash 24h`, after commit emit `email.verification_requested`. Cooldown `60s` per email via Redis `SET resend:cooldown:<email> NX EX 60` before transaction — if `0` (exists) return `429` with `Retry-After 60` immediately, `0` `transaction` calls.

- **FR-008**: System MUST upgrade existing `POST /auth/forgot-password {email} → 200` anti-enum flow (Phase 16: `FOR UPDATE` invalidate priors `usedAt NOW()`, `INSERT {hash, expires 15m}`) to **actually emit** `auth.password_reset_requested {userId, email, rawToken, expiresAt}` after commit (the `TODO` publish in `auth.service.ts` is replaced by `client.emit`/`queue.add` outside `EntityManager` transaction) and have `EmailWorker` consume it with `EmailProvider.send(to:email, subject:"Reset your password", template:'reset', vars:{link:`${FRONTEND_URL}/reset-password?token=<raw>&email=`, expiresIn:'15m'})` + `NotificationLog template:'reset'`. `reset-password`/`validate-reset-token` remain unchanged (`FOR UPDATE` single-use `usedAt`, `CHECK expiresAt > createdAt`, `BadRequestException 400` on reuse/expired).

- **FR-009**: System MUST enforce rate limiting via `RateLimitGuard` (distributed `CACHE_MANAGER` `createKeyv` `rl:*` `INCR+EXPIRE` fail-open already, `AuthModule` exports `RateLimitGuard`) for new endpoints with `ConfigService` overrides clamped `>=60000` else fallback + `Logger.warn`:

  | Endpoint | Limit (default) | Dimension | Window | Guard key / note |
  |----------|-----------------|-----------|--------|------------------|
  | `GET|POST /auth/verify-email` | `10 IP` | `ip` (`x-forwarded-for` first-value trimmed, `req.ip` fallback) | `3600000` (`RATE_LIMIT_WINDOW_MS`) | `rl:POST /auth/verify-email:ip:<ip>` + `rl:GET /auth/verify-email:ip:<ip>` separate (or `rl:/auth/verify-email:ip`) |
  | `POST /auth/resend-verification` | `5 IP` **and** `3 per email` + `cooldown 60s per email` | `ip` AND `email` (dual buckets, either `429` before `FOR UPDATE`) | `3600000` (email bucket `3600000`, cooldown `60000`) | `rl:POST /auth/resend-verification:ip:<ip>` + `rl:POST /auth/resend-verification:email:<email>` + `resend:cooldown:<email> NX EX 60` |
  | `POST /admin/notifications/sales` | `10 per admin user` | `user` (`req.user.sub ?? ip`) | `3600000` | `rl:POST /admin/notifications/sales:user:<sub>` (`JwtGuard` required, `Admin` only) |
  
  On `429` return `HttpException 429` with `headers { 'Retry-After': ceil(windowMs/1000), 'X-RateLimit-Limit': String(limit), 'X-RateLimit-Remaining':'0' }` forwarded by `AllExceptionsFilter` as `{statusCode:429, message:"Too Many Requests", timestamp}`. Outermost `@UseGuards(RateLimitGuard)` before `@Auth()`/`JwtGuard`/`ValidationPipe` so `429` path `DataSource.transaction` `0` calls. On `CACHE_MANAGER` `throw` → `Logger.warn RateLimit Redis fail-open for <routeKey>: <msg>` and allow (`return true`), headers may be absent, never `500`.

- **FR-010**: System MUST add `NotificationService`/`NotificationModule` (new module `src/modules/notification`) that owns bulk fan-out: `sendSalesCampaign(dto:{title:string body:string productIds?:uuid[]}, actor:User): Promise<{jobId:string}>` validates `title 1-200`, `body`, `productIds` optional UUIDs, then `BullMQ queue.add('notification.sendBulk', {campaignId: uuid(), template:'sales', subject:title, body, productIds}, {attempts:3, backoff:{type:'exponential', delay:1000}})` returns `202 {jobId}`. Hooks `onProductCreated(product:Product): void` (called from `ProductsService.create` after commit) and `onOrderCompleted(order:Order): void` (optional) enqueue `notification.new_product` similarly. All `queue.add` outside `DataSource.transaction`.

- **FR-011**: System MUST register `EmailWorker` `NotificationWorker` `@Processor` (BullMQ, `concurrency 5`) that handles `email.verify`, `email.reset`, `notification.sendBulk`, `notification.new_product`: for `verify/reset` call `EmailProvider.send` once per event (`NotificationLog` optional for audit), BullMQ `attempts 3` `backoff exponential 1s·2^n` on transient `5xx`; for bulk `sales/new_product` paginate `Users` `WHERE marketingOptIn=true AND emailVerified=true` via cursor `ORDER BY id LIMIT EMAIL_SALES_BATCH_SIZE 500`, for each `user` do `Redis SET NX notification:send:<template>:<campaignId|productId>:<userId> EX 86400` (24h) before `EmailProvider.send` — `0` skip duplicate, `1` send + `INSERT NotificationLog` (use `EntityManager` per batch) + `INCR notification:sent:<template>` (if Redis counters used) and `Logger.log` with `hashPrefix` only. Idempotency is Redis-only (no DB unique fallback; when Redis fail-open, duplicate on retry is tolerated and logged). Provider I/O never inside business `FOR UPDATE`.

- **FR-012**: System MUST expose `PATCH /users/me/preferences {marketingOptIn: boolean}` (and optional `POST|PATCH` alias) `JwtGuard` (`@Auth()` or `@CurrentUser`) with `UpdatePreferencesDto { @IsBoolean() marketingOptIn }`, handle inside `dataSource.transaction` `SELECT User FOR UPDATE WHERE id=:id` then `UPDATE User marketingOptIn=:dto.marketingOptIn` and return `200 {marketingOptIn}`. Also extend `POST /auth/register` `RegisterDto` with optional `marketingOptIn?: boolean` (`@IsOptional() @IsBoolean()`) — if `true` store directly, else default `false`. `GET /users/me` already returns `User` — ensure it includes `marketingOptIn` and `emailVerified`.

- **FR-013**: System MUST read all new config via `ConfigService` from `.env` (never hardcode, never commit `.env`): `EMAIL_PROVIDER=noop|smtp|ses|sendgrid` (default `noop`), `EMAIL_FROM="Mini E-Commerce <noreply@example.com>"`, `SMTP_HOST/PORT/USER/PASS/SECURE`, `EMAIL_VERIFICATION_TTL=24h` (default `24h`, `parseTtlMs` supports `s/m/h/d`), `EMAIL_RESET_TTL=15m` reuse `RESET_TOKEN_TTL`, `EMAIL_SALES_BATCH_SIZE=500`, `FRONTEND_URL=https://app.example.com`, `RABBITMQ_URL`, `REDIS_URL`, plus existing `JWT_SECRET`, `JWT_EXPIRES_IN`, `REFRESH_TOKEN_TTL`, `RESET_TOKEN_TTL`. Unknown/invalid TTL → fallback `24h` + `Logger.warn`.

- **FR-014**: System MUST document each route with Swagger `@ApiOperation`, `@ApiResponse 200|400|401|403|429`, request/response DTOs as `@ApiProperty`, `bearer` for `POST /admin/notifications/sales` and `PATCH /users/me/preferences`, `public` for `GET|POST /auth/verify-email` and `POST /auth/resend-verification`/`forgot-password`; `AllExceptionsFilter` handles `BadRequestException 400`, `TooManyRequests 429`, `ForbiddenException 403` uniformly.

- **FR-015**: System MUST respect module boundaries and code documentation per `AGENTS.md` §3/§8: `AuthService` owns `EmailVerificationToken` business API (`requestEmailVerification`, `verifyEmail`, `resendVerification`, plus `register` after-commit hook), `NotificationService` owns `NotificationLog`/bulk, `UsersService` owns `User.marketingOptIn` mutation, no other module `@InjectRepository(EmailVerificationToken)`; new files under `src/modules/auth/entities/email-verification-token.entity.ts`, `dto/verify-email.dto.ts`, `dto/resend-verification.dto.ts`, `providers/email.provider.ts`, `workers/email.worker.ts`, `src/modules/notification/*`; every new `Service`/`Controller`/`Entity` gets class-level `/** This service is responsible for ... It handles ... and enforces ... */`, every public method `/** ... @param @returns @throws */` with `@throws BadRequestException` etc., every complex condition (`if !found || usedAt || expiresAt<=now`, `available = stock - reserved` not touched here, `if marketingOptIn && emailVerified`) has inline `//` intent comment; use injected `Logger`, not `console.log`; `synchronize:false` always.

### Key Entities

- **EmailVerificationToken (new, PostgreSQL authoritative)**: `id uuid PK @PrimaryGeneratedColumn('uuid')`, `userId uuid FK → User.id ON DELETE CASCADE @Index` (`@ManyToOne`), `tokenHash varchar(255) @Index` (`sha256` hex 64 chars of `raw 64 hex` `crypto.randomBytes(32).toString('hex')`), `expiresAt timestamptz` (`now + EMAIL_VERIFICATION_TTL 24h`, `CHECK expiresAt > createdAt`), `usedAt timestamptz nullable` (`NULL`=active, set `NOW()` on `verify` or on `resend` invalidation), `createdAt timestamptz @CreateDateColumn`. Indexes `(userId)`, `(tokenHash)`, `(expiresAt)`, `(userId, expiresAt)`. No `tokenHash` uniqueness required beyond application single-active via `usedAt=NOW()` invalidate. Raw never persisted.

- **User (altered)**: Existing `User` `{id, firstName, lastName, email @Unique, password nullable, role enum, phoneNumber/@Index, phoneVerified, googleId/@Index, provider, tokenVersion, passwordChangedAt, emailVerified}` plus `marketingOptIn boolean NOT NULL DEFAULT false` (new) `@Column({default:false})`. Exposed in `GET /users/me` and mutable via `PATCH /users/me/preferences` (and optional `RegisterDto marketingOptIn`). Bulk filter `WHERE marketingOptIn=true AND emailVerified=true` for sales/news.

- **NotificationLog (new, audit + idempotency fallback)**: `id uuid PK`, `userId uuid FK → User.id ON DELETE CASCADE @Index`, `template varchar` (`verify|reset|sales|new_product`) `@Index`, `subject varchar`, `productId uuid nullable FK → Product.id ON DELETE SET NULL @Index`, `orderId uuid nullable FK → Order.id ON DELETE SET NULL @Index`, `provider varchar` (`noop|smtp|ses|sendgrid`), `messageId varchar nullable`, `sentAt timestamptz @CreateDateColumn`, indexes `(userId, sentAt)`, `(template, sentAt)`. Insert after `EmailProvider.send` inside bulk worker.

- **RateLimit & Idempotency Redis Keys (ephemeral)**: `rl:GET /auth/verify-email:ip:<ip>`, `rl:POST /auth/resend-verification:email:<email>`, `resend:cooldown:<email> NX EX 60`, `rl:POST /admin/notifications/sales:user:<sub>`, `notification:send:sales:<campaignId>:<userId> NX EX 86400`, `notification:send:new_product:<productId>:<userId> NX EX 86400`, `notification:sent:<template>` counters. Fail-open on Redis `throw`.

---

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001 (Verify-email single-use)**: `POST /auth/register 201 →` DB `EmailVerificationToken` row `hash=sha256(rawRaw) expiresAt=now+24h ±5s usedAt NULL` and `NoopEmailProvider.send` `callCount 1` template `verify`; first `GET /auth/verify-email?token=<raw>&email=<email>` returns `200 {verified:true}` with `User.emailVerified false→true` and `EmailVerificationToken usedAt NOT NULL`; second `GET` with same `raw` returns `400` and `User.emailVerified` remains `true`; concurrent `Promise.all([verify, verify])` same `raw` → one `200` one `400` `usedAt` single row (100% of verify tests pass).

- **SC-002 (Resend anti-enum idempotent)**: `POST /auth/resend-verification {email: existing}` with `emailVerified false` → `200 {message:"If an account exists..."}` `old t1 usedAt NOT NULL` `new t2 24h` `EmailProvider.send 1` with `new raw`; `POST /auth/resend-verification {email:"notfound@example.com"} → 200` same message `NotificationLog 0 new` `EmailProvider 0 calls`; second `resend` for `t1 old raw` `400`; `POST /auth/resend-verification` within `60s` cooldown for same email → `429` `Retry-After 60` (100% of resend/cool-down tests pass).

- **SC-003 (Password-reset email wired)**: `POST /auth/forgot-password {email: existing} → 200` anti-enum `PasswordResetToken 15m` `hash stored` `EmailProvider.send` `callCount 1` template `reset` `to===email` `link` contains `raw 64 hex` `+ email`; `POST /auth/forgot-password {email:"unknown"} → 200` `0` `EmailProvider` calls; `POST /auth/validate-reset-token` with that `raw` `200 {valid:true}` and expired `400` (100% of reset-email tests pass).

- **SC-004 (Bulk sales gate and 24h dedup)**: Seed `10 Users` `5 optIn true+verified true`, `3 optIn true+verified false`, `2 optIn false`. `POST /admin/notifications/sales {title:"Sale", body:"-20%"} as Admin → 202 {jobId}` → worker `NotificationLog count 5` `EmailProvider.send 5` `skipped 5` (`marketingOptIn/emailVerified` gate); replay same `campaignId` job (manual retry) → `NotificationLog still 5` `EmailProvider 0 new` due to `SET NX notification:send:sales:<campaignId>:* 0` (24h dedup) (100% of bulk gate/dedup tests pass).

- **SC-005 (New-product fan-out)**: `ProductsService.create` `GraphQL createProduct` as `Admin →` after commit `product.created` → worker fans out to same 5 eligible users `template new_product` `productId` `NotificationLog 5` `Redis SET NX new_product:<productId>:<userId> 1`; replay `product.created` same `productId` → `0` new sends (dedup).

- **SC-006 (Preferences opt-in)**: `POST /auth/register {marketingOptIn:false} → GET /users/me → marketingOptIn false`; `PATCH /users/me/preferences {marketingOptIn:true} → 200 {marketingOptIn:true}` `SELECT User marketingOptIn true`; next `sales` bulk includes that user; `PATCH` unauthenticated `401`, `marketingOptIn` invalid `400`, no `stock` mutation via auth/notification paths (`UPDATE inventory 0`).

- **SC-007 (Rate limiting and no blocking)**: Exceed `POST /auth/resend-verification 4th/h per email` → `429` `Retry-After 3600` with `X-RateLimit-*` headers, `DataSource.transaction` `0` calls on `429` path (spy `manager.getRepository 0`); with `CACHE_MANAGER throw ECONNREFUSED` → request still `200` with `Logger.warn` (fail-open) `200` for `GET /auth/verify-email`, never `500`; `grep -c "client.emit" src/modules/auth/auth.service.ts` `0` inside any `dataSource.transaction` block (publish after commit proven), `grep -c "FOR UPDATE" src/modules/auth/auth.service.ts` `>=1` (verify uses `FOR UPDATE`).

- **SC-008 (No regression and observability)**: `npm run build` passes, `npm run test -- --runInBand` (unit + integration real PG when available + E2E `supertest` `register→verify→forgot→reset→login→checkout` and `admin sales 10 users`) passes `synchronize:false`, `AllExceptionsFilter` forwards `400/401/429` as `{statusCode,message,timestamp}`, Swagger documents `GET|POST /auth/verify-email`, `POST /auth/resend-verification`, `POST /admin/notifications/sales`, `PATCH /users/me/preferences`, no `rawToken` in logs (`grep rawToken src/modules/auth | grep Logger` `0` raw, only `hashPrefix`).

---

## Assumptions

- `emailVerified` already exists `boolean default false` (Phase 16 migration `1755900000000-AuthUpgradesUserAndResetToken`) — no new column for it, but `EmailVerificationToken` is net new.
- `PasswordResetToken` flow (15m, single-use `usedAt`, `FOR UPDATE`) and `POST /auth/forgot-password|validate-reset-token|reset-password` endpoints already work for E2E `forgot→reset` — Phase 18 only wires `EmailProvider.send` after commit.
- `FRONTEND_URL` for links is `https://app.example.com` via `ConfigService` (`EMAIL_VERIFICATION_TTL` `24h` vs `RESET_TOKEN_TTL` `15m` distinction intentional per `docs/plan.md` §18.6).
- `cookie-parser` and `FRONTEND_URL` env already or will be added to `main.ts`/`app.module.ts` for `req.cookies` and link generation — `VerifyEmailDto` accepts both `GET query` and `POST body`.
- `BullMQ` and `RabbitMQ 4` already in `docker-compose.yml` (Phase 5 expiration uses `BullMQ` repeat `30s` with same `createKeyv REDIS_URL`) — reuse same infra: `BullMQ` for `notification.sendBulk` bulk batching, `RabbitMQ` `NOTIFICATION_SERVICE` classic RMQ for `email.*` events is interchangeable (`client.emit` vs `queue.add` decided in implementation, both after commit).
- `CacheModule` `CACHE_MANAGER` shared with `RateLimitGuard` and `ExpirationProcessor` (`src/modules/reservation/reservation-expiration.processor.ts:52` `SET NX expiration:tick:lock`) — reuse `rl:*` namespace, no second Redis client.
- `EMAIL_PROVIDER=noop` in `dev/test` (no real SMTP in CI), `SmtpEmailProvider` with `nodemailer` in `prod`; `EMAIL_FROM="Mini E-Commerce <noreply@example.com>"` default.
- Self-service `POST /auth/resend-verification` `200` anti-enum matches `POST /auth/forgot-password` `200` pattern (already proven), and `GET /auth/verify-email` `400` on invalid does not leak `hash` existence.
- `marketingOptIn` default `false` aligns with policy — Phase 18 V1 sends `verify/reset` regardless of opt-in, only `sales/new_product` checks `marketingOptIn && emailVerified`.
- E2E `supertest` can capture `rawToken` via `AuthService.lastVerificationToken` test hook or via `NoopEmailProvider.lastVars.link` extraction — same pattern as `PasswordResetToken` test hook.

---

## Dependencies

- Phases 0–17 modules: `AuthModule` (`AuthService`, `JwtGuard`, `RateLimitGuard`, `UsersService`, `JwtStrategy tokenVersion`), `Users` entity, `PasswordResetToken`, `RefreshToken` (Phase 17, no mutation here), `Product`/`Inventory`/`Order`/`Reservation` invariants untouched, `AppModule` infra `TypeOrmModule` global `DataSource`, `JwtModule`, `CacheModule` (`CACHE_MANAGER` `createKeyv`), `ConfigModule`, `BullModule` shared `REDIS_URL`, `ClientsModule` RMQ `NOTIFICATION_SERVICE` if used, global `ValidationPipe`/`AllExceptionsFilter`/`Logger`.
- Config keys `ConfigService`: `JWT_SECRET`, `JWT_EXPIRES_IN=15m`, `REFRESH_TOKEN_TTL`, `RESET_TOKEN_TTL/EMAIL_RESET_TTL=15m`, `EMAIL_VERIFICATION_TTL=24h`, `EMAIL_PROVIDER`, `EMAIL_FROM`, `SMTP_HOST/PORT/USER/PASS/SECURE`, `EMAIL_SALES_BATCH_SIZE=500`, `FRONTEND_URL`, `REDIS_URL`, `RABBITMQ_URL`, `RATE_LIMIT_*` overrides, `REFRESH_TOKEN_COOKIE_*` (not used here). Never hardcode hosts/secrets/URLs.
- External: `bcrypt 10`, `passport-jwt`, `passport-google-oauth20` (Phase 16), `ioredis` via `cache-manager`/`bullmq`, `nodemailer` (smtp), optionally `@aws-sdk/client-ses` or `sendgrid` if `EMAIL_PROVIDER=ses|sendgrid`.

---

## Out of Scope (this phase)

- Changing checkout from cart-only (`POST /order/checkout {}`) or `Order`/`Reservation`/`Payment` state machines — Phase 18 is auth/email + notification only.
- Payment Stripe (`Payment`, `StripeWebhook`) — Phase 19 separate `payment` module replaces simulation.
- Dashboard RBAC `CoAdmin/ContentManager/FulfillmentStaff` and 5 metrics — Phase 20 separate `dashboard` module.
- WebSocket/Server-Sent-Events push or Firebase mobile push — marketing bulk is email-only here.
- Unsubscribe via `List-Unsubscribe` header + signed token (future, keep `PATCH /users/me/preferences` as V1 opt-out).
- Double opt-in confirmation for `marketingOptIn` beyond `emailVerified` gate (V1 trusts `PATCH` + `emailVerified`).
- Per-user daily `EMAIL_DAILY_LIMIT` frequency cap beyond bulk `24h` dedup (future `EMAIL_DAILY_LIMIT`).
- Template `i18n` / `A/B testing` / `MJML` rendering (V1 uses simple `subject/body` + `vars {firstName, productName, link}`).
- New `WSS/Ses` secret rotation or `SMTP_SECURE` `STARTTLS` handling beyond `587` default — use `EMAIL_PROVIDER` switch and `ConfigService`.

---

## Clarifications

### Session 2026-09-23 (Phase 18 kickoff — decisions from `docs/plan.md` §18)

- Q: Verification `Token` TTL — reuse `RESET_TOKEN_TTL=15m` or `24h`? → **A: `24h` for `EmailVerificationToken` (`EMAIL_VERIFICATION_TTL=24h`), `15m` for `PasswordResetToken` (`EMAIL_RESET_TTL`/`RESET_TOKEN_TTL`).** `user` has longer to click link than to reset password, avoid expiry churn.
- Q: `marketingOptIn` gate for `verify/reset` vs `sales/new_product`? → **A: Always send `verify` and `reset` regardless of `marketingOptIn`/`emailVerified`; `sales` and `new_product` require `User.marketingOptIn=true && User.emailVerified=true` — verification gate prevents sending marketing to unverified addresses, opt-in gate enforces policy.**
- Q: Bulk delivery after `createProduct` — synchronous vs async, dedup key? → **A: Async after commit via `BullMQ` (`notification.new_product`/`sendBulk`), worker pages `marketingOptIn+verified` with `EMAIL_SALES_BATCH_SIZE 500`, dedup `Redis SET NX notification:send:new_product:<productId>:<userId> EX 24h` (same pattern as `sales` `campaignId`).**
- Q: `POST /auth/resend-verification` anti-enumeration `200` vs `404`? → **A: `200 {message:"If an account exists, a verification email has been sent."}` always, same as `forgot-password` `200`, even when email not found or `emailVerified already true` — do not leak existence.**
- Q: Provider for V1 — `Noop` vs `Smtp` required now? → **A: V1 ships `EmailProvider` interface with `NoopEmailProvider` (dev/test, `Logger.log` + return `noop-<uuid>`) and `SmtpEmailProvider` (`nodemailer` + `SMTP_*`); selection `EMAIL_PROVIDER` via `ConfigService` default `noop`; `Ses`/`SendGrid` are optional wrappers keeping Noop contract, no live keys in CI.**

### Session 2026-09-23 (Clarification)

- Q: Should POST /auth/login require emailVerified before issuing JWT? → A: Allow unverified login — login succeeds even if emailVerified=false; verification gate applies only to sales/news broadcast (marketingOptIn && emailVerified), not to auth (checkout/login/refresh remain allowed).
- Q: How long should expired/used EmailVerificationToken and NotificationLog be retained before purge? → A: 7 days purge — nightly job DELETE EmailVerificationToken WHERE (usedAt IS NOT NULL AND usedAt < NOW() - INTERVAL '7 days') OR (expiresAt < NOW() - INTERVAL '7 days'); NotificationLog retained indefinitely for audit.
- Q: Does POST /admin/notifications/sales need a persistent Campaign entity or ephemeral job? → A: Ephemeral job only — no sales_campaign table V1; enqueue BullMQ job with title/body/campaignId and audit via NotificationLog only.
- Q: When resend-verification is called for already verified user, what response? → A: 200 already verified message — return 200 {message:"Email already verified"} without creating token or sending email (distinct from anti-enum message), slight state disclosure but improved UX for legitimate verified users.
- Q: For sales/new_product bulk dedup, should enforcement be Redis-only or Redis plus DB unique fallback? → A: Redis only — rely solely on Redis SET NX 24h notification:send:<template>:<id>:<userId>; when Redis unavailable (fail-open), duplicate send on retry is tolerated (logged) without DB unique constraint fallback.

