---
description: "Task list for Email Service — Phase 18 implementation"
---

# Tasks: Email Service — Phase 18

**Input**: Design documents from `/specs/014-email-service/`  
**Prerequisites**: plan.md (required), spec.md (required), research.md, data-model.md, contracts/, quickstart.md  
**Branch**: `014-email-service` | **Spec**: [spec.md](./spec.md) | **Plan**: [plan.md](./plan.md)

**Tests**: Included per spec §6 Testing Rules (unit + integration real PG `--runInBand` + E2E `supertest`). Tests are mandatory — DB consistency MUST NOT be mocked.

**Organization**: Tasks grouped by user story — each story independently implementable, testable, deliverable.

## Format: `[ID] [P?] [Story] Description`

- **[P]**: Can run in parallel (different files, no dependencies)
- **[Story]**: Which user story this task belongs to (US1, US2, US3, US4, US5)
- Include exact file paths in descriptions

## Path Conventions

- Single project: `src/` at repository root (`src/modules/auth`, `src/modules/notification`, `src/modules/users`)
- Tests: `src/modules/<name>/test/` unit + `test/` e2e (`jest` `ts-jest`, `supertest`)

---

## Phase 1: Setup (Shared Infrastructure)

**Purpose**: Project initialization and env/dependency baseline

- [X] T001 Verify branch `014-email-service` checked out and run `npm install` for `nodemailer` + `@types/nodemailer` in `package.json`
- [X] T002 [P] Add email env vars to `.env.example` in `.env.example` (`EMAIL_PROVIDER`, `EMAIL_FROM`, `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASS`, `SMTP_SECURE`, `EMAIL_VERIFICATION_TTL`, `EMAIL_RESET_TTL`, `EMAIL_SALES_BATCH_SIZE`, `FRONTEND_URL`)
- [ ] T003 [P] Configure `ConfigService` TTL parser to support `EMAIL_VERIFICATION_TTL` `24h` and `EMAIL_SALES_BATCH_SIZE` default `500` in `src/modules/auth/auth.service.ts` and `src/modules/notification/notification.service.ts`
- [ ] T004 Confirm `docker-compose.yml` infra `postgres:17`, `redis:8`, `rabbitmq:4` running via `docker-compose up -d` and `npm run build` passes (DEFERRED 2026-10-01: docker daemon down, `npm run build` passes)

---

## Phase 2: Foundational (Blocking Prerequisites)

**Purpose**: Core entities, provider abstraction, and shared guard config that ALL user stories depend on

**⚠️ CRITICAL**: No user story work can begin until this phase is complete

- [X] T005 [P] Create `EmailVerificationToken` entity in `src/modules/auth/entities/email-verification-token.entity.ts` (id uuid PK, userId FK CASCADE @Index, tokenHash varchar 255 @Index sha256, expiresAt timestamptz CHECK>createdAt @Index, usedAt nullable, createdAt; indexes `tokenHash`, `userId`, `expiresAt`, composite `userId,expiresAt`)
- [X] T006 [P] Modify `User` entity to add `marketingOptIn` column in `src/modules/users/entity/user.entity.ts` (`boolean NOT NULL DEFAULT false` `@Column({default:false})`)
- [X] T007 [P] Create `NotificationLog` entity in `src/modules/notification/entities/notification-log.entity.ts` (id uuid PK, userId FK CASCADE @Index, template @Index, subject, productId FK SET NULL @Index, orderId FK SET NULL @Index, provider, messageId nullable, sentAt @CreateDateColumn; indexes `(userId,sentAt)`, `(template,sentAt)`)
- [X] T008 Create TypeORM migration `17xxxxxxxxxx-AddEmailVerificationAndMarketingOptIn` in `src/migration/17xxxxxxxxxx-AddEmailVerificationAndMarketingOptIn.ts` (ALTER user ADD marketingOptIn; CREATE tables EmailVerificationToken + notification_log + CHECK + FK + indexes; no `sales_campaign` table V1)
- [X] T009 [P] Define `EmailProvider` interface in `src/modules/auth/providers/email.provider.ts` (`send(to, subject, template:'verify'|'reset'|'sales'|'new_product', vars): Promise<{messageId}>`)
- [X] T010 [P] Implement `NoopEmailProvider` in `src/modules/auth/providers/noop-email.provider.ts` (`Logger.log [NoopEmail]`, `lastVars`/`lastLink` capture for tests, return `noop-<uuid>`)
- [X] T011 [P] Implement `SmtpEmailProvider` in `src/modules/auth/providers/smtp-email.provider.ts` (`nodemailer.createTransport` with `SMTP_HOST/PORT/USER/PASS/SECURE` via `ConfigService`, `from=EMAIL_FROM`)
- [X] T012 Create `VerifyEmailDto` in `src/modules/auth/dto/verify-email.dto.ts` (`email @IsEmail`, `token @IsString @Length(64,64) @Matches(/^[0-9a-f]{64}$/)`) reused for GET query + POST body
- [X] T013 Create `ResendVerificationDto` in `src/modules/auth/dto/resend-verification.dto.ts` (`email @IsEmail`)
- [X] T014 [P] Create `CreateSalesNotificationDto` in `src/modules/notification/dto/create-sales-notification.dto.ts` (`title @IsString @Length(1,200)`, `body @IsString`, `productIds? @IsOptional @IsUUID each`)
- [X] T015 [P] Create `UpdatePreferencesDto` in `src/modules/users/dto/update-preferences.dto.ts` (`marketingOptIn @IsBoolean`)
- [X] T016 Extend `RegisterDto` with optional `marketingOptIn` in `src/modules/auth/dto/user-register.dto.ts` (`@IsOptional @IsBoolean`)
- [X] T017 Extend `RateLimitGuard` `DEFAULT_LIMITS` in `src/modules/auth/guards/rate-limit.guard.ts` (add keys `'GET /auth/verify-email' 10/IP 3600`, `'POST /auth/verify-email' 10/IP`, `'POST /auth/resend-verification' dual 5/IP + 3/email + cooldown SET NX EX 60`, `'POST /admin/notifications/sales' 10/user) with distributed `CACHE_MANAGER rl:* INCR+EXPIRE` fail-open outermost + `ConfigService` clamp >=60000
- [X] T018 Wire provider factory in `src/modules/auth/auth.module.ts` and `src/modules/notification/notification.module.ts` (`{provide:'EMAIL_PROVIDER', useFactory: (config)=> config.get('EMAIL_PROVIDER')==='smtp'?Smtp:Noop }`, exports `RateLimitGuard` + `AuthService`/`NotificationService`)

**Checkpoint**: Foundation ready — `synchronize:false`, migration applies, `npm run build` passes, no user story work until verified

---

## Phase 3: User Story 1 — Verify email after register via link (Priority: P1) 🎯 MVP

**Goal**: `POST /auth/register 201` after commit creates `EmailVerificationToken 24h` + emits `email.verification_requested` → `GET|POST /auth/verify-email?token&email` `FOR UPDATE` single-use sets `usedAt` + `User.emailVerified=true` `200 {verified:true}`; concurrent same token → one `200` one `400`; second use `400`; inventory/order untouched.

**Independent Test**: `POST /auth/register → capture raw via NoopEmailProvider.lastVars or AuthService.lastVerificationToken → GET /auth/verify-email?token=&email= 200 {verified:true} → SELECT emailVerified true + usedAt NOT NULL → second GET 400 → concurrent Promise.all([verify,verify]) 200+400 → psql SELECT inventory 0 mutation`. Can be tested without US2-US5.

### Tests for User Story 1 ⚠️

> **NOTE: Write these tests FIRST, ensure they FAIL before implementation**

- [X] T019 [P] [US1] Unit test `AuthService.requestEmailVerification` fire-and-forget in `src/modules/auth/test/auth.service.spec.ts` (mock `DataSource` `User by email` not found→void anti-enum, `emailVerified true`→void, `emailVerified false`→UPDATE usedAt NULL + INSERT 24h hash + emit after commit `1` `EmailProvider.send` not called directly)
- [X] T020 [P] [US1] Unit test `AuthService.verifyEmail` `FOR UPDATE` in `src/modules/auth/test/auth.service.spec.ts` (valid→200 usedAt NOW emailVerified true, usedAt NOT NULL→400, expiresAt<=NOW→400, unknown email→400, Logger hashPrefix only)
- [X] T021 [P] [US1] Integration test `FOR UPDATE` single-winner in `src/modules/auth/test/verify.integration.spec.ts` (real PG `--runInBand`: seed user + token `expiresAt=now+24h`, `Promise.all([verify,verify])` same raw → `1→200` `1→400` `usedAt` single row; `EXPLAIN` tokenHash index used)
- [X] T022 [P] [US1] E2E contract test `GET|POST /auth/verify-email` in `test/verify.e2e-spec.ts` (`supertest` `POST /auth/register 201 → capture Noop link → GET 200 → second GET 400 → GET with wrong email 400 → concurrent 200+400`)

### Implementation for User Story 1

- [X] T023 [US1] Implement `AuthService.requestEmailVerification(email)` and `AuthService.verifyEmail(dto)` in `src/modules/auth/auth.service.ts` (class-level `/** This service is responsible for email verification... */` + method JSDoc `@param @returns @throws`; `requestEmailVerification` after-commit fire-and-forget `Logger.error` never throw, `verifyEmail` `SELECT ... FOR UPDATE where tokenHash=hash AND userId` + `if !found || usedAt || expiresAt<=NOW() // single-use or expired` inline comment + `token.usedAt=NOW()` + `User.emailVerified=true` inside `dataSource.transaction`, emit `auth.email_verified` after commit outside manager; never log raw `hashPrefix` only)
- [X] T024 [US1] Modify `AuthService.register(dto)` in `src/modules/auth/auth.service.ts` to call `requestEmailVerification` fire-and-forget after `UsersService.createNewUser` commit (outside transaction, `Logger.error` only)
- [X] T025 [US1] Implement `AuthController` endpoints `GET /auth/verify-email` + `POST /auth/verify-email` in `src/modules/auth/auth.controller.ts` (thin: parse `@Query`/`@Body VerifyEmailDto`, call service, return `200 {verified:true}`, `@UseGuards(RateLimitGuard)` outermost, `@ApiOperation Verify via link/body @ApiResponse 200 @ApiResponse 400 @ApiResponse 429`)
- [X] T026 [US1] Create/extend `EmailWorker` or `NotificationWorker` handling `email.verify` in `src/modules/auth/workers/email.worker.ts` or `src/modules/notification/notification.worker.ts` (`@Processor('notification')` handles `email.verify` `BullMQ attempts 3 backoff exponential 1s` → `EmailProvider.send(to:email, subject:"Verify your email", template:'verify', vars:{link:${FRONTEND_URL}/verify-email?token=<raw>&email=, firstName})` + `INSERT NotificationLog template:verify` after send, outside FOR UPDATE)

**Checkpoint**: At this point, `register→verify` works independently; `POST /auth/resend-verification` not yet required, bulk not yet.

---

## Phase 4: User Story 2 — Resend verification anti-enumeration with cooldown (Priority: P1)

**Goal**: `POST /auth/resend-verification {email} 200` anti-enum (same message for `!found`, distinct `200 Email already verified` when verified), invalidates priors `SET usedAt=NOW()` + new `24h` + emit, dual rate-limit `5/IP+3/email` + `60s cooldown SET NX EX 60` `429`, second use old raw `400`.

**Independent Test**: `POST /auth/resend-verification {notfound} 200 + 0 token; {verified true} 200 Email already verified 0 email; {unverified} 200 → 60s within 429; 4th/h 429 3600; resend vs verify race FOR UPDATE 400|200`. Testable without US3 bulk.

### Tests for User Story 2 ⚠️

- [X] T027 [P] [US2] Unit test `AuthService.resendVerification` anti-enum/cooldown in `src/modules/auth/test/auth.service.spec.ts` (mock `CACHE_MANAGER SET NX` cooldown 60s exists→429 0 transaction, not found→200 anti-enum 0 insert, verified true→200 distinct 0 insert, unverified→UPDATE usedAt + INSERT 24h + emit + resend invalidates t1)
- [X] T028 [P] [US2] Integration test `resend FOR UPDATE race` in `src/modules/auth/test/resend.integration.spec.ts` (real PG `--runInBand`: `POST /auth/resend-verification` then `GET /auth/verify-email` old raw `400` new raw `200`; concurrent `Promise.all([resend,resend])` same email `60s` cooldown `429` before transaction)
- [X] T029 [P] [US2] Contract test `POST /auth/resend-verification` in `test/resend.e2e-spec.ts` (`supertest` anti-enum `200` for `notfound`, verified `200 Email already verified`, `60s` second `429`, `5/IP` + `3/email` exceed `429 3600` headers, `CACHE_MANAGER throw` fail-open `200`)

### Implementation for User Story 2

- [X] T030 [US2] Implement `AuthService.resendVerification(email)` in `src/modules/auth/auth.service.ts` (method JSDoc `@throws TooManyRequests`; Redis `SET resend:cooldown:<email> NX EX 60` before transaction `// 60s cooldown prevents burst` → `429` if `0`; else `SELECT User by email` `!found`→`200` anti-enum `Logger.debug`; `emailVerified true`→`200 {message:"Email already verified"}`; else `dataSource.transaction` `UPDATE usedAt=NOW()` + `INSERT 24h sha256` + after commit emit `email.verification_requested` outside manager)
- [X] T031 [US2] Implement `AuthController POST /auth/resend-verification` in `src/modules/auth/auth.controller.ts` (`@Body ResendVerificationDto` public `@UseGuards(RateLimitGuard)` outermost, Swagger `@ApiResponse 200 @ApiResponse 429`)

**Checkpoint**: At this point, `US1+US2` both work — resend recovery without leaking existence.

---

## Phase 5: User Story 3 — Password-reset email actually sends (Priority: P2)

**Goal**: Upgrade existing `POST /auth/forgot-password 200` anti-enum `15m` `PasswordResetToken` to emit `auth.password_reset_requested` after commit consumed by `EmailWorker` `EmailProvider.send template:reset` with `FRONTEND_URL` link; `validate-reset-token`/`reset-password` unchanged `FOR UPDATE` single-use.

**Independent Test**: `POST /auth/forgot-password {existing} 200 → PasswordResetToken 15m hash + NoopEmailProvider.send 1 template reset to===email link contains raw64+email; {unknown} 200 0 send; validate 200 vs expired 400`. Testable without bulk.

### Tests for User Story 3 ⚠️

- [X] T032 [P] [US3] Unit test `AuthService.forgotPassword wired emit` in `src/modules/auth/test/auth.service.spec.ts` (mock `DataSource` existing user→INSERT 15m + `queue.add/client.emit` called once after commit with `auth.password_reset_requested`; unknown→0 insert 0 emit; unknown `EmailProvider.send` not called)
- [X] T033 [P] [US3] E2E `POST /auth/forgot-password` wired in `test/forgot.e2e-spec.ts` (`supertest` `POST /auth/forgot-password {existing} 200 → Noop capture link raw 64 + email → POST /auth/validate-reset-token 200 → POST /auth/reset-password 200 tokenVersion++ → second validate 400 usedAt set)

### Implementation for User Story 3

- [X] T034 [US3] Wire `AuthService.requestPasswordReset` to emit after commit in `src/modules/auth/auth.service.ts` (replace `TODO Logger.log publish auth.password_reset_requested` with `queue.add('email.reset', {userId,email,raw,expiresAt})` or `client.emit('auth.password_reset_requested', ...)` outside `EntityManager` transaction; `Logger.log password reset enqueued hashPrefix`)
- [X] T035 [US3] Extend `EmailWorker/NotificationWorker` to handle `email.reset` in `src/modules/notification/notification.worker.ts` (case `email.reset` / `auth.password_reset_requested`: `EmailProvider.send(to:email, subject:"Reset your password", template:'reset', vars:{link, expiresIn:'15m'})` + `INSERT NotificationLog template:reset` + `BullMQ attempts 3`)

**Checkpoint**: At this point, `register→verify→forgot→reset` full auth email chain works without GUI.

---

## Phase 6: User Story 4 — Sales and new-product bulk notifications with opt-in gate and idempotency (Priority: P2)

**Goal**: `POST /admin/notifications/sales {title,body,productIds?} 202 {jobId}` Admin-only `10/h per user` → `BullMQ notification.sendBulk` ephemeral `campaignId` (no `sales_campaign` table) paginates `Users WHERE marketingOptIn=true AND emailVerified=true` `500` cursor `concurrency 5`, `Redis SET NX notification:send:<template>:<campaignId|productId>:<userId> EX 86400` Redis-only before `EmailProvider.send template:sales/new_product` + `NotificationLog` audit, replay `same campaignId` → `0` new. `product.created` fan-out same dedup.

**Independent Test**: Seed `10 users` `5 optIn+verified`, `3 optIn+verified false`, `2 optIn false`; `POST /admin/notifications/sales as Admin 202 → worker drain → NotificationLog 5 + EmailProvider.send 5 + skipped 5` `GET notification:send:sales:<campaignId>:* 5`; replay same `campaignId` `0` new; `product.created` fan-out `5`. Gate excludes unverified/opt-out. `Customer` `403`. Testable without `US5 preferences` (seed directly via DB).

### Tests for User Story 4 ⚠️

- [X] T036 [P] [US4] Unit test `NotificationService.sendSalesCampaign` in `src/modules/notification/test/notification.service.spec.ts` (mock `Queue add` called with `campaignId uuid`, `title 1-200` validation `400` if title empty, `productIds` unknown→`404`, `Admin` guard mocked, returns `202 jobId`; `onProductCreated` enqueues `new_product`)
- [X] T037 [P] [US4] Unit test `NotificationWorker bulk gate` in `src/modules/notification/test/notification.worker.spec.ts` (mock `CACHE_MANAGER SET NX 1` for eligible, `Users` mixed array → `send 5` `NotificationLog 5` `skip 5`; `SET NX 0` replay→`0 send`; `Redis throw` fail-open→`Logger.warn` + tolerate duplicate)
- [X] T038 [P] [US4] Integration test `sales bulk 500 cursor` in `src/modules/notification/test/notification.integration.spec.ts` (real PG `--runInBand`, real Redis `FLUSHDB`: seed 25 users `marketingOptIn+verified` 10, others mixed, `queue.add sendBulk` → worker paginates `500` cursor `concurrency 5` → `NotificationLog 10` + `NotificationLog still 10` on replay same `campaignId`)
- [X] T039 [P] [US4] E2E `POST /admin/notifications/sales` in `test/sales.e2e-spec.ts` (`supertest` `POST /auth/register×10` + `PATCH preferences` opt-in + `GET /auth/verify-email` verified for 5 → `POST /admin/notifications/sales as Admin 202 jobId → wait drain → SELECT count(*) notification_log template:sales 5 → product.created 5`)

### Implementation for User Story 4

- [X] T040 [US4] Create `NotificationService` in `src/modules/notification/notification.service.ts` (class-level `/** This service is responsible for sales/new_product fan-out... */` + methods `sendSalesCampaign(dto, actor:User): Promise<{jobId}>` `@throws ForbiddenException 403` `@throws BadRequestException 400` + `onProductCreated(product)` fire-and-forget; `sendSalesCampaign` validates `title 1-200`, checks `actor.role===Admin` else `403`, `BullMQ queue.add('notification.sendBulk', {campaignId: randomUUID(), template:'sales', ...}, {jobId:campaignId, attempts:3, backoff:{type:'exponential', delay:1000}})` outside `DataSource.transaction`)
- [X] T041 [US4] Create `NotificationWorker` in `src/modules/notification/notification.worker.ts` (`@Processor('notification')` `concurrency 5` class `/** This worker handles bulk email... */` + methods `handleSendBulk` + `handleNewProduct`; `handleSendBulk` paginates `manager.getRepository(User).find({where:{marketingOptIn:true, emailVerified:true}, order:{id:'ASC'}, take:EMAIL_SALES_BATCH_SIZE 500, skip})` cursor, for each `user` `// Redis-only dedup before send` `await cache.get`? actually `SET NX` via `cacheManager.set` with `NX` or `redis.set NX EX`? use `cacheWrapper` + `INCR`? but per spec use `Redis SET NX` → `if 0 skip` else `EmailProvider.send` + `manager.getRepository(NotificationLog).save({...})` + `Logger.log` hashPrefix; per-user failure does not abort loop `try/catch Logger.error`)
- [X] T042 [US4] Create `NotificationController` in `src/modules/notification/notification.controller.ts` (`POST /admin/notifications/sales` thin `@Auth(UserRoles.Admin)` `@UseGuards(RateLimitGuard)` `@Body CreateSalesNotificationDto` → `notificationService.sendSalesCampaign` + `GET /admin/notifications/logs` optional audit; Swagger `@ApiBearerAuth @ApiResponse 202 @ApiResponse 403 @ApiResponse 429`)
- [X] T043 [US4] Create `NotificationModule` in `src/modules/notification/notification.module.ts` (`TypeOrmModule.forFeature([NotificationLog, User])`, `BullModule.registerQueue({name:'notification'})`, `CacheModule`, `ConfigModule`; providers `[NotificationService, NotificationWorker, {provide:'EMAIL_PROVIDER',...}]`; controllers `[NotificationController]`; exports `[NotificationService]`)
- [X] T044 [US4] Modify `ProductsService.create` in `src/modules/products/products.service.ts` to call `notificationService.onProductCreated(product)` after `DataSource.transaction` commit outside manager (inject `NotificationService`, fire-and-forget outside transaction)
- [X] T045 [US4] Register `BullModule` globally in `src/app.module.ts` (ensure `BullModule.forRoot({connection:{host:REDIS_HOST,port:REDIS_PORT}})` or reuse existing `BullModule` shared config)

**Checkpoint**: At this point, admin bulk fan-out works with `marketingOptIn && emailVerified` gate + `24h` Redis-only dedup + indefinite `NotificationLog` audit.

---

## Phase 7: User Story 5 — Preference opt-in and read own verification state (Priority: P3, supporting)

**Goal**: `GET /users/me` exposes `marketingOptIn+emailVerified`; `PATCH /users/me/preferences {marketingOptIn} 200 JwtGuard` `FOR UPDATE User` sets flag, `POST /auth/register {marketingOptIn?}` stores directly, bulk includes updated user next run, past campaigns not retroactive.

**Independent Test**: `POST /auth/register {marketingOptIn:false} 201 → GET /users/me 200 emailVerified false marketingOptIn false → PATCH /users/me/preferences {marketingOptIn:true} 200 → SELECT marketingOptIn true → next sales bulk includes user`. `401` unauth.

### Tests for User Story 5 ⚠️

- [X] T046 [P] [US5] Unit test `UsersService.updatePreferences` in `src/modules/users/test/users.service.spec.ts` (mock `DataSource FOR UPDATE` `findOne` → `update marketingOptIn true`, `false→true` `Logger.log`, `validate` `marketingOptIn @IsBoolean`)
- [X] T047 [P] [US5] Integration test `GET|PATCH /users/me` in `src/modules/users/test/users.integration.spec.ts` (real PG `--runInBand`: register → `GET /users/me` `marketingOptIn false` → `PATCH 200 true` → `GET true` → unauth `401`)
- [X] T048 [P] [US5] E2E `preferences gate` in `test/preferences.e2e-spec.ts` (`supertest` register `marketingOptIn false` → sales bulk `0` for that user → `PATCH true` → sales bulk with new `campaignId` includes user)

### Implementation for User Story 5

- [X] T049 [US5] Implement `UsersService.updatePreferences` in `src/modules/users/users.service.ts` (`/** Updates marketingOptIn... @param @returns @throws */` + `dataSource.transaction` `SELECT User WHERE id=:userId FOR UPDATE` + `user.marketingOptIn=dto.marketingOptIn` save, `Logger.log`)
- [X] T050 [US5] Implement `UsersController` endpoints `GET /users/me` extended + `PATCH /users/me/preferences` in `src/modules/users/users.controller.ts` (`GET /users/me @Auth() JwtGuard` returns `marketingOptIn+emailVerified`; `PATCH /users/me/preferences @Auth() @UseGuards(JwtGuard)` `@Body UpdatePreferencesDto` → `usersService.updatePreferences(currentUser.sub, dto)`, Swagger `@ApiBearerAuth`)
- [X] T051 [US5] Verify `POST /auth/register` stores `marketingOptIn` via `RegisterDto` extended (already in T016) — ensure `UsersService.createNewUser` persists `marketingOptIn` default `false` if omitted

**Checkpoint**: All 5 user stories now independently functional.

---

## Phase 8: Polish & Cross-Cutting Concerns

**Purpose**: Docs, hardening, nightly purge, verification gates

- [X] T052 [P] Create nightly purge job for `EmailVerificationToken 7d` in `src/modules/auth/auth.module.ts` or `src/modules/notification/notification.worker.ts` (`@Interval 86400000` or `BullMQ repeat '0 0 * * *'` → `DELETE FROM EmailVerificationToken WHERE (usedAt IS NOT NULL AND usedAt < NOW() - INTERVAL '7 days') OR (expiresAt < NOW() - INTERVAL '7 days')`)
- [X] T053 [P] Update Swagger in `src/modules/auth/auth.controller.ts` and `src/modules/notification/notification.controller.ts` + `src/modules/users/users.controller.ts` (`@ApiOperation`, `@ApiResponse 200/400/401/403/429`, `@ApiHeader Retry-After`)
- [X] T054 [P] Add architecture doc `docs/architecture/email-service.md` and ADR `docs/decisions/ADR-email-service.md` (sha256, 24h vs 15m, Noop vs Smtp, async after commit RabbitMQ/BullMQ, Redis-only dedup, ephemeral campaign, Allow unverified login, 7d purge)
- [ ] T055 [P] Validate `quickstart.md` flows manual: run `docker-compose up -d`, `npm run build`, `npm run migration:run`, sequential `register→verify 200→reuse 400→concurrent 200+400→resend anti-enum 200→resend 429 60s→forgot→reset→PATCH preferences→admin sales 10 users→new_product fan-out`, `psql SELECT` proofs, `redis-cli FLUSHDB` `429` `SET NX` (DEFERRED 2026-10-01: docker daemon down, needs infra up)
- [X] T056 [P] Code documentation sweep: ensure every new `Service`/`Controller`/`Entity`/`Guard` has class-level `/** This service is responsible for ... */` and every public method `/** ... @param @returns @throws */` + inline `//` for complex conditions (`if !found || usedAt || expiresAt<=NOW()`, `if marketingOptIn && emailVerified`) per `AGENTS.md` §3
- [ ] T057 Run verification gates `npm run lint && npm run build && npm run test -- --runInBand && npm run test:e2e` and ensure `grep -c "client.emit" src/modules/auth/auth.service.ts` `0` inside any `dataSource.transaction` + `grep -c "FOR UPDATE" src/modules/auth/auth.service.ts` `>=1` + `synchronize:false` + no `rawToken` in logs `0` hashPrefix only (PARTIAL 2026-10-01: `build` pass, new unit specs pass, `lint` 18 errors all pre-existing baseline, full integration/e2e need docker PG)

---

## Phase 9: Delivery-State + Dual-Channel (2026-10-01: US6 + US7)

**Purpose**: Answer "MQ-accepted vs consumed vs delivered" with `SENT_TO_MQ → CONSUMED → DELIVERED` + per-channel `NotificationDelivery`, dual-channel `Strategy + Factory` dispatch on existing `NotificationsModule`, WS gateway, history/unread endpoints. Reuses `NotificationsModule` — no new top-level module.

**Prerequisites**: Phase 2 Foundational (entities/migration/provider/dto/guard) complete. Extends T005-T008 entities and T016/T050-T051 prefs.

### Tests for US6/US7 ⚠️

> **NOTE: Write these tests FIRST, ensure they FAIL before implementation**

- [X] T058 [P] [US6] Unit test `OutboxStatus` transitions in `src/modules/outbox/test/outbox-status.spec.ts` (mock `DataSource`: publisher `PENDING→PROCESSING→SENT_TO_MQ` token-checked; consumer `SENT_TO_MQ→CONSUMED` `FOR UPDATE`; duplicate `eventId` → `0` new deliveries + `INCR idempotency:duplicate:skipped:notification`)
- [X] T059 [P] [US6] Integration test delivery-state machine in `src/modules/notifications/test/delivery.integration.spec.ts` (real PG `--runInBand`: checkout `201 PENDING` → `publishBatch() SENT_TO_MQ 0 Notification rows` → worker first handle `CONSUMED + deliveries` → replay same `eventId` `0` new rows + status stays `CONSUMED`)
- [X] T060 [P] [US7] Unit test `NotificationDispatcher` + `NotificationChannelFactory` in `src/modules/notifications/test/dispatcher.spec.ts` (mock `UsersService`: `verify/reset → ['system','email']` regardless of flags; `sales` opt-in `→ both`, opt-out `→ ['system']` only, `emailOptIn=false → ['system']`; factory `create('system'|'email')` returns strategy, `create('sms')` throws `400`)
- [X] T061 [P] [US7] Unit test history/unread in `src/modules/notifications/test/notifications.controller.spec.ts` (mock repo: `GET /notifications` paginated `meta`; `unread-count {n}`; `PATCH :id/read` owner `200` vs other-user `403`; `read-all {updated:n}`; unauth `401`)
- [X] T062 [P] [US7] E2E dual-channel + WS in `test/notifications.e2e-spec.ts` (`supertest` register `{marketingOptIn,emailOptIn}` → verify yields `2` rows → `PATCH preferences` opt-out → sales bulk `1` row system-only → `unread-count/read/read-all` flow; `wscat` `notifications` namespace receives `notification:new` within `2s` when online)

### Implementation for US6/US7

- [X] T063 [US6] Extend `OutboxStatus` enum in `src/modules/outbox/entities/outbox-status.enum.ts` (`SENT_TO_MQ`, `CONSUMED`, `DELIVERED` + `SENT` backward-compat alias) and `OutboxEvent` with `consumedAt` nullable (class JSDoc update: `SENT_TO_MQ` = broker accepted, `CONSUMED` = worker ACKed, `DELIVERED` = channels accepted)
- [X] T064 [US6] Create `Notification` entity in `src/modules/notifications/entities/notification.entity.ts` (§3b DDL: `userId/eventId/channel/type/title/body/data/status/isRead/readAt/sentAt/deliveredAt`, indexes `(userId,createdAt)`, `(userId,isRead)`, `@Unique(eventId,channel)`) + `NotificationDelivery` in `src/modules/notifications/entities/notification-delivery.entity.ts` (§3c: `eventId/channel/status/attempts/messageId/nextRetryAt/deliveredAt`, `@Unique(eventId,channel)`)
- [X] T065 [US6] Create migration `17xxxxxxxxxx-NotificationDeliveryAndHistory` in `src/migration/17xxxxxxxxxx-NotificationDeliveryAndHistory.ts` (enum widen + `User.emailOptIn DEFAULT true` + `outbox_event.consumedAt` + `CREATE TABLE notification/notification_delivery` + indexes/uniques; never edit committed migrations; `synchronize:false`)
- [X] T066 [US6] Update consumer to write `CONSUMED` + upsert deliveries in `src/modules/notifications/notifications.worker.ts` (`FOR UPDATE OutboxEvent` → `CONSUMED` + `consumedAt`, upsert `NotificationDelivery PENDING` per dispatched channels via `orIgnore`, dispatch channels, manual `ACK` only after commit; duplicate → `INCR` + skip + `ACK`)
- [X] T067 [US7] Create channel Strategy + Factory in `src/modules/notifications/channels/` (`notification-channel.interface.ts` interface, `system.channel.ts` persist + WS emit offline-stays-`SENT`, `email.channel.ts` wraps `EMAIL_PROVIDER`, `notification-channel.factory.ts` `create()` extensible; class-level `/** This service is responsible for ... */` + method `/** @param @returns @throws */` per AGENTS.md §3)
- [X] T068 [US7] Create `NotificationDispatcher` in `src/modules/notifications/notification.dispatcher.ts` (runtime resolution: `verify|reset → both`; `sales|new_product → system + email iff marketingOptIn && emailOptIn && emailVerified`; `order.*|expired → system + email iff emailOptIn`; `// trust-critical override` + `// opted-out → system-only` inline comments)
- [X] T069 [US7] Create WS gateway in `src/modules/notifications/notifications.gateway.ts` (`@WebSocketGateway({namespace:'notifications'})` JWT `handleConnection` → `user:<sub>` room, emit `notification:new`, echo `notification:read` post-commit; `WS_AUTH`, `Logger` only)
- [X] T070 [US7] Create history controller in `src/modules/notifications/notifications.controller.ts` (thin: `GET /notifications` owner paginated + filters, `GET /notifications/unread-count`, `PATCH /notifications/:id/read` `FOR UPDATE` + `assertOwner` `403` idempotent, `PATCH /notifications/read-all`; `@Auth()` + Swagger `@ApiBearerAuth`)
- [X] T071 [US7] Extend prefs with `emailOptIn` in `src/modules/users/entity/user.entity.ts` (`boolean DEFAULT true`), `src/modules/auth/dto/user-register.dto.ts` (`marketingOptIn?` + `emailOptIn?` optional), `src/modules/users/dto/update-preferences.dto.ts` (both optional either-or), `GET /users/me` returns both
- [X] T072 [US7] Wire `SystemChannel`/`EmailChannel` sends to `Notification` rows + `NotificationDelivery DELIVERED` updates (channel `send` returns `{messageId, delivered}` → `deliveredAt=NOW()`; throw → `SENT` + `attempts++` + `nextRetryAt` backoff, `FAILED` after 3 retained per-channel)
- [X] T073 Docs + verify: update `quickstart.md` §5.6 (history/unread curl + `wscat` WS), Swagger for 4 history routes + WS namespace, `GET /users/me` shape with both flags; run `npm run lint && npm run build && npm run test -- --runInBand` + grep `git status` shows only `specs/*/docs/*` (no `src/` code changes in this spec-update commit)

**Checkpoint**: Delivery-state machine provable per SC-009/SC-010 (`SENT_TO_MQ` vs `CONSUMED` vs `DELIVERED` + unread flow); factory extensible to `sms|push` without caller change.

---

## Dependencies & Execution Order

### Phase Dependencies

- **Setup (Phase 1)**: No dependencies — can start immediately
- **Foundational (Phase 2)**: Depends on Setup — BLOCKS all user stories
- **Phase 9 (US6/US7 delivery-state + dual-channel)**: Depends on Foundational (T005-T008, T016-T018); extends worker/gateway/controller — implement after US1-US5 or in parallel (different files: `notifications.worker.ts` modify vs `notification.*` new)
- **User Stories (Phase 3+)**: All depend on Foundational completion
  - US1 (P1) Verify: no story dependencies
  - US2 (P1) Resend: depends on US1 entities (`EmailVerificationToken`) but independently testable (shares `EmailVerificationToken` table, so technically after T005-T008)
  - US3 (P2) Forgot wired: depends on Foundational `PasswordResetToken` existing + `EmailProvider`, independently testable
  - US4 (P2) Sales bulk: depends on Foundational `User.marketingOptIn` + `NotificationLog` + `BullMQ`, independently testable via seed
  - US5 (P3) Preferences: depends on Foundational `User.marketingOptIn`, independently testable via `GET|PATCH`
  - Stories can proceed sequentially in priority P1→P2→P3 per spec, or US1+US3+US5 in parallel after Foundational (if staffed)
- **Polish (Phase 8)**: Depends on all desired stories being complete

### User Story Dependencies

- **User Story 1 (P1)**: Can start after Foundational (T005-T018) — no other story dependency
- **User Story 2 (P1)**: Can start after Foundational + US1 implementation shares same table but logically independent; may run in parallel with US1 after T005
- **User Story 3 (P2)**: Can start after Foundational — independent of US1/US2 (different token `PasswordResetToken`)
- **User Story 4 (P2)**: Can start after Foundational — independent of auth verify (different module `notification`)
- **User Story 5 (P3)**: Can start after Foundational — independent, but bulk gate `marketingOptIn` can be tested via DB seed without US5; still kept P3 for UX

### Within Each User Story

- Tests (if included) MUST be written and FAIL before implementation
- DTOs/entities before services
- Services before workers/controllers
- Core implementation before edge-case handling
- Story complete before next priority unless parallel team

### Parallel Opportunities

- Foundational `T005-T011` entities + `T012-T016` DTOs all `[P]` parallel (different files)
- Once Foundational completes, US1 `T019-T022` tests parallel, US3 `T032` parallel with US1
- US4 unit tests `T036-T037` parallel
- US5 `T046-T048` tests parallel
- Polish `T052-T056` docs + purge parallel

---

## Parallel Example: User Story 1

```bash
# Launch all tests for US1 together (fail before impl):
Task: "Unit test AuthService.requestEmailVerification in src/modules/auth/test/auth.service.spec.ts" # T019
Task: "Unit test AuthService.verifyEmail FOR UPDATE in src/modules/auth/test/auth.service.spec.ts" # T020
Task: "Integration test FOR UPDATE single-winner in src/modules/auth/test/verify.integration.spec.ts" # T021
Task: "E2E GET|POST /auth/verify-email in test/verify.e2e-spec.ts" # T022

# Launch all models for Foundational together:
Task: "Create EmailVerificationToken entity in src/modules/auth/entities/email-verification-token.entity.ts" # T005
Task: "Modify User entity marketingOptIn in src/modules/users/entity/user.entity.ts" # T006
Task: "Create NotificationLog entity in src/modules/notification/entities/notification-log.entity.ts" # T007
Task: "Define EmailProvider interface in src/modules/auth/providers/email.provider.ts" # T009
```

---

## Implementation Strategy

### MVP First (User Story 1 Only)

1. Complete Phase 1: Setup (`npm install nodemailer`, `.env.example`, `docker-compose`)
2. Complete Phase 2: Foundational (3 entities + migration + provider + 4 DTOs + guard)
3. Complete Phase 3: US1 Verify (`register fire-and-forget` + `verify FOR UPDATE` `200 vs 400` + `EmailWorker` `Noop`)
4. **STOP and VALIDATE**: `POST /auth/register → capture raw → GET /auth/verify-email 200 → reuse 400 → concurrent 200+400 → SELECT inventory 0`
5. Deploy/demo if ready (auth email onboarding works)

### Incremental Delivery

1. Setup + Foundational → Foundation ready (`npm run build` passes, migration applies)
2. Add US1 Verify → Test independently → Deploy/Demo (MVP!)
3. Add US2 Resend → Test independently (`200 anti-enum`, `60s 429`) → Demo
4. Add US3 Forgot wired → Test (`PasswordResetToken` now sends) → Demo
5. Add US4 Sales bulk → Test (`10 users 5 gate + replay 0`) → Demo (marketing)
6. Add US5 Preferences → Test (`PATCH 200`) → Demo (gate UX)
7. Polish → `docs/architecture/email-service.md` + `ADR` + `quickstart.md` validation + `lint/build/test:e2e` PASS

### Parallel Team Strategy

With multiple developers after Foundational done:

- Developer A: US1 Verify + US2 Resend (auth verification domain)
- Developer B: US3 Forgot wired (auth reset reuse)
- Developer C: US4 Sales bulk + US5 Preferences (notification + users)
Stories complete and integrate independently (different files: `auth.service` vs `notification.service` vs `users.service`).

---

## Notes

- [P] tasks = different files, no dependencies
- [Story] label maps task to specific user story for traceability
- Each user story independently completable and testable per `Independent Test` in spec.md
- Verify tests fail before implementing (`FOR UPDATE` `200+400` single-winner is hard to pass without transaction)
- Commit after each task or logical group (`git commit -m "feat(email): T019-T022 US1 verify tests"` etc.)
- Stop at any checkpoint to validate story independently
- Avoid: vague tasks, same file conflicts, cross-story dependencies that break independence
- `synchronize:false` always; real PG for integration; `CACHE_MANAGER` fail-open `Logger.warn`; `hashPrefix` only logs

