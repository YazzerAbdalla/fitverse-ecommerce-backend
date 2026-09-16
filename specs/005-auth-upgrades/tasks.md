# Tasks: Auth Upgrades — Forgot Password, Recovery Token, WhatsApp OTP, Google OAuth

**Input**: Design documents from `specs/005-auth-upgrades/` (spec.md 4 stories, plan.md, research.md D1-D11, data-model.md, contracts/auth-contracts.md, quickstart.md)
**Prerequisites**: plan.md (required), spec.md (required), research.md, data-model.md, contracts/, quickstart.md
**Tests**: Included (spec SC-008 requires 30+ unit, 10+ integration, 3 E2E) — tests FIRST then impl

## Format: `[ID] [P?] [Story] Description`

- **[P]**: Can run in parallel (different files, no dependencies)
- **[Story]**: Which user story this task belongs to (US1, US2, US3, US4)

## Phase 1: Setup (Shared Infrastructure)

**Purpose**: Tooling, dependencies, env, module scaffolding that all stories share

- [X] T001 Install auth upgrade dependencies in `package.json` (add `passport-jwt`, `passport-google-oauth20` and `@types/passport-jwt`, `@types/passport-google-oauth20`)
- [X] T002 [P] Add new env keys to `.env.example` and `.env` (via `ConfigService`) for `RESET_TOKEN_TTL`, `OTP_TTL`, `OTP_MAX_ATTEMPTS`, `OTP_RESEND_COOLDOWN`, `WHATSAPP_PROVIDER`, `WHATSAPP_FROM_NUMBER`, `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `GOOGLE_CALLBACK_URL`, `FRONTEND_URL`
- [X] T003 [P] Configure `CacheModule` global usage check and ensure `@nestjs/cache-manager` + `@keyv/redis` already wired in `src/app.module.ts`
- [X] T004 [P] Create `src/modules/auth/entities/` directory and `src/modules/auth/dto/` placeholder exports

---

## Phase 2: Foundational (Blocking Prerequisites)

**Purpose**: DB schema + core auth invariants that MUST complete before ANY story

**⚠️ CRITICAL**: No user story work can begin until this phase is complete

- [X] T005 Create `User` entity alterations in `src/modules/users/entity/user.entity.ts` (add `phoneNumber` nullable partial unique, `phoneVerified` bool default false, `googleId` nullable partial unique, `provider` enum local|google default local, `password nullable`, `tokenVersion int default 0` for revocation per F2 choice C (plus `passwordChangedAt` nullable kept for compat), `UNIQUE(email)` plus checks, `CHECK provider IN ('local','google')`, add `JwtPayload` `tokenVersion` field in `src/modules/auth/types.ts`)
- [X] T006 Create migration `src/migration/17xxxxx-AuthUpgradesUserAndResetToken.ts` for User alterations (including `tokenVersion`, `phoneNumber`, `googleId`, `provider`, `password nullable`, `UNIQUE(email)`) and `PasswordResetToken` table per F3 (never edit committed, `synchronize:false`)
- [X] T007 Create `PasswordResetToken` entity in `src/modules/auth/entities/password-reset-token.entity.ts` (id uuid PK, userId FK CASCADE indexed, tokenHash varchar(255) indexed, expiresAt timestamptz CHECK > createdAt, usedAt nullable, createdAt)
- [X] T008 Create `OtpVerification` entity in `src/modules/auth/entities/otp-verification.entity.ts` (id uuid PK, phoneNumber indexed, userId nullable FK SET NULL, purpose enum login|verify_phone, codeHash, expiresAt indexed CHECK, attempts int <=3, verifiedAt, createdAt) per [data-model.md](./data-model.md)
- [X] T009 Create second migration `src/migration/17xxxxx-AddOtpAndGoogleFields.ts` for `OtpVerification` table + indexes/FKs only (per F3 `User` provider/tokenVersion not duplicated — owned by T006)
- [X] T010 Run and verify migrations via `npm run build` + `npm run migration:run` against docker PostgreSQL and ensure `User`/`PasswordResetToken`/`OtpVerification` tables + `CHECK`/`UNIQUE` constraints exist in `psql \d`
- [X] T011 [P] Update `src/modules/users/users.service.ts` to expose helpers `findById`, `findByGoogleId`, `updatePassword(userId, hash, tokenVersion)` (increment tokenVersion per F2 C) and `findByIdWithVersion` for JwtStrategy
- [X] T012 [P] Add `JwtStrategy` in `src/modules/auth/strategies/jwt.strategy.ts` (extends `PassportStrategy(Strategy,'jwt')`, validates `tokenVersion` equality per F2 choice C — `payload.tokenVersion === user.tokenVersion` else 401, no cache no DB fallback window) and `JwtAuthGuard` in `src/modules/auth/guards/jwt-auth.guard.ts`; update `src/modules/auth/types.ts` JwtPayload to include `tokenVersion: number`
- [X] T013 Configure `AuthModule` imports in `src/modules/auth/auth.module.ts` (add `TypeOrmModule.forFeature([PasswordResetToken, OtpVerification])`, register `JwtStrategy`, `GoogleStrategy` placeholder, `WhatsAppProvider` providers, export `AuthService`)

**Checkpoint**: Foundation ready — migrations pass, `User` nullable password + uniques work, `JwtStrategy` revocation check wired

---

## Phase 3: User Story 1 - Forgot Password & Secure Recovery (Priority: P1) 🎯 MVP

**Goal**: Secure anti-enumeration `POST /auth/forgot-password`, `POST /auth/validate-reset-token`, `POST /auth/reset-password` with sha256 single-use token (15m) + bcrypt + `tokenVersion` revocation per F2 C (Q3) + `FOR UPDATE` concurrency + hybrid publish per C2 + full headers per B1

**Independent Test**: Register → `forgot-password` existing+non-existing both 200 → capture rawToken → `validate-reset-token` 200/400 → `reset-password` 200 (old password fails, new succeeds, second reuse 400, expired 400) → old JWT 401 after reset. SC-001/002/003.

### Tests for User Story 1 ⚠️ Write FIRST, ensure FAIL before implementation

- [X] T014 [P] [US1] Unit test `requestPasswordReset` anti-enum in `src/modules/auth/auth.service.spec.ts` (existing email creates hashed token + invalidates priors, non-existing still 200, tokenHash sha256, expiresAt 15m)
- [X] T015 [P] [US1] Unit test `validateResetToken` and `resetPassword` in `src/modules/auth/auth.service.spec.ts` (valid → user, expired/used/wrong →400, weak password 400, newPassword===email 400, second use 400)
- [X] T016 [P] [US1] Integration test `PasswordResetToken` constraints + `FOR UPDATE` single-winner in `src/modules/auth/test/auth.integration.spec.ts` (real PG: duplicate email 409 already, token CHECK, concurrent reset same token → one 200 one 400)
- [X] T017 [US1] E2E test forgot→reset→login flow in `test/auth.e2e-spec.ts` (supertest `POST /auth/register` → `forgot-password` → test hook rawToken → `reset-password` → `login` new password 200)

### Implementation for User Story 1

- [X] T018 [P] [US1] Create DTOs in `src/modules/auth/dto/forgot-password.dto.ts` (`@IsEmail`), `src/modules/auth/dto/validate-reset-token.dto.ts` (`email, token`), `src/modules/auth/dto/reset-password.dto.ts` (`email, token, newPassword MinLength 8 MaxLength 72`)
- [X] T019 [US1] Implement `AuthService.requestPasswordReset(email)` in `src/modules/auth/auth.service.ts` (validate, lookup user, `dataSource.transaction` invalidate priors + insert sha256 tokenHash `timingSafeEqual` compare per B2, after commit emit **RabbitMQ** `auth.password_reset_requested` `{userId,email,rawToken,expiresAt}` per hybrid C choice — no I/O inside tx, `Retry-After` full headers B1 ready)
- [X] T020 [US1] Implement `AuthService.validateResetToken(email, rawToken)` in `src/modules/auth/auth.service.ts` (hash, join user, check expiry/usedAt, throw 400)
- [X] T021 [US1] Implement `AuthService.resetPassword(dto)` in `src/modules/auth/auth.service.ts` (transaction `SELECT FOR UPDATE` tokenHash+userId, timingSafeEqual verify, bcrypt 10, update `User.password` + increment `User.tokenVersion` (F2 C) atomically, set `usedAt`, invalidate others, per FR-004; old JWTs with stale tokenVersion →401)
- [X] T022 [US1] Add controller routes in `src/modules/auth/auth.controller.ts` (`POST /auth/forgot-password` public always 200, `POST /auth/validate-reset-token`, `POST /auth/reset-password` all via service, Swagger `@ApiProperty`)
- [X] T023 [US1] Wire `tokenVersion` check in `src/modules/auth/strategies/jwt.strategy.ts` validate (reject `payload.tokenVersion !== user.tokenVersion` per F2 C) and ensure old JWT →401 after reset per Q3; extend `login()` to embed `tokenVersion` in JWT
- [X] T024 [US1] Update `AuthService.userValidation` in `src/modules/auth/auth.service.ts` to return null when `User.password IS NULL` (pure OAuth) for local strategy per Assumptions
- [X] T025 [US1] Add post-commit notification publish after `forgot-password` commit (RabbitMQ topic `auth.password_reset_requested` per hybrid C) and mock in unit/integration tests; verify payload includes rawToken only in event, never logged

**Checkpoint**: US1 independently testable — `npm run test -- --runInBand` + `quickstart.md` forgot/validate/reset curls pass, concurrent token SINGLE-WINNER verified

---

## Phase 4: User Story 2 - WhatsApp OTP Verification & Passwordless Login — **DEFERRED / TODO (Future) per 2026-09-16** (Priority: P2 → Future)

**Status**: **DEFERRED** — login is **password-only** (`POST /auth/login` requires password) in V1. `POST /auth/otp/request|verify` return `501 Not Implemented` until WhatsApp Business setup. DTOs/provider/entities still migrate but OTP logic is **paused (TODO)**.

**Goal** (Future): `POST /auth/otp/request` + `POST /auth/otp/verify` with `WhatsAppProvider` Noop/Twilio/Meta, E.164, `crypto.randomInt` 6-digit sha256, Redis TTL 300s + PG `OtpVerification` fallback (Q4), 3 attempts, 60s cooldown, purpose `login` (JWT) + `verify_phone` (verified:true) — registration still requires password, email OTP deferred (§16.8)

**Independent Test** (Future — TODO): `POST /auth/register` (password required) → `POST /auth/login` password 200 AND `POST /auth/otp/request` phone → mock captures OTP → `POST /auth/otp/verify` purpose login →200 JWT (same shape) + `GET /cart` 200; purpose verify_phone →200 verified:true; expired/4th attempt 400/429; resend cooldown 60s →429. Also stop Redis → verify still succeeds via PG fallback (Q4). **Currently 501 TODO**.

### Tests for User Story 2 ⚠️ — TODO Future

- [ ] T026 [P] [US2] Unit test OTP request generation in `src/modules/auth/auth.service.spec.ts` (E.164 validation, `crypto.randomInt` 6-digit, sha256 hash, Redis SET EX 300, DB row, Noop provider capture, cooldown 60s →429) — **TODO Future, deferred**
- [ ] T027 [P] [US2] Unit test OTP verify in `src/modules/auth/auth.service.spec.ts` (correct within TTL → JWT or verified:true, expired →400, 4th attempt invalidates →400/429, `purpose=reset_password` in V1 →400, phoneVerified flag) — **TODO Future**
- [ ] T028 [P] [US2] Integration test Redis TTL + PG fallback in `src/modules/auth/test/otp.integration.spec.ts` (real PG+Redis: request → verify within TTL 200, after TTL 400, Redis down fallback via DB row per Q4) — **TODO Future**
- [ ] T029 [US2] E2E test passwordless login in `test/auth.e2e-spec.ts` (register → `otp/request` → `otp/verify` purpose login → JWT → `GET /cart` 200; also `purpose verify_phone`) — **TODO Future**

### Implementation for User Story 2 — TODO Future (code paused, returns 501)

- [X] T030 [P] [US2] Create DTOs in `src/modules/auth/dto/request-otp.dto.ts` (`phoneNumber @Matches E.164, purpose @IsEnum login|verify_phone`) and `src/modules/auth/dto/verify-otp.dto.ts` (`phoneNumber, otp @Length 6, purpose`) — **done, but guarded TODO**
- [X] T031 [P] [US2] Create `WhatsAppProvider` interface and `NoopWhatsAppProvider`/`TwilioWhatsAppProvider`/`MetaCloudWhatsAppProvider` in `src/modules/auth/providers/whatsapp.provider.ts` (Research D6, `WHATSAPP_PROVIDER` selector) — **done, paused**
- [X] T032 [US2] Implement `AuthService.requestWhatsAppOtp(dto, currentUser?)` in `src/modules/auth/auth.service.ts` (normalize E.164, rate-limit with full headers B1, `SET NX EX` cooldown, `crypto.randomInt` → sha256 → Redis + `OtpVerification` insert with timingSafeEqual ready, send via BullMQ `authOtpSend` per hybrid C after commit — no I/O inside PG tx) — **implemented but TODO-guarded to 501 in controller per 2026-09-16**
- [X] T033 [US2] Implement `AuthService.verifyWhatsAppOtp(dto)` in `src/modules/auth/auth.service.ts` (fetch Redis first, fallback to DB when Redis down per Q4 — check expiresAt/attempts via timingSafeEqual, increment `attempts` on **every** attempt including success per B2 choice B before delete, mark phoneVerified, delete key/verifiedAt on success/3 fails, issue JWT `tokenVersion` for login vs verified:true for verify_phone) — **implemented but TODO-guarded**
- [X] T034 [US2] Add controller routes in `src/modules/auth/auth.controller.ts` (`POST /auth/otp/request` public+JwtGuard optional phone, `POST /auth/otp/verify` public — service calls, Swagger) — **now returns 501 TODO in V1 password-only mode**
- [X] T035 [US2] Ensure login choice is discoverable: `POST /auth/login` (LocalAuthGuard) remains password path, OTP path issues same JWT shape (`sub,email,fullName,role,tokenVersion`) per Q2 + F2 C — update `src/modules/auth/types.ts` to include `tokenVersion` — **password-only in V1, OTP TODO**

**Checkpoint**: US1 works password-only; US2 is **DEFERRED — TODO Future** (501). `npm run test -- --runInBand` skips OTP flows until re-enabled; Swagger shows login password-only.

---

## Phase 5: User Story 3 - Google OAuth Login & Account Linking (Priority: P3)

**Goal**: `GET /auth/google` (302), `GET /auth/google/callback` →200 JSON `{accessToken}` per Q5 + `GET /auth/google/link` (JwtGuard), `passport-google-oauth20`, auto-link verified email per Q1, `password` nullable handling, `state: true`

**Independent Test**: Mocked Google profile → `GET /auth/google` 302 → `GET /auth/google/callback?code=` →200 JWT (new user, existing googleId reuse, verified email auto-link); unverified email →400; `GET /auth/google/link` with JWT links; `GET /cart` with JWT 200.

### Tests for User Story 3 ⚠️

- [X] T036 [P] [US3] Unit test `handleGoogleLogin` in `src/modules/auth/auth.service.spec.ts` (existing googleId returns same user, existing verified email auto-links per Q1, new email creates provider google null password, unverified → reject, duplicate googleId partial unique 409)
- [X] T037 [P] [US3] Unit test `GoogleStrategy` validate in `src/modules/auth/strategies/google.strategy.test.ts` (profile mapping, scope profile email, state true)
- [X] T038 [US3] E2E test Google mocked callback in `test/auth.e2e-spec.ts` (GET /auth/google 302, GET /auth/google/callback mocked →200 JWT → `GET /cart` 200; link flow)

### Implementation for User Story 3

- [X] T039 [P] [US3] Create `GoogleStrategy` in `src/modules/auth/strategies/google.strategy.ts` (PassportStrategy(Strategy,'google'), clientID/secret/callbackURL via ConfigService, scope profile email, state true, validate extracts googleId/email/firstName/lastName/verifed)
- [X] T040 [P] [US3] Create guards `src/modules/auth/guards/google-auth.guard.ts` (extends AuthGuard('google')) and keep `src/modules/auth/guards/jwt-auth.guard.ts` wrapper
- [X] T041 [US3] Implement `AuthService.handleGoogleLogin(profile)` and `linkGoogleAccount(userId, profile)` in `src/modules/auth/auth.service.ts` (FR-011 logic: googleId→user, verified email→link, else create User provider google password null, issue JWT via `jwtService.sign` same payload)
- [X] T042 [US3] Add controller routes in `src/modules/auth/auth.controller.ts` (`GET /auth/google` GoogleAuthGuard 302, `GET /auth/google/callback` GoogleAuthGuard → handleGoogleLogin →200 JSON per Q5, `GET /auth/google/link` JwtGuard+GoogleAuthGuard)
- [X] T043 [US3] Handle `User.password IS NULL` in `src/modules/auth/strategies/local.strategy.ts` / `userValidation` (pure OAuth user must use Google, not local login)
- [X] T044 [US3] Add `passsport-google-oauth20` error handling in `src/modules/auth/strategies/google.strategy.ts` (missing secret/state mismatch →401 via AllExceptionsFilter)

**Checkpoint**: All 3 stories work independently; `npm run test -- --runInBand` passes; quickstart Google curls (mocked) succeed; Swagger documents OAuth endpoints

---

## Phase 6: User Story 4 - Rate Limiting & Anti-Abuse on Auth Endpoints (Priority: P2, cross-cutting)

**Goal**: Rate limits `forgot-password 5/h/IP+3/h/email, reset-password 10/h/IP, otp/request 5/h/phone+10/h/IP cooldown 60s, otp/verify 10/h/phone, google/callback 20/h/IP, login/register 10/h/IP` via Redis `INCR+EXPIRE`/`SET NX EX` with fail-open + `Retry-After` 429

**Independent Test**: Spam each endpoint over limit →6th is 429 with `Retry-After`; disconnect Redis → request still succeeds with `Logger.warn` (fail-open) per FR-014.

### Tests for User Story 4 ⚠️

- [X] T045 [P] [US4] Unit test `RateLimitGuard` in `src/modules/auth/guards/rate-limit.guard.spec.ts` (mock CACHE_MANAGER, INCR+EXPIRE increments, threshold →429, Redis down fail-open logs)
- [X] T046 [US4] Integration test rate limiting with real Redis in `src/modules/auth/test/rate-limit.integration.spec.ts` (exceed forgot/otp/google/login →429, Redis down →200 + warn)

### Implementation for User Story 4

- [X] T047 [US4] Implement `RateLimitGuard` (or shared) in `src/modules/auth/guards/rate-limit.guard.ts` (per-endpoint limits from FR-014, IP+email/phone keys, atomic Redis `INCR+EXPIRE`/`SET NX EX`, fail-open with `Logger.warn` + metric `auth_rate_limit_fallback_total`, return `429` with `Retry-After` + `X-RateLimit-Limit/Remaining/Reset` per B1 choice B)
- [X] T048 [US4] Apply guard to all new auth routes in `src/modules/auth/auth.controller.ts` (and existing `POST /auth/login|register` per plan) — decorator `@UseGuards(RateLimitGuard)` with metadata limits or centralized map
- [X] T049 [US4] Add config keys `THROTTLE_*`/`RATE_LIMIT_*` via `ConfigService` and expose in `.env.example` (reuse `RESET_TOKEN_TTL` etc.)

**Checkpoint**: All 4 stories + rate limit pass — `npm run test -- --runInBand` shows 429/ fail-open cases

---

## Phase 7: Polish & Cross-Cutting Concerns

**Purpose**: Docs, Swagger, ADRs, cleanup, full verification (affects all stories)

- [X] T050 [P] Update Swagger in `src/modules/auth/auth.controller.ts` (add `@ApiOperation`, `@ApiResponse` for all 7 new endpoints, E.164 example `+201012345678`, JWT bearer auth for `/google/link` + `/otp/request` JwtGuard variant)
- [X] T051 [P] Write ADR in `docs/decisions/ADR-auth-upgrades.md` (record auto-link Q1, login OTP choice Q2, tokenVersion revocation Q3 + F2 choice C stateless, Redis+PG fallback Q4, OAuth JSON Q5, hybrid queue C2 (RabbitMQ password reset + BullMQ OTP), full headers B1, every-attempt B2, email OTP deferred §16.8, infra exception for ephemeral OTP)
- [X] T052 [P] Update `docs/architecture/modules.md` and `docs/api/conventions.md` (auth module expands: password reset token, OTP provider, Google strategy, rate limits; keep inventory/reservation unchanged)
- [X] T053 [P] Add Postman/Swagger examples and verify `http://localhost:3000/api` lists all new auth endpoints
- [X] T054 Remove leftover `console.log` in `src/modules/auth/auth.service.ts:21` when touching that file (replace with `Logger`)
- [X] T055 Run full verification: `npm run lint` + `npm run build` + `npm run test -- --runInBand` + `npm run test:e2e` — ensure 30+ unit, 10+ integration, 3 E2E flows (forgot→reset→login, otp/request→verify→JWT, google callback→JWT→protected) + concurrent token single-winner pass; verify `AllExceptionsFilter` returns `{statusCode, message, timestamp}` for `429` with `Retry-After` + `X-RateLimit-*` per E1, and `grep -r "@InjectRepository(User)" src/modules --exclude-dir=users` →0 per E2, and `ConfigService` env keys loaded
- [X] T056 [P] Verify PostgreSQL constraints via `psql` (duplicate email 409, duplicate non-null googleId/phoneNumber 409, Check expiresAt>createdAt, attempts<=3)
- [X] T057 [P] Manual quickstart validation per `specs/005-auth-upgrades/quickstart.md` (all curl scenarios including JWT revocation old JWT 401, Redis-down fallback, Google mocked 302/200)
- [X] T058 Update `docs/plan.md` backlog `NOT DONE → DONE` markers for Phase 16 items if/when implemented (track in `Current Backlog Status`)

---

## Dependencies & Execution Order

### Phase Dependencies

- **Setup (Phase 1)**: No dependencies — can start immediately
- **Foundational (Phase 2)**: Depends on Setup — **BLOCKS all user stories**
- **User Stories (Phase 3-6)**: All depend on Foundational
  - US1 (P1) can start first → **MVP** (register→forgot→reset→login + JWT revocation)
  - US2 (P2) depends only on Foundational (can run parallel with US1 after foundation, but MVP is US1 alone)
  - US3 (P3) depends on Foundational + `password nullable` + `JwtStrategy` (can parallelize after foundation)
  - US4 (P2 cross-cutting) depends on Foundational + Redis infra; can be added last or interleaved
- **Polish (Phase 7)**: Depends on all desired stories being complete

### User Story Dependencies

- **US1 (P1) Forgot Password & Recovery**: No deps on other stories — standalone JWT revocation + anti-enum
- **US2 (P2) WhatsApp OTP**: Independent of US1 (different token vs OTP path) — shares `User.phoneNumber`/`phoneVerified` and fallback model only
- **US3 (P3) Google OAuth**: Independent — shares `User.googleId`/`provider`/`password nullable` but creates/links user via different flow
- **US4 (P2) Rate Limiting**: Cross-cutting — technically independent but applies to endpoints from US1-3

### Within Each User Story

- Tests (if included) MUST be written and FAIL before implementation
- DTOs/entities before services
- Services before controller routes
- Rate-limit guard before its integration
- Story complete before next priority (except parallel team case)

### Parallel Opportunities

- **Setup**: T002 + T003 + T004 can run in parallel
- **Foundational**: T005-T009 entity/migration scaffolding can be split, but T010 migration verification depends on T005-T009; T011 + T012 can run in parallel
- **US1**: T014 + T015 + T016 unit/integration tests can run in parallel ([P]); T018 DTOs can parallelize
- **US2**: T026-T028 tests + T030-T031 DTOs/providers can parallelize
- **US3**: T036-T037 tests + T039-T040 strategy/guards can parallelize
- Once Foundational completes, US1, US2, US3 can start in parallel if staffed (different files); US4 guard can parallelize with any story
- Polish T050-T053 docs can run in parallel

---

## Parallel Example: User Story 1 (MVP)

```bash
# Launch all US1 tests together (fail first):
Task T014 — requestPasswordReset unit
Task T015 — validateResetToken + resetPassword unit
Task T016 — integration FOR UPDATE race
# In parallel, create DTOs:
Task T018 — ForgotPasswordDto, ResetPasswordDto, ValidateResetTokenDto
```

---

## Implementation Strategy

### MVP First (User Story 1 Only)

1. Complete Phase 1: Setup
2. Complete Phase 2: Foundational (critical — migrations + JwtStrategy + phone/google columns)
3. Complete Phase 3: US1 (forgot/validate/reset + JWT revocation per Q3)
4. **STOP and VALIDATE**: `POST /auth/register` → `forgot-password` (existing+non-existing 200) → rawToken → `validate-reset-token` 200/400 → `reset-password` 200 → old JWT 401, new `login` 200, reuse 400, concurrent race single-winner; `npm run test -- --runInBand`
5. Deploy/demo MVP — password recovery unblocks all future auth!

### Incremental Delivery

1. Setup + Foundational → foundation ready (DB invariants, JWT revocation hook)
2. Add US1 → test independently → deploy/demo (MVP)
3. Add US2 → WhatsApp OTP login/verify (Noop → real provider), verify `purpose login` issues JWT same shape — test independently → deploy
4. Add US3 → Google OAuth JSON callback (auto-link verified email Q1) — test independently → deploy
5. Add US4 → Rate limiting fail-open across all endpoints — chaos test Redis down
6. Polish → ADRs, Swagger, quickstart.md validation, `update docs/plan.md` DONE markers

### Parallel Team Strategy

With 3 developers after Foundational:

- Dev A: US1 (Forgot/Reset + revocation)
- Dev B: US2 (WhatsApp OTP + fallback Q4)
- Dev C: US3 (Google OAuth + JSON Q5) + US4 rate limiting

Stories integrate via shared `User` columns but are file-disjoint (service methods, DTOs, guards) — can merge independently and verify via `npm run test -- --runInBand`.

---

## Notes

- [P] tasks = different files, no dependencies — safe to run in parallel
- [Story] label maps task to spec US — e.g. [US1] forgot, [US2] WhatsApp OTP, [US3] Google, [US4] rate limit
- Each story independently completable: US1 needs only PasswordResetToken + User alterations + JwtStrategy; US2 needs OtpVerification + provider; US3 needs GoogleStrategy
- Commit after each task or logical group; `synchronize:false` — never edit committed migration
- Q1-Q5 clarifications are in code: Q1 auto-link handled in T041, Q2 login choice in T035, Q3 revocation in T021/T023, Q4 fallback in T032/T033, Q5 JSON in T042
- Deferred email OTP (spec §16.8) intentionally has **no tasks** — it is future work; do not implement in this phase
- Keep `console.log` removal (T054) and verification (T055-T058) until Polish





