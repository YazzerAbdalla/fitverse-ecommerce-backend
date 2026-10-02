# Implementation Plan: Email Service — Phase 18

**Branch**: `014-email-service` | **Date**: 2026-09-23 | **Spec**: [spec.md](./spec.md)
**Input**: Feature specification from `/specs/014-email-service/spec.md` (Phase 18 — `EmailVerificationToken` `sha256` `24h` single-use `usedAt` + `User.marketingOptIn/emailOptIn` + `Notification`/`NotificationDelivery`/`NotificationLog` + `EmailProvider` `Noop/Smtp` via `EMAIL_PROVIDER=noop|smtp|resend` + `POST /auth/verify-email` `GET|POST` `FOR UPDATE` `200 vs 400` + `POST /auth/resend-verification` anti-enum `200` distinct verified `200` + `POST /auth/forgot-password` wired to `NotificationWorker` `15m` + `POST /admin/notifications/sales` `202` `BullMQ notification.sendBulk` `EMAIL_SALES_BATCH_SIZE 500` + `NotificationDispatcher` runtime three-flag gate + `Redis SET NX 24h` dedup (Redis-primary, PG unique backstop) + `PATCH /users/me/preferences` either-or flags + WS gateway + history/unread)

## Summary

Deliver async email after commit without blocking PostgreSQL transactions or making Redis/RabbitMQ authoritative: on `POST /auth/register 201` insert `EmailVerificationToken {userId, tokenHash=sha256(crypto.randomBytes(32)), expiresAt=now+24h, usedAt NULL}` after invalidating priors `SET usedAt=NOW() WHERE usedAt IS NULL` then emit `email.verification_requested {userId,email,rawToken}` via `RabbitMQ client.emit`/`BullMQ queue.add` outside `DataSource.transaction` to `EmailWorker` (`Noop` dev/test, `Smtp` prod via `nodemailer`) → `GET|POST /auth/verify-email {email,token}` does `SELECT ... FOR UPDATE where tokenHash=hash AND userId=user.id` → `usedAt NOT NULL OR expiresAt<=NOW() →400` else `usedAt=NOW() + User.emailVerified=true` `200 {verified:true}` single-winner `Promise.all`. `POST /auth/resend-verification` anti-enum `200` (distinct `200 Email already verified` when verified) with dual rate-limit `5/IP+3/email+60s cooldown` via `RateLimitGuard` fail-open. Upgrade `POST /auth/forgot-password` existing `PasswordResetToken 15m` to actually emit `auth.password_reset_requested` consumed by `EmailWorker`. Add `NotificationService` `POST /admin/notifications/sales {title,body,productIds?} →202 {jobId}` (Admin) enqueue `BullMQ notification.sendBulk` fan-out paging `Users WHERE marketingOptIn=true AND emailVerified=true` `500` cursor with `Redis SET NX notification:send:<template>:<campaignId|productId>:<userId> EX 24h` Redis-only dedup + `NotificationLog` audit, idempotent replay `0` duplicate + `PATCH /users/me/preferences {marketingOptIn}`. Ephemeral `campaignId` (no `sales_campaign` table V1), `7d` purge for `EmailVerificationToken` only, login remains unverified-allowed (clarified), all `FOR UPDATE` serialized, `client.emit` never inside transaction (SC-007 proof). 8 SCs with real PG `--runInBand`.

## Technical Context

**Language/Version**: TypeScript 5.7.3 / Node 20, NestJS 11  
**Primary Dependencies**: `@nestjs/typeorm` 11 + `typeorm` 1.1 + `pg` 8.22, `@nestjs/jwt` 11 + `JwtService.signAsync` (`JWT_SECRET`, `JWT_EXPIRES_IN=15m`), `passport-jwt` + `passport-local` + `passport-google-oauth20`, `bcrypt` 10, `class-validator`/`class-transformer` (`ValidationPipe whitelist/forbidNonWhitelisted/transform`), `@nestjs/cache-manager` + `@keyv/redis` + `ioredis` 5.11 (shared `REDIS_URL` for `RateLimitGuard rl:* INCR+EXPIRE` fail-open outermost + `resend:cooldown NX EX 60` + `notification:send:* SET NX EX 86400` Redis-only), `@nestjs/bullmq` 11 + `bullmq` 5.20 + `@nestjs/microservices` RMQ transport 11 (shared `RABBITMQ_URL`, `REDIS_URL` for `BullMQ` same as `CacheModule` `createKeyv`), `@nestjs/config` `ConfigService` (`EMAIL_VERIFICATION_TTL=24h`, `EMAIL_RESET_TTL=15m`/`RESET_TOKEN_TTL`, `EMAIL_PROVIDER=noop`, `EMAIL_FROM`, `SMTP_HOST/PORT/USER/PASS/SECURE`, `EMAIL_SALES_BATCH_SIZE=500`, `FRONTEND_URL`, `RATE_LIMIT_*`), `nodemailer` 6.9.14 (Smtp; `smtp` and `resend` both select it), `crypto` (`randomBytes 32 → hex 64`, `createHash sha256`), `cookie-parser` 1.4.6 already from Phase 17. No new payment/dashboard deps.  
**Storage**: PostgreSQL 17 via TypeORM (`synchronize:false`, migration `17xxxxxxxxxx-AddEmailVerificationAndMarketingOptIn` — `EmailVerificationToken` `id uuid PK`, `userId FK CASCADE @Index`, `tokenHash varchar(255) @Index`, `expiresAt timestamptz CHECK expiresAt>createdAt`, `usedAt nullable`, `createdAt`; `User` `marketingOptIn boolean NOT NULL DEFAULT false`; `NotificationLog` `id uuid PK`, `userId FK CASCADE @Index`, `template varchar @Index`, `subject`, `productId FK SET NULL @Index`, `orderId FK SET NULL @Index`, `provider`, `messageId nullable`, `sentAt`; indexes `IDX_*_userId_tokenHash_expiresAt`, composite `userId,expiresAt`, `(userId,sentAt)`, `(template,sentAt)`; no partial unique on `EmailVerificationToken` V1, no `sales_campaign` table V1 per clarification ephemerals); Redis 8 ephemeral for `rl:GET|POST /auth/verify-email:ip:* 10/3600` + `rl:POST /auth/resend-verification:ip 5/3600` + `rl:POST /auth/resend-verification:email 3/3600` + `resend:cooldown EX 60` + `rl:POST /admin/notifications/sales:user 10/3600` + `notification:send:sales:<campaignId>:<userId> 24h` + `notification:send:new_product:<productId>:<userId> 24h` Redis-only; RabbitMQ 4 `email.verification_requested` + `auth.password_reset_requested` + `auth.email_verified` optional events (publish after commit).  
**Testing**: Jest unit (mock `DataSource`/`EntityManager getRepository` spies + `CACHE_MANAGER` mock `get/set/del` `FLUSHDB` + `EmailProvider` mock `send` + `ConfigService parseTtlMs` + `BullMQ Queue add` mock) + integration real PG `FOR UPDATE` deterministic + real Redis `FLUSHDB` `--runInBand` + `EXPLAIN` for `tokenHash`/`userId` indexes + E2E `supertest` `register→verify single-use+concurrent 200+400→resend anti-enum+60s 429→forgot-password wired→admin sales 10-users 5+verified gate+replay 0 dedup→preferences opt-in→GET /users/me` (`npm run build`, `npm run lint`). No `stock`/`reservedAmount` mutation from email paths (`UPDATE inventory 0` proof).  
**Target Platform**: Linux server (NestJS HTTP via `docker-compose.yml`: postgres 17, redis 8, rabbitmq 4) — same as Phases 1-13, no frontend.  
**Project Type**: Modular monolithic backend — auth + notification domains; email is auth-scoped verification + marketing fan-out, orthogonal to `inventory`/`reservation`/`order` (those `CHECK FOR UPDATE` untouched, email touches zero `stock`).  
**Performance Goals**: `POST /auth/register` (`bcrypt 10` + `INSERT EmailVerificationToken 24h` + `emit`) p95 <350ms; `GET|POST /auth/verify-email` (`FOR UPDATE` + `sha256` + `UPDATE usedAt` + `User.emailVerified`) p95 <40ms; concurrent `verify` same hash `Promise.all` single-winner p95 <60ms; `POST /auth/resend-verification` (`SET NX cooldown 60s` + `FOR UPDATE` invalidate priors) p95 <30ms (`429` `0 transaction` <5ms); `POST /auth/forgot-password` (`FOR UPDATE` + `emit`) p95 <30ms; `POST /admin/notifications/sales 202` enqueue p95 <20ms; bulk worker `500/batch` `concurrency 5` `SET NX 24h` p95 <2ms per `SET NX` + `EmailProvider.send` Noop <1ms (Smtp prod ~50ms but outside transaction); `PATCH /users/me/preferences` `FOR UPDATE User` p95 <20ms; `429` path `0 DataSource.transaction`; `SET NX`/`INCR` rate-limit p95 <2ms (fail-open on `ECONNREFUSED`).  
**Constraints**: `synchronize:false` (migration only); PG authoritative (constitution I) — `EmailVerificationToken` truth, `NotificationLog` audit truth, Redis `rl:*`/`notification:send:*` is dedup/rate-limit cache only (Redis-only per clarification, duplicate tolerated on `ECONNREFUSED` fail-open `Logger.warn`); `RateLimitGuard` outermost `@UseGuards(RateLimitGuard)` before `JwtGuard`/`ValidationPipe` so `429` holds no `FOR UPDATE` lock; `ValidationPipe whitelist/forbidNonWhitelisted` rejects unknown fields before idempotent `200`; `AllExceptionsFilter` serializes `400/401/403/429` + forwards `Retry-After`/`X-RateLimit-*`; `Logger` only (no `console.log`); `ConfigService` for all TTLs/secrets/hosts; `FOR UPDATE` single-winner deterministic (no `SKIP LOCKED` for verify); `client.emit`/`queue.add` ONLY after `commit` (never inside `dataSource.transaction` block, `grep -c` proof).  
**Scale/Scope**: Touches `src/modules/auth/auth.service.ts` (new `requestEmailVerification`/`verifyEmail`/`resendVerification` + modify `register` fire-and-forget + wire `forgotPassword` emit + `purgeExpiredVerificationTokens`), `auth.controller.ts` (3 routes `GET|POST verify` + `POST resend`), `entities/email-verification-token.entity.ts` **new**, `dto/verify-email.dto.ts` + `dto/resend-verification.dto.ts` **new**, provider in `src/modules/notifications/email.provider.ts` (extended) + `smtp-email.provider.ts` **new**, `src/modules/notifications/` channels/dispatcher/gateway/bulk-processor/history (see tree above), `src/modules/users/` flags + prefs + `users.controller.ts` **new**, `src/modules/messaging/messaging.module.ts` **new** (@Global RMQ client), `src/migration/1755900000006/0007/0008/0009` **new**, `guards/rate-limit.guard.ts` (+5 keys), `src/app.module.ts` (MessagingModule), `.env/.env.example` (EMAIL_*/WS_*); 0 inventory/reservation/order semantic changes.

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-check after Phase 1 design.*

| Principle | Status | Evidence |
|-----------|--------|----------|
| **I. PostgreSQL is source of truth** | ✅ PASS | `EmailVerificationToken` hashed `sha256` `expiresAt>createdAt CHECK` `usedAt` single-use + `User.marketingOptIn` default false + `NotificationLog` audit are PG truth (`synchronize:false` migration); Redis holds only `rl:*`/`resend:cooldown`/`notification:send:*` ephemeral `EX 60/3600/86400` `FLUSHDB` loses limiter/dedup but PG `FOR UPDATE` still serializes `verify` single-winner and `NotificationLog` remains; RabbitMQ/BullMQ events `email.verification_requested` etc. published ONLY after `commit` (never inside `manager`); `grep -c "client.emit" src/modules/auth/auth.service.ts` `0` inside transaction proof required. |
| **II. Modular monolith — no premature microservices** | ✅ PASS | Single Nest process augmentation: `AuthModule` owns `EmailVerificationToken` + `EmailProvider` + `verify/resend` business API (`register` after-commit hook), `NotificationModule` owns `NotificationLog` + `sendSalesCampaign`/`onProductCreated` bulk + `NotificationWorker` (same `BullMQ` `REDIS_URL` as `CacheModule`), `UsersModule` owns `User.marketingOptIn` via `PATCH /users/me/preferences`; cross-module only via exported services (`AuthService`, `NotificationService`, `UsersService`), no `@InjectRepository(EmailVerificationToken)` outside `AuthModule`. No new deployable. |
| **III. Inventory/Reservation separate domains, explicit lifecycle** | ✅ PASS | No domain change: `Product` no `stock`, `Inventory available=stock-reservedAmount` derived `CHECK`, `Reservation RESERVED→EXPIRED/COMPLETED/CANCELLED` one-way; email `verify` `usedAt` single-use is independent but follows same PG `FOR UPDATE` pattern; bulk `sales/new_product` never mutates `stock`/`reservedAmount` (`UPDATE inventory` `0` SC-006/SC-008 proof); `cart` still not mutating inventory. |
| **IV. Concurrency safety at DB level (no overselling)** | ✅ PASS | `verifyEmail` uses `SELECT EmailVerificationToken WHERE tokenHash=hash AND userId=:id FOR UPDATE` inside `dataSource.transaction` to serialize concurrent `Promise.all([verify,verify])` single-winner `200+400` (same as refresh token pattern Phase 17); `requestEmailVerification` invalidate priors `SET usedAt=NOW() WHERE userId AND usedAt IS NULL` inside `FOR UPDATE` ordering; bulk `notification:send:* SET NX` Redis-only is idempotency guard before `EmailProvider.send`, but verification truth remains PG `usedAt`; no oversell path (no `stock` mutation). |
| **V. Module boundaries, service-only collaboration** | ✅ PASS | `AuthService` owns `EmailVerificationToken` (`requestEmailVerification` fire-and-forget, `verifyEmail FOR UPDATE`, `resendVerification` cooldown+invalidate, `register` hook), `NotificationService` owns `NotificationLog`/bulk (`sendSalesCampaign` validate `title 1-200` + `BullMQ add`, `onProductCreated` hook), `UsersService` owns `User` (`findByEmail`, `updatePreferences FOR UPDATE`, `GET /users/me`); `ProductsService.create` after-commit calls `notificationService.onProductCreated` via injected service (not repo); `AuthController` thin (`@Query`/`@Body` → service), `NotificationController` thin `POST /admin/notifications/sales @Auth(Admin)` + `RateLimitGuard`. |
| **VI. Spec-driven development** | ✅ PASS | Spec `spec.md` + 10 clarifications (5 kickoff `docs/plan.md` §18 `24h/marketingOptIn+verified/async dedup/200 anti-enum/Noop` + 5 session 2026-09-23 `unverified login Allow / 7d purge / ephemeral job only / 200 already verified msg / Redis only`) done before plan; no future phase (Payment 19 `Stripe` / Dashboard 20 RBAC) implemented; Phase 18 is email-only orthogonal to Phases 7-13 per plan §18 rationale. |
| **VII. Tests mandatory, DB-backed for consistency** | ✅ PASS | Integration real PG `FOR UPDATE` deterministic + real Redis `FLUSHDB` `--runInBand` + `EXPLAIN` for `tokenHash`/`userId` + concurrent verify `200+400` + bulk `10 users 5 gate + replay 0` + cooldown `60s 429` + `FOR UPDATE` idempotency; unit mocks `DataSource` `CACHE_MANAGER SET NX/INCR` + `EmailProvider.send` + `BullMQ Queue`; E2E `supertest` `register→verify 200→reuse 400→resend anti-enum→forgot→validate→reset→preferences→admin sales 202→worker NotificationLog 5`; DB for consistency not mocked. |
| **VIII. No invented APIs/payments/business rules** | ✅ PASS | Routes are spec-driven only: `GET /auth/verify-email?token&email` + `POST /auth/verify-email {email,token}` (FR-006) `400` vs `200`, `POST /auth/resend-verification {email}` `200` anti-enum vs `200 verified` distinct + `429 cooldown 60s` (FR-007/009), `POST /auth/forgot-password` wired `auth.password_reset_requested` (FR-008), `POST /admin/notifications/sales {title,body,productIds?} 202 {jobId}` episodic `Admin` (FR-010), `PATCH /users/me/preferences {marketingOptIn}` (FR-012); no `Payment`/invented field; `title 1-200` + `FRONTEND_URL` link + `EMAIL_SALES_BATCH_SIZE 500` per FR-013. |
| **IX. Documentation is part of work** | ✅ PASS | This plan + `research.md` (D1-D8), `data-model.md` (EmailVerificationToken + User marketingOptIn + NotificationLog + lifecycle/retention), `contracts/email-contracts.md` (5 endpoints + dedup/rate-limit headers/Swagger), `quickstart.md` (`.env` 5 vars `EMAIL_*` + `docker-compose` + `npm run build/migration:run` + manual `register→verify→concurrent→resend 429→forgot wired→admin sales 10→preferences`, `psql` SELECT, `FLUSHDB`), `AGENTS.md` marker updated to this plan, `docs/architecture/email-service.md` + `docs/decisions/ADR-email-service.md`. |

**Gate result**: **PASS** — no violations. Post-design re-check below remains **PASS** (email is PG `FOR UPDATE` + Redis-only dedup/rate-limit after commit, not a new authoritative store).

## Delivery-State Model (2026-10-01: SENT_TO_MQ vs CONSUMED vs DELIVERED)

Answers "was event only accepted by RabbitMQ transport, vs received/consumed by worker (manual ACK), vs actually sent to user via channel". Chosen option: **separate `NotificationDelivery` row per `(eventId, channel)`**, keeping `OutboxEvent` as MQ-leg truth — justified per constitution I (PG truth for both legs, Redis only for `SET NX` dedup) and module boundaries (`OutboxModule` owns `OutboxEvent`; `NotificationsModule` owns `Notification`/`NotificationDelivery`; no cross-repo).

```text
Publisher (OutboxModule)                     Consumer (NotificationsModule)              Channels
PENDING ──FOR UPDATE SKIP LOCKED──▶ PROCESSING ──client.emit OK──▶ SENT_TO_MQ ──@EventPattern + SET NX──▶ CONSUMED ──dispatch──▶ DELIVERED
   │                                     │                          │                         (all resolved deliveries DELIVERED)
   │                                     └──emit throw──▶ PENDING   └──duplicate eventId──▶ skip (INCR, 0 rows, ACK)
   │                                         (attempts++, backoff)     (ACK after CONSUMED commit; throw → no ACK → requeue)
   └──400/409/429──▶ 0 rows                 └──attempts>=5──▶ FAILED ──PATCH /admin/outbox/:id/requeue──▶ PENDING
                                                      (retained)                              (CONSUMED/DELIVERED never revert)
Channel leg per (eventId, channel): PENDING → SENT (persisted/emitted) → DELIVERED (WS ack / EmailProvider messageId) → FAILED (after 3, retained per-channel)
READ (user behavior, not delivery): Notification.isRead false → true via PATCH :id/read | read-all (idempotent 200)
```

**Who writes each state**: publisher → `PENDING/PROCESSING/SENT_TO_MQ/FAILED` (`processingToken` ownership + token-checked updates unchanged); consumer → `CONSUMED` (`SELECT OutboxEvent FOR UPDATE WHERE id=:eventId`, verify `SENT_TO_MQ`, set `consumedAt`) + upsert `NotificationDelivery PENDING` per `NotificationDispatcher.dispatch` channels; channel strategy → `SENT/DELIVERED/FAILED` on its delivery row. `SENT` renamed `SENT_TO_MQ` via new migration (backward-compat `SENT` alias in code; never edit committed migrations).

**Class layout** (all under existing `src/modules/notifications/`, AGENTS.md §3 JSDoc required):

```text
src/modules/notifications/
├── channels/
│   ├── notification-channel.interface.ts  # NEW — interface NotificationChannel { key:'system'|'email'; send(...): Promise<{messageId?, delivered:boolean}> }
│   ├── system.channel.ts                   # NEW — SystemChannel: persist Notification PG + WebSocketGateway emit notification:new; offline → stays SENT
│   ├── email.channel.ts                     # NEW — EmailChannel: wraps EMAIL_PROVIDER send → {messageId, delivered:true}
│   └── notification-channel.factory.ts      # NEW — NotificationChannelFactory.create(channel): strategy (extensible to sms|push)
├── notification.dispatcher.ts               # NEW — NotificationDispatcher.dispatch(event, userPrefs): runtime channel resolution (verify/reset both always; sales gated; order.* email iff emailOptIn)
├── notifications.gateway.ts                 # NEW — @WebSocketGateway({namespace:'notifications'}) JWT handleConnection → room user:<sub>; events notification:new + notification:read
├── notifications.controller.ts              # NEW — GET /notifications + GET /notifications/unread-count + PATCH :id/read + PATCH read-all (thin, owner-scoped)
├── entities/
│   ├── notification.entity.ts               # NEW — Notification (history truth, data-model §3b)
│   └── notification-delivery.entity.ts      # NEW — NotificationDelivery (per-channel leg, data-model §3c)
└── notifications.worker.ts                  # MODIFY — CONSUMED update + dispatcher + manual ACK after commit (existing file)
src/modules/outbox/entities/outbox-status.enum.ts  # MODIFY — SENT_TO_MQ + CONSUMED + DELIVERED (+ SENT alias)
src/migration/17xxxxxxxxxx-NotificationDeliveryAndHistory.ts  # NEW — enum values + Notification + NotificationDelivery + User.emailOptIn + OutboxEvent.consumedAt
```

**Migration plan**: one new migration (never edit committed): enum widen (`SENT_TO_MQ`, `CONSUMED`, `DELIVERED`); `ALTER TABLE "user" ADD COLUMN "emailOptIn" boolean NOT NULL DEFAULT true`; `ALTER TABLE outbox_event ADD COLUMN consumedAt`; `CREATE TABLE notification (...)` + `CREATE TABLE notification_delivery (...)` + indexes/`UQ(eventId,channel)`s. `synchronize:false`.

**Config keys** (all via `ConfigService`, never hardcoded): existing `EMAIL_*`/`FRONTEND_URL`/`REDIS_URL`/`RABBITMQ_URL` plus `WS_AUTH=true`, `NOTIFICATION_HISTORY_PAGE_SIZE=20`.

## Project Structure

### Documentation (this feature)

```text
specs/014-email-service/
├── plan.md              # This file (/speckit.plan command output)
├── research.md          # Phase 0 output — decisions D1-D8 (hash vs raw, 24h vs 15m, Noop vs Smtp, async after commit RabbitMQ vs BullMQ, Redis-only dedup, ephemeral campaign, verified login gate, pagination 500)
├── data-model.md        # Phase 1 output — EmailVerificationToken (tokenHash sha256 CHECK, usedAt, indexes, retention 7d), User marketingOptIn, NotificationLog audit, lifecycle register→verify/resend/forgot vs sales/new_product fan-out
├── quickstart.md        # Phase 1 output — setup .env EMAIL_* 5 vars, SMTP, docker-compose, npm run build/migration:run, manual flows, psql SELECT, 429, tests
├── contracts/
│   └── email-contracts.md # Phase 1 output — GET|POST /auth/verify-email (query|body, FOR UPDATE, 200 vs 400, 10/IP), POST /auth/resend-verification (200 anti-enum vs 200 verified + cooldown 60s 3/h+5/IP), POST /auth/forgot-password wired 200, POST /admin/notifications/sales 202 Admin 10/user, PATCH /users/me/preferences JwtGuard 200 + GET /users/me
├── checklists/
│   └── requirements.md  # Spec quality checklist (16/16 pass)
└── tasks.md             # Phase 2 output (/speckit.tasks — NOT created by /speckit.plan)
```

### Source Code (repository root)

```text
src/
├── modules/
│   ├── auth/
│   │   ├── entities/
│   │   │   ├── email-verification-token.entity.ts # NEW — EmailVerificationToken {id,userId,tokenHash,expiresAt,usedAt,createdAt} + @Check expiresAt>createdAt + @Index userId/tokenHash/expiresAt + composite
│   │   │   ├── password-reset-token.entity.ts     # existing — reference (FOR UPDATE pattern, 15m)
│   │   │   └── otp-verification.entity.ts         # existing
 │   │   ├── dto/
 │   │   │   ├── user-register.dto.ts               # MODIFY — add marketingOptIn?/emailOptIn? @IsOptional @IsBoolean
 │   │   │   ├── verify-email.dto.ts                # NEW — VerifyEmailDto {email @IsEmail, token @IsString @Length(64,64) @Matches(/^0-9a-f{64}$/)} reused for GET query + POST body
 │   │   │   └── resend-verification.dto.ts         # NEW — ResendVerificationDto {email @IsEmail}
 │   │   ├── guards/
 │   │   │   └── rate-limit.guard.ts                # MODIFY — DEFAULT_LIMITS += verify 10/IP, resend dual 5/IP+3/email (+60s cooldown in service), sales 10/user, test-email 10/user; perUserRoutes += sales/test-email
 │   │   ├── auth.service.ts                        # MODIFY — requestEmailVerification/verifyEmail/resendVerification + register hook + forgotPassword emit + purgeExpiredVerificationTokens (see FR-005..008)
 │   │   ├── auth.controller.ts                     # MODIFY — GET|POST /auth/verify-email + POST /auth/resend-verification (RateLimitGuard outermost, Swagger)
 │   │   └── auth.module.ts                         # MODIFY — forFeature += EmailVerificationToken; EMAIL_PROVIDER useFactory (smtp|resend→Smtp else Noop)
 │   ├── notifications/                             # EXISTING MODULE — reused, no singular sibling (see research D12)
 │   │   ├── entities/
 │   │   │   ├── notification.entity.ts             # NEW — Notification history truth, @Unique(eventId,channel)
 │   │   │   ├── notification-delivery.entity.ts    # NEW — per-channel leg, @Unique(eventId,channel)
 │   │   │   ├── notification-channel.enum.ts + notification-status.enum.ts  # NEW
 │   │   │   └── notification-log.entity.ts         # EXISTING audit (migration 0008 backfilled table)
 │   │   ├── channels/                              # NEW — Strategy + Factory (D12)
 │   │   ├── notification.dispatcher.ts             # NEW — runtime three-flag gate
 │   │   ├── notification.service.ts                # NEW — sendSalesCampaign 202 + onProductCreated hook
 │   │   ├── notification-bulk.processor.ts         # NEW — @Processor('notification') bulk fan-out
 │   │   ├── notifications.worker.ts                # MODIFY — RMQ consume + CONSUMED/delivery writes + manual ACK
 │   │   ├── notifications.gateway.ts               # NEW — WS namespace + history controller extension
 │   │   └── dto/ test-email.dto.ts + create-sales-notification.dto.ts + notification-history-query.dto.ts
 │   ├── users/
 │   │   ├── entity/user.entity.ts                  # MODIFY — += marketingOptIn (false) + emailOptIn (true)
 │   │   ├── dto/update-preferences.dto.ts          # NEW — both flags @IsOptional (either-or)
 │   │   ├── users.service.ts                       # MODIFY — updatePreferences FOR UPDATE + createNewUser passes flags
 │   │   └── users.controller.ts                    # NEW — GET /users/me + PATCH /users/me/preferences
 │   ├── products/
 │   │   └── products.service.ts                    # MODIFY — create() after-commit onProductCreated hook (fire-and-forget)
 │   │   └── products.module.ts                     # MODIFY — imports NotificationsModule (acyclic)
 │   ├── messaging/                                 # NEW — @Global MessagingModule: single NOTIFICATION_SERVICE RMQ client
 │   └── inventory/ reservation/ order/ cart        # UNCHANGED — zero mutation by email/notification (SC-006 proof)
 │   ├── app.module.ts                              # MODIFY — imports MessagingModule (replaces inline ClientsModule RMQ block)
 │   ├── main.ts                                    # VERIFY — cookieParser kept, ValidationPipe whitelist/forbidNonWhitelisted
 │   ├── migration/                                 # APPLIED — 1755900000006 (tokens+Notification/Delivery+emailOptIn+enum widen) + 0007 (RefreshToken FK fix) + 0008 (notification_log backfill) + 0009 (refresh_token rename); 0005 recorded --fake (unexecutable capital-User FK)
 │   ├── .env / .env.example                        # MODIFY — EMAIL_PROVIDER=noop|smtp|resend, EMAIL_FROM, SMTP_*, EMAIL_VERIFICATION_TTL=24h, EMAIL_RESET_TTL=15m, EMAIL_SALES_BATCH_SIZE=500, FRONTEND_URL, WS_AUTH, NOTIFICATION_HISTORY_PAGE_SIZE
 │   └── docs/architecture/
 │       └── email-service.md / ADR-email-service.md # NEW — see T054
```

**Structure Decision**: Single project (Option 1) — auth-scoped verification (`EmailVerificationToken` `FOR UPDATE` `sha256` + `EmailProvider Noop/Smtp` + `RateLimitGuard` dual+cooldown) plus bulk fan-out in the existing `notifications` module (`Notification`/`Delivery`/`Log` + `BullMQ` `500` + `SET NX 24h` Redis-primary/PG-backstop) after commit; `@Global MessagingModule` for the single RMQ client; no new top-level app, `synchronize:false`, single `DataSource`/`CACHE_MANAGER`/`BullMQ` reuse per `AGENTS.md`.

## Complexity Tracking

> Fill ONLY if Constitution Check has violations that must be justified

| Violation | Why Needed | Simpler Alternative Rejected Because |
|-----------|------------|-------------------------------------|
| — | — | — |

*No violations — all gates PASS. Email is additive `if !found || usedAt || expiresAt<=NOW →400` + `SET NX 24h` Redis-only dedup before `EmailProvider.send` outside transaction, not a new authoritative store for business truth.*

---

## Phase 0: Research (completed → research.md)

All `NEEDS CLARIFICATION` resolved (0 in Technical Context; 10 clarifications in spec §Clarifications + 2026-10-01 delivery-state session). Key decisions: D1 sha256 hashing vs raw, D2 24h vs 15m TTL, D3 Noop vs Smtp (+resend→SMTP) provider switch, D4 async after commit RabbitMQ vs BullMQ shared infra, D5 unverified login Allow vs Block, D6 resend verified distinct 200 vs same anti-enum, D7 ephemeral vs persistent campaign, D8 Redis-primary (+PG unique backstop) vs Redis-only, D9-D12 delivery-state/channels (see `research.md`).

## Phase 1: Design (completed)

- **Data model** → [data-model.md](./data-model.md): `EmailVerificationToken` PG `tokenHash sha256 CHECK expiresAt>createdAt usedAt` + indexes `(userId,tokenHash,expiresAt)` + retention `7d` purge, `User.marketingOptIn default false` + `emailOptIn default true` + `emailVerified` one-way, `Notification`/`NotificationDelivery` PG user-leg truth (`@Unique(eventId,channel)`, `isRead/readAt`) + `NotificationLog` audit, ephemeral `campaignId` (no table V1), lifecycle `register→verify/resend/forgot vs sales/new_product fan-out`, `OutboxStatus` extension `SENT_TO_MQ→CONSUMED→DELIVERED`.
- **Contracts** → [contracts/email-contracts.md](./contracts/email-contracts.md): `GET|POST /auth/verify-email` (query|body `FOR UPDATE` `200{verified:true}` vs `400` + `10/IP`), `POST /auth/resend-verification` (`200` anti-enum vs `200 verified` distinct + `cooldown 60s` `3/h email`+`5/h IP` `429`), `POST /auth/forgot-password` wired `200`, `POST /admin/notifications/sales 202 Admin 10/user` + `POST /admin/notifications/test-email 200 Admin 10/user` (config probe), `BullMQ sendBulk 500`, `PATCH /users/me/preferences` either-or flags + `GET /users/me`, history `GET /notifications` + `unread-count` + `PATCH :id/read` + `read-all`, WS `notifications` namespace.
- **Quickstart** → [quickstart.md](./quickstart.md): `.env EMAIL_*` (`EMAIL_PROVIDER=noop|smtp|resend` + `SMTP_*` + `FRONTEND_URL` + `WS_*`), `docker-compose up -d`, `npm run build` + migration baseline procedure, manual `register→verify 200→concurrent 200+400→resend 429 60s→forgot wired→test-email→admin sales→preferences→history/unread`, `psql SELECT` proofs, `FLUSHDB` `429` `SET NX` `EXPLAIN`.
- **Agent context** → `AGENTS.md` marker `<!-- SPECKIT START -->` … `<!-- SPECKIT END -->` updated to point to this plan (`specs/014-email-service/plan.md`).

### Agent context update

`AGENTS.md` marker updated to this plan. Verify with `grep -n SPECKIT AGENTS.md`.

## Re-evaluated Constitution Check (post-design)

No new code or decisions in Phase 1 violate principles. Post-design gate remains **PASS** on all nine principles (same table as above). Email `FOR UPDATE` single-winner + Redis-only `SET NX` deduplication strengthens Principle IV without making Redis authoritative; `EmailProvider` is transport only.

## Next Steps (Phase 2 — not in this command)

`/speckit.tasks` will break Phase 18 into ordered tasks (e.g.: 1) add `EmailVerificationToken` entity + `User.marketingOptIn` + `NotificationLog` entities + migration `17xxxxxxxxxx-AddEmailVerificationAndMarketingOptIn` + `CHECK`/`FK`; 2) add `VerifyEmailDto`/`ResendDto` + `UpdatePreferencesDto` + extend `RegisterDto marketingOptIn`; 3) add `EmailProvider` interface + `Noop`+`Smtp` + `EMAIL_PROVIDER` switch; 4) extend `RateLimitGuard` 4 keys + dual email+IP + cooldown `NX EX 60`; 5) implement `AuthService.requestEmailVerification`+`verifyEmail FOR UPDATE`+`resendVerification cooldown+invalidate`+`register` fire-and-forget + wire `forgotPassword` emit after commit; 6) add `AuthController` `GET|POST verify` + `POST resend` + Swagger `200/400/429`; 7) create `NotificationModule` `NotificationService sendSalesCampaign`+`onProductCreated` + `NotificationWorker @Processor` `500` `SET NX 24h` Redis-only + `NotificationLog` + `POST /admin/notifications/sales 202 Admin`; 8) extend `UsersService`/`UsersController` `PATCH /users/me/preferences FOR UPDATE`; 9) integration real PG `--runInBand` `FOR UPDATE` concurrent `200+400` + `resend 60s 429` + bulk `10 users 5 gate replay 0` + `500` cursor + `FOR UPDATE` `SHA256` `EXPLAIN`; 10) E2E `supertest` `register→verify→resend anti-enum→forgot reset→preferences→admin sales→new_product`; 11) `quickstart` + `.env.example` + `docs/email-service.md`/`ADR-email-service.md` + `npm run lint/build/test -- --runInBand/test:e2e`).
