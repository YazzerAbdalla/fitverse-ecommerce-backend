# Tasks: Refresh Token Rotation — Phase 17

**Input**: Design documents from `specs/013-refresh-token/` (spec.md, plan.md, research.md, data-model.md, contracts/auth-refresh-contracts.md, quickstart.md)
**Prerequisites**: plan.md, spec.md (4 user stories P1/P1/P2/P2), research D1-D8, data-model RefreshToken, contracts 5 endpoints
**Tests**: Included per spec SC-001..008 — unit mocked + integration real PG FOR UPDATE + real Redis FLUSHDB + E2E supertest --runInBand
**Organization**: Grouped by user story for independent implementation/testing; cap 5 LRU and dual rate-limit are foundational; Google callback extension maps to US2 login.

## Format: `[ID] [P?] [Story] Description`

- **[P]**: Can run in parallel (different files, no dependencies)
- **[Story]**: Which user story (US1, US2, US3, US4)

## Phase 1: Setup (Shared Infrastructure)

**Purpose**: Tooling, dependencies, config placeholders

- [ ] T001 Install `cookie-parser` + `@types/cookie-parser` and add `app.use(cookieParser())` wiring placeholder in `src/main.ts`
- [ ] T002 [P] Create `src/modules/auth/dto/refresh-token.dto.ts` skeleton (RefreshTokenDto, LogoutDto placeholders)
- [ ] T003 [P] Update `.env.example` with `REFRESH_TOKEN_TTL=7d`, `REFRESH_TOKEN_COOKIE_NAME=refresh_token`, `REFRESH_TOKEN_COOKIE_SECURE=false`, `REFRESH_RL_MAX/LOGOUT_*` per `quickstart.md` in `.env.example`

---

## Phase 2: Foundational (Blocking Prerequisites)

**Purpose**: RefreshToken persistence and shared guards — MUST complete before any US can start

**⚠️ CRITICAL**: No user story work can begin until this phase is complete

- [ ] T004 Create `RefreshToken` entity `src/modules/auth/entities/refresh-token.entity.ts` with `@Entity`, `@PrimaryGeneratedColumn('uuid')`, `userId FK CASCADE @Index`, `tokenHash @Index`, `expiresAt @Check`, `revokedAt nullable`, `createdAt/updatedAt`, indexes `userId/tokenHash/expiresAt/userId,expiresAt` per `data-model.md`
- [ ] T005 Generate migration `src/migration/17xxxxxxxxxx-CreateRefreshToken.ts` for `RefreshToken` table + `CHK_refresh_token_expires_gt_createdAt` + indexes + partial unique `UQ_refresh_token_hash_active WHERE revokedAt IS NULL` + `FK_refresh_token_userId CASCADE` (synchronize:false)
- [ ] T006 [P] Implement `RefreshTokenDto` (`refreshToken?: string @IsString @Length(64,64) @Matches(/^[0-9a-f]{64}$/) @IsOptional()`) + `LogoutDto` same in `src/modules/auth/dto/refresh-token.dto.ts` with class-validator decorators
- [ ] T007 Wire `cookie-parser` in `src/main.ts` before `ValidationPipe` (`import cookieParser from 'cookie-parser'; app.use(cookieParser())`), verify `req.cookies` populated
- [ ] T008 Extend `parseTtlMs` in `src/modules/auth/auth.service.ts` to handle `d` suffix (`7d → 604800000`) for `REFRESH_TOKEN_TTL` (support `s/m/h/d` per FR-009)
- [ ] T009 Update `src/modules/auth/auth.module.ts` to import `TypeOrmModule.forFeature([RefreshToken])` alongside `User`, export `AuthService`/`RateLimitGuard`

**Checkpoint**: Foundation ready — `RefreshToken` entity migrated, DTO validates `64hex`, `cookieParser`+`parseTtlMs` ready; US2/US1/US3/US4 can now start in parallel (US2 before US1 logical dependency)

---

## Phase 3: User Story 2 — Login issues refresh token alongside access token (Priority: P1) 🎯 MVP prerequisite

**Goal**: `POST /auth/login` (and `GET /auth/google/callback`) returns `{accessToken 15m, refreshToken 64hex}` + `Set-Cookie: refresh_token` with PG `tokenHash=sha256(raw)` `expiresAt=now+7d` `revokedAt NULL` + cap 5 LRU

**Independent Test**: `register → POST /auth/login valid 200 {accessToken,refreshToken 64hex} Set-Cookie refresh_token + DB count 1 active`; invalid `401` no row; `GET /auth/google/callback` mocked profile → `200 {accessToken,refreshToken}` + cookie; `FLUSHDB` not needed

### Tests for User Story 2

- [ ] T010 [P] [US2] Unit test `login creates hashed refresh 7d` in `src/modules/auth/auth.service.spec.ts` — mock `DataSource`/`JwtService.signAsync`/`ConfigService REFRESH_TOKEN_TTL 7d`, assert `repo.save` called with `tokenHash 64hex sha256`, `expiresAt now+7d ±5s`, returned `refreshToken 64hex`, cap 5 LRU eviction when `active>=5` revokes oldest
- [ ] T011 [P] [US2] Unit test `login invalid no refresh row` + `google callback issues refresh` in `src/modules/auth/auth.service.spec.ts` — invalid creds `401` `repo.save 0`, `handleGoogleLogin` verified profile creates/linked user then `repo.save` `RefreshToken` + `{accessToken,refreshToken}`

### Implementation for User Story 2

- [ ] T012 [P] [US2] Implement `AuthService.login` extension in `src/modules/auth/auth.service.ts` — after `JwtService.signAsync`, generate `raw=randomBytes(32).hex 64`, `tokenHash=sha256(raw)`, `expiresAt=now+parseTtlMs(REFRESH_TOKEN_TTL||7d)`, enforce cap 5 LRU `if activeCount>=5 revoke oldest FOR UPDATE`, `repo.save {userId,tokenHash,expiresAt}`, return `{message, accessToken, refreshToken: raw}` + Logger prefix `tokenHash.slice(0,6)`
- [ ] T013 [US2] Extend `AuthService.handleGoogleLogin` in `src/modules/auth/auth.service.ts` to issue `RefreshToken` same as `login` (cap 5, sha256, 7d) and return `{user, accessToken, refreshToken}` for controller
- [ ] T014 [US2] Update `AuthController.login` in `src/modules/auth/auth.controller.ts` — keep `@UseGuards(RateLimitGuard, LocalAuthGuard)`, inject `@Res({passthrough:true}) res`, call `authService.login(user)`, `res.cookie(REFRESH_TOKEN_COOKIE_NAME, result.refreshToken, {httpOnly:true, secure:config.get(REFRESH_TOKEN_COOKIE_SECURE)==='true', sameSite:'strict', path:'/auth', maxAge: parseTtlMs(REFRESH_TOKEN_TTL)})`, return `{accessToken, refreshToken}`, Swagger `@ApiResponse 200 {accessToken,refreshToken}` `401/429`
- [ ] T015 [US2] Update `AuthController.googleCallback` in `src/modules/auth/auth.controller.ts` — after `handleGoogleLogin(profile)`, set same `res.cookie` + return `{accessToken, refreshToken}` (handle `refreshToken` from service), `GET /auth/google/link` optional same if re-issues JWT

**Checkpoint**: US2 fully functional — `POST /auth/login` + `GET /auth/google/callback` both issue refresh + cookie, DB `sha256` stored, cap 5 LRU, `Set-Cookie` HttpOnly correct

---

## Phase 4: User Story 1 — Silent refresh after accessToken expiry — single-use rotation (Priority: P1) 🎯 MVP

**Goal**: `POST /auth/refresh` (body `refreshToken` OR `Cookie: refresh_token` fallback, `FOR UPDATE` lookup `revokedAt IS NULL && expiresAt>NOW()` → `UPDATE old.revokedAt=NOW()` + `INSERT new sha256 7d` + `sign {sub,email,fullName,role,tokenVersion}`) `200 {accessToken,refreshToken}+Set-Cookie`; reuse old → `401` theft `UPDATE revokedAt=NOW() WHERE userId AND revokedAt IS NULL` + `Logger.warn`; expired/revoked/unknown → `401`; concurrent `Promise.all` single-winner; `X-Email-Unverified: true` when `emailVerified=false`

**Independent Test**: `login → GET /order 200 → POST /auth/refresh old 200 new pair + old revokedAt → GET /order new 200 → POST /auth/refresh old 401 no new row + theft revoke-all` + `Cookie` fallback `200` + `expiresAt<=NOW() 401` + concurrent `Promise.all` `200+401` single new active, `UPDATE inventory 0`

### Tests for User Story 1

- [ ] T016 [P] [US1] Unit test `refresh rotation FOR UPDATE single-winner` in `src/modules/auth/auth.service.spec.ts` — mock `DataSource.transaction` `SELECT ... FOR UPDATE` active row → `UPDATE old revokedAt` + `INSERT new` + `sign`, then second `refresh(oldRaw)` → `401` `UPDATE 0 new 0`, assert `Logger.warn prefix` not raw, `X-Email-Unverified` header logic when `user.emailVerified=false`
- [ ] T017 [P] [US1] Unit test `refresh expired/revoked/unknown 401` + `cookie fallback` in `src/modules/auth/auth.service.spec.ts` — fixtures `expiresAt=NOW()-1s`, `revokedAt=NOW()`, unknown hash → `401`; `req.cookies[REFRESH_TOKEN_COOKIE_NAME]` path succeeds when body empty
- [ ] T018 [P] [US1] Integration test `refresh rotation + theft concurrent` with real PG `FOR UPDATE` in `src/modules/auth/test/refresh.integration.spec.ts` — real `RefreshToken` active, `POST /auth/refresh` body `200` new active `old revokedAt`, second old `401` `active count 1`; `Promise.all([refresh(old), refresh(old)])` single `200+401` `active 1` + theft bulk revoke; `EXPLAIN` shows `FOR UPDATE` on `tokenHash`
- [ ] T019 [US1] Integration test `refresh expiry + secure cookie attributes` in `src/modules/auth/test/refresh.integration.spec.ts` — insert `expiresAt NOW()-1s` → `401`; assert `Set-Cookie` header `HttpOnly; SameSite=Strict; Path=/auth; Max-Age=604800` on `200`

### Implementation for User Story 1

- [ ] T020 [US1] Implement `AuthService.refresh` in `src/modules/auth/auth.service.ts` — `raw = dto.refreshToken ?? cookieRaw ?? parseCookie(req.headers.cookie)`; if `!raw` throw `UnauthorizedException`; `tokenHash=sha256(raw)`; `dataSource.transaction(async manager => { FOR UPDATE SELECT RefreshToken WHERE tokenHash=:hash; if !found/!user → 401; if revokedAt → after-rollback theft UPDATE WHERE userId AND revokedAt IS NULL + Logger.warn prefix + INCR optional → 401; if expiresAt<=now → 401; else UPDATE old revokedAt + cap5 LRU check + newRaw/hash/expiresAt INSERT + sign newAccessToken })` + Logger after commit + `X-Email-Unverified` flag on user; JSDoc `@param @returns @throws UnauthorizedException`
- [ ] T021 [US1] Add `AuthController.refresh` route `POST /auth/refresh` in `src/modules/auth/auth.controller.ts` — `@UseGuards(RateLimitGuard)` public, `@Body() dto: RefreshTokenDto` `@Req() req` `@Res({passthrough:true}) res`, resolve `raw = dto.refreshToken ?? req.cookies[cookieName] ?? parseCookie`, call `authService.refresh(raw, cookieRaw)`, set `res.cookie` same attributes, if service returns `emailVerified false` then `res.setHeader('X-Email-Unverified','true')`, return `{accessToken, refreshToken}`; Swagger `Refresh via Cookie or Body` `200/401/400/429` + `@UseGuards(RateLimitGuard)` outermost before `ValidationPipe`

**Checkpoint**: US1 fully functional — `POST /auth/refresh` rotates single-use, theft 401+revoke-all, cookie fallback, `X-Email-Unverified`, concurrent single-winner proved real PG

---

## Phase 5: User Story 3 — Logout single + logout-all (Priority: P2)

**Goal**: `POST /auth/logout` public body|cookie `UPDATE revokedAt=NOW() WHERE tokenHash AND revokedAt IS NULL` `200` idempotent `0 rows 200` anti-enum; `POST /auth/logout-all` `@Auth()` `JwtGuard` `tokenVersion++` + bulk `UPDATE revokedAt NOW() WHERE userId AND revokedAt IS NULL` atomic `200`, subsequent `refresh` old `401` + `GET /order` old `401`

**Independent Test**: `login×2 r1,r2 active 2 → POST /auth/logout r1 200 active 1 → refresh r1 401 r2 200 → logout r1 again 200 active 1 → POST /auth/logout-all Bearer 200 tokenVersion 0→1 active 0 → refresh r2 401 + GET /order old 401 + login new 200 tokenVersion 1` + `reset-password → refresh old 401`

### Tests for User Story 3

- [ ] T022 [P] [US3] Unit test `logout idempotent 200 + logout-all tokenVersion++` in `src/modules/auth/auth.service.spec.ts` — `logout(r1) 200 revokedAt`, second `logout(r1) 200 0 UPDATE`; `logoutAll(userId)` `SELECT User FOR UPDATE` `tokenVersion 0→1` bulk `UPDATE revokedAt` `2→0` active
- [ ] T023 [P] [US3] Integration test `logout + logout-all real PG` in `src/modules/auth/test/refresh.integration.spec.ts` — real `login×2` active 2 → `POST /auth/logout {r1} 200` `active 1` → `POST /auth/refresh r1 401` `r2 200` → `POST /auth/logout-all Bearer 200` `tokenVersion 1` `SELECT tokenVersion 1` `active 0` → `POST /auth/refresh r2 401` → `GET /order` old 401 + `POST /auth/reset-password → refresh old 401`

### Implementation for User Story 3

- [ ] T024 [US3] Implement `AuthService.logout` + `AuthService.logoutAll` in `src/modules/auth/auth.service.ts` — `logout(raw, cookieRaw)` resolves `raw`, if `!raw` return `200` (anti-enum) else `sha256` `UPDATE RefreshToken SET revokedAt=NOW() WHERE tokenHash=:hash AND revokedAt IS NULL` `Logger prefix`; `logoutAll(userId)` `dataSource.transaction` `SELECT User FOR UPDATE` `userRepo.update(tokenVersion +1)` + `UPDATE RefreshToken SET revokedAt=NOW() WHERE userId=:id AND revokedAt IS NULL`; JSDoc + `// idempotent 0 rows still 200` comments
- [ ] T025 [US3] Add `AuthController.logout` `POST /auth/logout` + `logoutAll` `POST /auth/logout-all` in `src/modules/auth/auth.controller.ts` — `logout` public `@UseGuards(RateLimitGuard)` body|cookie `authService.logout` `200 {message:"Logged out"}`; `logoutAll` `@Auth()` `@UseGuards(RateLimitGuard, JwtAuthGuard)` empty body `forbidNonWhitelisted`, `authService.logoutAll(currentUser.sub)` `200 {message:"All sessions revoked"}`; Swagger `401/429` for logoutAll

**Checkpoint**: US3 fully functional — single logout idempotent `200` anti-enum, logout-all nukes `tokenVersion`+bulk `revokedAt`, `reset-password`→refresh `401` proven

---

## Phase 6: User Story 4 — Rate limiting and observability (Priority: P2) cross-cutting

**Goal**: `RateLimitGuard` distributed `CACHE_MANAGER` `rl:*` `INCR+EXPIRE` fail-open outermost before `JwtGuard`: `POST /auth/refresh 10/h IP + 5/h per tokenHash 6-prefix` dual buckets before `FOR UPDATE`, `POST /auth/logout 20/h IP`, `POST /auth/logout-all 10/h user`, `429` `Retry-After:3600` `X-RateLimit-*` via `AllExceptionsFilter`, Redis down → `Logger.warn RateLimit Redis fail-open` + allow `200`, logs contain hash prefix only never raw

**Independent Test**: `11× POST /auth/refresh same IP → 11th 429 Retry-After 3600 X-RateLimit-*` `DataSource.transaction 0` on `429`; `CACHE_MANAGER throw → 200 fail-open Logger.warn`; second `refresh` expiry spam `5/h hash` → `429` before `FOR UPDATE`

### Tests for User Story 4

- [ ] T026 [P] [US4] Unit test `RateLimitGuard dual buckets` in `src/modules/auth/guards/rate-limit.guard.spec.ts` — mock `CACHE_MANAGER get/set` `rl:POST /auth/refresh:ip:1.1.1.1` `10→429` + `rl:POST /auth/refresh:hash:abc123` `5→429` dual before `FOR UPDATE`, `logout 20/h` + `logout-all 10/h user isolation`, fail-open `CACHE throw → Logger.warn + true` headers absent, assert `DataSource.transaction 0` on `429`
- [ ] T027 [US4] Integration test `rate-limit 429 real Redis FLUSHDB` in `src/modules/auth/test/refresh.integration.spec.ts` — `FLUSHDB` then `11× POST /auth/refresh` same IP `11th 429` `Retry-After 3600` `X-RateLimit-Limit`; `POST /auth/logout ×21` `21st 429`; mock `FLUSHDB` then `CACHE throw → POST /auth/refresh still 200 Logger.warn` fail-open `UPDATE inventory 0`

### Implementation for User Story 4

- [ ] T028 [US4] Extend `RateLimitGuard` in `src/modules/auth/guards/rate-limit.guard.ts` — add `DEFAULT_LIMITS` keys `'POST /auth/refresh' {max:10, windowMs:3600_000, bucket:'ip+hash'}` dual check `await INCR rl:refresh:ip + rl:refresh:hash:tokenHash.slice(0,6)` `5/3600` (both must pass), `'POST /auth/logout' 20/ip`, `'POST /auth/logout-all' 10/user` (`req.user.sub ?? ip`), `ConfigService` overrides `REFRESH_RL_MAX` etc clamped `>=60000` else fallback + `Logger.warn`, fail-open `try { get/set } catch(e){ Logger.warn; return true }`, outermost `@UseGuards(RateLimitGuard)` before `JwtGuard`
- [ ] T029 [US4] Harden `AuthService` logging to prefix-only in `src/modules/auth/auth.service.ts` — all `Logger.log/warn` use `tokenHash.slice(0,6)` never `rawRefresh`; ensure `AllExceptionsFilter` path for `429` forwards `options.headers Retry-After/X-RateLimit-*` already (Phase 10), verify `POST /auth/refresh/logout` Swagger `429`

**Checkpoint**: US4 fully functional — dual `10+5/h` buckets before `FOR UPDATE`, `429` headers, fail-open `200`, prefix-only logs, zero `stock` mutation

---

## Phase 7: Polish & Cross-Cutting Concerns

**Purpose**: Purge job, docs, final validation

- [ ] T030 [P] Add nightly purge job for `RefreshToken` `7d` in `src/modules/auth/auth.service.ts` or `src/modules/auth/refresh-cleanup.service.ts` — `DELETE FROM refresh_token WHERE (revokedAt IS NOT NULL AND revokedAt < NOW() - INTERVAL '7 days') OR (revokedAt IS NULL AND expiresAt < NOW() - INTERVAL '7 days')` (cron 02:00 or BullMQ `refresh-purge` repeat, ConfigService `REFRESH_PURGE_CRON`), log `purged n`
- [ ] T031 [P] Update Swagger for all 5 auth refresh routes (`login` extended + `refresh` + `logout` + `logout-all` + `google callback`) with `@ApiOperation` `Refresh via Cookie or Body`, `@ApiResponse 200 {accessToken,refreshToken}` `401/400/429`, and `Set-Cookie`/`X-Email-Unverified` headers in `src/modules/auth/auth.controller.ts`
- [ ] T032 Run `npm run build` must PASS with `synchronize:false` and no `client.emit` inside `dataSource.transaction` (`grep -c "client.emit" src/modules/auth/auth.service.ts 0`, `grep -c "FOR UPDATE" src/modules/auth/auth.service.ts >=1`)
- [ ] T033 Run `npm run test -- --runInBand` must PASS including new `auth.service.spec.ts` (T010,T011,T016,T017,T022,T026) with mocked `DataSource`/`CACHE_MANAGER`
- [ ] T034 Run `npm run test -- src/modules/auth/test/refresh.integration.spec.ts --runInBand` must PASS with real PG `FOR UPDATE` + real Redis `FLUSHDB` (T018,T019,T023,T027) — concurrent `refresh` single-winner, cap 5 LRU, `7d` purge, `429`, `X-Email-Unverified`
- [ ] T035 Run E2E `npm run test:e2e -- --runInBand` must PASS for `test/app.e2e-spec.ts` flow `register→login→GET /order 200→POST /auth/refresh 200→reuse old 401 theft→POST /auth/logout 200→POST /auth/logout-all 200 tokenVersion 1→GET /order 401→login new 200`
- [ ] T036 [P] Update `docs/architecture/auth-refresh.md` + `docs/decisions/ADR-refresh-token.md` (opaque sha256 + FOR UPDATE theft revoke-all + cap 5 + dual rate-limit + 7d purge + X-Email-Unverified) and run `quickstart.md` validation (`psql SELECT tokenHash,expiresAt,revokedAt FROM refresh_token` `active<=5`, `FLUSHDB` `429`, `Set-Cookie` HttpOnly)

---

## Dependencies & Execution Order

### Phase Dependencies

- **Setup (Phase 1)**: No dependencies — can start immediately
- **Foundational (Phase 2)**: Depends on Setup — **BLOCKS** all user stories (T004 entity+migration must exist before any `repo.save`)
- **User Stories (Phase 3+)**: All depend on Foundational
  - **US2 Login (P1)** must complete before **US1 Refresh (P1)** can be manually tested (refresh needs `raw` from login) — but code can be implemented in parallel after Foundational
  - US3 Logout (P2) can start after Foundational, but E2E needs US1+US2 login/refresh
  - US4 Rate-limit (P2) can start after Foundational; guard dual buckets should be added before US1 E2E 429 proof but can be parallelized
- **Polish (Phase 7)**: Depends on all desired stories (US1+US2 required for MVP, US3+US4 for full SC-008); purge job (T030) can be parallel to docs

### User Story Dependencies

- **US2 Login (P1)**: No story dependency after Foundational; delivers `{accessToken,refreshToken}+Set-Cookie` for US1
- **US1 Refresh (P1)**: Logically depends on US2 for manual test data; independently testable via unit-mocked login + seeded `RefreshToken` row
- **US3 Logout (P2)**: Depends on US1+US2 for `r1,r2` fixtures but independently testable via direct `repo.save` fixtures
- **US4 Rate-limit (P2)**: No story dependency; cross-cutting guard applied to US1/US3 routes

### Within Each User Story

- Tests (if included) MUST be written and FAIL before implementation (T010 before T012, T016 before T020, T022 before T024, T026 before T028)
- DTO/Entity before Service before Controller (T006 before T012, T004 before T012/T020)
- Core implementation before edge cases (cap 5 before `X-Email-Unverified`, dual buckets before `429` headers)

### Parallel Opportunities

- Phase 1 `T002` + `T003` parallel (different files)
- Phase 2 `T006` parallel to `T007`/`T008` (DTO vs main.ts vs parseTtlMs)
- Once Foundational completes, `T010`+`T011` (US2 tests) parallel to `T016`+`T017` (US1 tests) + `T022` (US3) + `T026` (US4 guard unit) — different spec files
- Within US1 `T016`+`T017`+`T018` parallel (mock unit vs integration)
- `T030` purge job + `T031` Swagger docs parallel in Polish

---

## Parallel Example: User Story 1 (Refresh)

```bash
# After Foundational, launch US1 tests together:
Task T016: "Unit test refresh rotation FOR UPDATE single-winner in src/modules/auth/auth.service.spec.ts"
Task T017: "Unit test refresh expired/revoked/unknown 401 + cookie fallback in src/modules/auth/auth.service.spec.ts" # same file sequential, not parallel in practice
Task T018: "Integration test refresh rotation + theft concurrent real PG in src/modules/auth/test/refresh.integration.spec.ts"

# Launch US2 login implementation in parallel with US1 service:
Task T012: "Implement AuthService.login extension in src/modules/auth/auth.service.ts" # different method than T020 but same file — sequential in practice
Task T020: "Implement AuthService.refresh in src/modules/auth/auth.service.ts"
```

> Note: `[P]` tasks are parallelizable only when they touch different files; `auth.service.spec.ts` + `auth.service.ts` tasks sharing same file should be sequential despite `[P]` flag — guard unit `rate-limit.guard.spec.ts` is parallel to `auth.service.spec.ts`.

---

## Implementation Strategy

### MVP First (User Stories 2+1 Only)

1. Complete Phase 1: Setup (`cookie-parser` skeleton + DTO placeholders)
2. Complete Phase 2: Foundational (`RefreshToken` entity+migration+DTO+main.ts+parseTtlMs — **BLOCKS** all stories)
3. Complete Phase 3: US2 Login (`POST /auth/login` + `GET /auth/google/callback` issue refresh + Set-Cookie + cap5) — **STOP and VALIDATE** `POST /auth/login 200 {accessToken,refreshToken} 64hex` `psql SELECT count(*) active 1`
4. Complete Phase 4: US1 Refresh (`POST /auth/refresh` FOR UPDATE rotation + theft + cookie fallback + X-Email-Unverified) — **STOP and VALIDATE** `login→refresh 200→reuse old 401 + theft revoke-all + concurrent 200+401` via `npm run test -- --runInBand` + manual curl
5. Deploy/demo MVP (SC-001+002+003+004+007 partially) if ready — login+refresh suffices for `register→login→refresh→cart→checkout` without 401 flakes

### Incremental Delivery

1. Setup + Foundational → Foundation ready (migration applied, `synchronize:false`)
2. Add US2 Login → Test `200 {accessToken,refreshToken} + Set-Cookie` → Demo
3. Add US1 Refresh → Test rotation+theft concurrent → Demo MVP!
4. Add US3 Logout (`logout` idempotent + `logout-all tokenVersion++`) → Test `logout 200→logout-all 200 active 0` → Demo session hygiene
5. Add US4 Rate-limit dual `10+5/h` before `FOR UPDATE` + fail-open → Test `11th 429` `FLUSHDB` → Demo full SC-008 no-regression
6. Polish: purge `7d` cron + docs/ADR + `npm run build/test:e2e`

### Parallel Team Strategy

With multiple developers after `Foundational` (Phase 2) done:

- **Developer A**: US2 Login (T010-T015) + US1 Refresh (T016-T021) — sequential same files `auth.service.ts`/`auth.controller.ts`
- **Developer B**: US3 Logout (T022-T025) — `logout/logoutAll` methods, can parallel to A after `auth.service.ts` merge
- **Developer C**: US4 Rate-limit (T026-T029) — `rate-limit.guard.ts` independent file, fully parallel to A/B

Once US1+US2 done, all merge to `Polish` `T030-T036` together.

---

## Notes

- `[P]` tasks = different files, no dependencies — but same-file tasks (`auth.service.spec.ts` multiple T0xx) should be batched sequentially
- `[Story]` label maps task to specific user story for traceability (US1 refresh, US2 login, US3 logout, US4 rate-limit)
- Each user story independently completable: US2 via `POST /auth/login 200`, US1 via seeded `RefreshToken` row `FOR UPDATE`, US3 via direct `repo.save` fixtures, US4 via `RateLimitGuard` mock `CACHE_MANAGER`
- Verify tests FAIL before implementing (e.g., `T010` login creates refresh must fail until T012 done)
- Commit after each task or logical group (`git add -p` per T0xx)
- Stop at any checkpoint to validate story independently (`Checkpoint` sections)
- Avoid: vague tasks, same file conflicts without ordering, cross-story dependencies that break independence
