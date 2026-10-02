# Tasks: Auth + Users Refactor (RP-AUTH)

**Input**: Design documents from `/specs/015-auth-user-refactor/` (plan.md, spec.md, research.md D1–D8, data-model.md, contracts/auth-user-parity.md, quickstart.md)
**Prerequisites**: plan.md, spec.md, research.md, data-model.md, contracts/

**Tests**: YES — explicitly required (spec FR-012/FR-014, SC-002/SC-003). Baseline tests are written FIRST and must be GREEN before any structural change (this is a refactor: green-then-preserve, not red-then-green).

**Organization**: Tasks grouped by user story. Each story phase is an independently verifiable increment against the baseline.

**How to read a task (for cheap models)**: the `- [ ]` line is the task. Indented bullets are the exact execution recipe: files + function names + line refs → steps → done-means (commands + expected output). Refs like `(research D1)` point at `specs/015-auth-user-refactor/research.md` sections; `(parity)` = `contracts/auth-user-parity.md`.

## Format: `[ID] [P?] [Story] Description`

- **[P]**: parallelizable (different files, no dependency on incomplete tasks)
- **[Story]**: user story label ([US1]–[US4], maps to spec.md stories)

## Phase 1: Setup (Shared Infrastructure)

**Purpose**: Clean starting point + proven-green baseline environment. No production code changes in this phase.

- [ ] T001 Create feature branch and verify clean tree
  - Files: none (git only).
  - Steps: `git status` (must be clean; stash/commit anything pending) → `git checkout -b 015-auth-user-refactor` → `git status`.
  - Done when: on branch `015-auth-user-refactor`, working tree clean.
  - Ref: plan.md header (`**Branch**: 015-auth-user-refactor`).

- [ ] T002 Verify infrastructure and record green pre-change gates (auth+users scope)
  - Files: none (commands only).
  - Steps: `docker-compose up -d` → confirm postgres 5432 / redis 6379 / rabbitmq 5672 reachable → `cp .env.example .env` if `.env` missing (never commit `.env`) → run `npm run lint`, `npm run build`, `npm run test -- --runInBand src/modules/auth src/modules/users` → record the pass counts in a scratch note (you will compare against these numbers in every later phase).
  - Done when: all three gates green; counts recorded.
  - Ref: quickstart.md §0–§1.

## Phase 2: Foundational — full baseline commit (BLOCKING)

**Purpose**: The behavioral safety net. Captures every observable contract BEFORE any structural change (clarified Q5: full baseline first). No user-story work starts until this phase is committed.

**⚠️ CRITICAL**: No production-code change until T008 is committed. T003–T007 are test-only.

- [ ] T003 [P] Baseline contract-matrix test in `src/modules/auth/test/baseline-parity.integration.spec.ts` (new file, real PG + real Redis when available)
  - What: one test per row of `(parity)` — all 15 routes (register, login, refresh body+cookie, logout body+cookie, logout-all, forgot, validate, reset, verify GET+POST, resend, otp/request, otp/verify, google/callback mocked, google/link, PATCH /users/me/preferences).
  - For EACH route assert: exact status code + exact response-body keys (values except fresh tokens/UUIDs) + exact cookies (`refresh_token` attrs) + exact headers (`X-Email-Unverified`, `Retry-After`/`X-RateLimit-*` on 429 paths) per `(parity)`.
  - Also assert: resend/forgot anti-enum (unknown email → same 200 body as known email); refresh reuse → 401 + all sessions dead; double logout → 200; expired/used token → 400; OTP routes → 501.
  - Done when: file exists, full matrix green on UNMODIFIED code.
  - Ref: spec US1 acceptance 1–6; `(parity)` table; research D8.

- [ ] T004 [P] Dual-JWT-path 401 matrix test in `src/modules/auth/test/jwt-paths.integration.spec.ts` (new file)
  - What: pin CURRENT divergent behavior before S-1 unification (research D1).
  - Steps: create user → login (grab access token) → `tokenVersion++` (via `UsersService.incrementTokenVersion`) → call a `@Auth()` route (expect 200 TODAY under `JwtGuard`, proving the bypass) → call a `JwtAuthGuard`-only route (expect 401 TODAY, proving the strategy enforces) → record `request.user` shape per path (payload `{sub,email,role,tokenVersion}` vs entity `{id,...}`).
  - Done when: test documents both outcomes with comments `// S-1 PRE-STATE: JwtGuard allows revoked; JwtStrategy denies` and is green.
  - Ref: research D1; spec FR-014(a).

- [ ] T005 [P] Register-leak proof test in `src/modules/auth/test/register-leak.integration.spec.ts` (new file)
  - What: prove the D3 pre-state (research D3): `POST /auth/register` 201 body `data.password` EXISTS and equals a bcrypt hash (`$2b$...`) on unmodified code.
  - Write the assertion as `expect(data.password).toBeDefined()` with comment `// D3 PRE-STATE: leaks hash — T015 flips this to absent`.
  - Done when: green on unmodified code (it MUST fail after T015 — that failure-then-fix is the S-delta proof).
  - Ref: research D3; `auth.service.ts:67-94`.

- [ ] T006 [P] Single-winner race suites in `src/modules/auth/test/token-races.integration.spec.ts` (new file, real PG, `--runInBand`)
  - What: `Promise.all` concurrency proofs per spec SC-002.
  - Cases: (a) same refresh token ×2 → exactly one 200 + one 401-theft-nuke, loser triggers bulk revoke (query `refresh_token` rows to prove); (b) same reset token ×2 `resetPassword` → one 200 + one 400, password = winner's value; (c) same verify token ×2 → one 200 + one 400, `emailVerified=true` once; (d) `logoutAll` during active refresh → refresh 401 after; (e) resend ×2 within 60s → one 200 + one 429 with `Retry-After`.
  - Done when: all green on unmodified code, stable across 3 runs (flakiness = missing lock, stop and report).
  - Ref: spec SC-002, FR-005/FR-012; research D8.

- [ ] T007 Create PowerShell API flow script in `scripts/e2e-auth-users.ps1` (new file)
  - What: live-API flow test per `contracts/auth-user-parity.md`, Windows PowerShell 5.1 compatible (no PS7-only flags): unique email per run (`e2e-<epoch>@test.com`); steps = register 201 (+ record `data.password` presence) → duplicate 400 → login 200 (pair + `refresh_token` cookie) → wrong-pass 401 → `GET /users/me` 200 → `PATCH /users/me/preferences` flip/flip-back 200 → refresh rotate 200 → old-token reuse 401 → forgot known+unknown 200-identical → validate garbage 400 → verify garbage 400 → resend 200 then 429 cooldown → OTP 501 → logout 200 twice → re-login → logout-all 200 → refresh-after-nuke 401 → access-after-nuke RECORDED → `X-RateLimit-Limit` header on success.
  - Switches: `-EnforceRevocation` (S-1: access-after-nuke MUST be 401; default off = record-only for baseline) and `-StripPasswordHash` (D3: register data MUST lack password/hash keys; default off = record-only). Non-zero exit on first mismatch; step summary printed.
  - Done when: `powershell -ExecutionPolicy Bypass -File scripts/e2e-auth-users.ps1` passes fully on UNMODIFIED code (baseline mode, app running via `npm run start:dev` with infra up); script committed in this phase.
  - Ref: `(parity)` rows; quickstart.md §1; research D8.

- [ ] T008 Commit the baseline (test-only, zero production-code delta)
  - Steps: `git status` (only `src/modules/auth/test/*` + `src/modules/users/**test*` new files + `scripts/e2e-auth-users.ps1`) → `git diff --stat` (no `auth.service.ts`/`auth.controller.ts`/`users.service.ts`/guards/strategies changes) → run T002 gates once more → commit `test(auth): full pre-split baseline (contract matrix, JWT paths, leak proof, races, PS API flow)`.
  - Done when: baseline commit hash recorded; every later phase diffs against it (`git diff <baseline> -- <files>` shows only intended slices + 3 S rows).
  - Ref: quickstart.md §1; research D8.

- [ ] T009 [P] Vendor CC-A pure ports in `src/common/` (only if absent — check first): `token-hasher.ts` (`sha256Hex`), `secure-token.ts` (`generateHex(32)`), `clock.ts` (`now()`, `plusMs()`), `parse-duration.ts` (`parseDurationMs`, single semantic)
  - Steps: `ls src/common/` — if these already exist with compatible signatures, SKIP (record reuse, do not duplicate). Else create the 4 tiny units + `src/common/ports.spec.ts` unit matrix proving byte-identical outputs vs current inline code (same input → same sha256 hex, same `7d/15m/24h/60s/5m` → same ms as the three current parsers in `auth.service.ts:666,1221` + controller cookie math).
  - Constraints: ports own NO business logic; deterministic fakes exported for tests; no other behavior.
  - Done when: unit matrix green; zero call-site changes yet (wiring happens in US4).
  - Ref: research D7; plan.md structure; CC-A-compatible signatures required.

- [ ] T010 [P] Full typed `AuthTokenConfig` parsed once at startup in `src/modules/auth/auth-token.config.ts` (new file)
  - Keys (from research D7): `JWT_SECRET`, `JWT_EXPIRES_IN`, `REFRESH_TOKEN_TTL`, `REFRESH_TOKEN_COOKIE_NAME`, `REFRESH_TOKEN_COOKIE_SECURE`, `RESET_TOKEN_TTL`, `EMAIL_VERIFICATION_TTL`, `OTP_TTL`, `OTP_MAX_ATTEMPTS`, `OTP_RESEND_COOLDOWN`, `GOOGLE_CLIENT_ID/SECRET/CALLBACK_URL`, `FRONTEND_URL`.
  - Steps: validate-and-clamp once at startup (same defaults as today's `??` fallbacks: `7d/15m/24h/5m`, cookie `refresh_token`, `Secure=false` unless `'true'`); warn-once (Logger) on every fallback; NO new hard-fail. Add `auth-token.config.spec.ts` asserting each default equals the current inline fallback + warn-once fires once.
  - Done when: spec green; service/controller NOT yet rewired (rewire happens in US4 T029–T030).
  - Ref: clarified Q4; research D7; FR-011.

**Checkpoint**: Foundation ready — baseline commit hash recorded; PS API flow green on baseline; ports + typed config unit-proven; user-story work may now begin. Recommended order: US1 → US2 → US3 → US4 (each diffed against the baseline).

---

## Phase 3: User Story 1 — Identical sign-in/session behavior + approved S-deltas (Priority: P1) 🎯 MVP

**Goal**: Enact exactly the three approved S-deltas (S-1, S-2, D3) with regression tests; everything else in US1's flows stays byte-identical.

**Independent Test**: Baseline matrix (T003) green with ONLY these intended diffs: revoked-token 401s where S-1 closes the hole, validate/reset concurrency semantics per S-2, `register.data` minus the `password` key per D3. All other rows byte-identical.

- [ ] T011 [US1] S-1 tests-first: revoked-user denial expectations in `src/modules/auth/test/jwt-unified.integration.spec.ts` (new file)
  - What: for EVERY `@Auth()` route used by auth/users (plus one cross-module smoke route, e.g. `GET /cart`, read-only): login → capture token → `incrementTokenVersion` → call route → expect 401 with `{statusCode:401}` body.
  - Write these FIRST; they FAIL on unmodified code for `JwtGuard`-only routes (that's the proof of the hole). Do not implement T012 until they fail as expected.
  - Ref: research D1; `(parity)` guard section; spec FR-014(a).

- [ ] T012 [US1] Unify `JwtGuard` as sole JWT path in `src/modules/auth/guards/jwt.guard.ts` (S-1 enactment)
  - Steps: (1) keep Bearer extraction + `verifyAsync` untouched; (2) after verify, load user via `UsersService.findUserById(payload.sub)` (fallback `findUserByEmail(payload.email)` mirroring strategy lines 21-26); (3) enforce `tokenVersion` mismatch → `UnauthorizedException('Token revoked, please login again')` + `passwordChangedAt`/`iat` fallback → `UnauthorizedException('Token revoked after password change')` (copy the exact messages from `strateges/jwt.strategy.ts:27-43`); user-not-found → `UnauthorizedException('User not found')`; (4) keep assigning the PAYLOAD (not the entity) to `request.user` — shape frozen.
  - Do NOT touch: `RolesGuard`, `CurrentUser`, `@Auth()` decorator, `JwtStrategy` file, `JwtAuthGuard` wiring (retained per research D1).
  - Done when: T011 turns green; T003 matrix shows ONLY the new 401s as diff; `npm run build` green.
  - Ref: research D1; `guards/jwt.guard.ts:11-38`.

- [ ] T013 [US1] S-1 companion: `sub`-for-`id` in `src/modules/auth/auth.controller.ts` (`logoutAll`, `googleLink`)
  - Steps: `logoutAll` line ~306: `(user as any).id` → `(user as any).sub ?? (user as any).id`; same in `googleLink` line ~346. Rationale comment: unified guard provides payload shape (research D1).
  - Verify: `logoutAll` revokes (old access 401 + old refresh 401); `googleLink` links (mocked profile) — extend T011 file or add cases to `baseline-parity` copy; pre/post wire diff = these two lines + guard file only.
  - Done when: logout-all + link flows green; no other controller lines touched in this task.
  - Ref: research D1 (`auth.controller.ts:296-351`).

- [ ] T014 [US1] S-2 tests-first then enact in `src/modules/auth/auth.service.ts` (`validateResetToken` ~:553, `resetPassword` ~:570)
  - Tests first (add to `token-races.integration.spec.ts`): concurrent validate-during-reset — validate may return valid, but double-`resetPassword` with same token → exactly one 200 + one 400; assert second 400 even when validate said valid milliseconds earlier (proves reset is the authority).
  - Enact: `resetPassword` revalidates hash-match + `expiresAt > now` + `usedAt IS NULL` INSIDE its transaction while holding `FOR UPDATE`, then sets `usedAt`, bcrypt-hashes, `tokenVersion++` atomically. `validateResetToken` stays plain `findOne` (add comment `// advisory pre-check; resetPassword is authoritative (S-2)`).
  - Done when: race test green; T003 reset/validate rows unchanged except documented authority semantics.
  - Ref: research D2; spec FR-014(b); data-model.md reset-token row.

- [ ] T015 [US1] D3 enactment: strip `password` from register response in `src/modules/auth/auth.service.ts:67-94`
  - Steps: after `createNewUser`, `const { password, ...safeUser } = newUser; return { message: 'User created successfuly.', data: safeUser };` (keep the exact message strings, typos included — R).
  - Flip T005's assertion to `expect(data.password).toBeUndefined()` + add `expect(JSON.stringify(body)).not.toContain('$2b$')`; keep the test file, update comments to `// D3 POST-STATE`.
  - Done when: T005 green in flipped form; T003 register row shows ONLY the missing key as diff.
  - Ref: research D3; spec FR-014(c).

- [ ] T016 [US1] Parity re-verification + gates for the US1 slice (`src/modules/auth/`, `src/modules/users/`, git diff vs baseline)
  - Steps: run T003+T004-baseline-copy+T006 full suites → `git diff <baseline-hash> --stat` (expect: guard + 2 controller lines + reset/validate + register return + tests only) → `npm run lint`, `npm run build`.
  - Done when: gates green; diff review confirms zero unintended wire changes.
  - Ref: quickstart.md §2–§4.

- [ ] T017 [US1] Run PowerShell API flow in S-delta mode against US1 state (`scripts/e2e-auth-users.ps1`)
  - Steps: start app (`npm run start:dev`, infra up) → `powershell -ExecutionPolicy Bypass -File scripts/e2e-auth-users.ps1 -EnforceRevocation -StripPasswordHash` → must exit 0 with all steps PASS.
  - Proves over the wire: revoked access denied (S-1), register body has no password key (D3), plus full flow parity (rotation/theft, anti-enum, cooldown 429, OTP 501, prefs, headers).
  - Done when: script summary shows `failed=0`; attach the log to the US1 validation note. Any FAIL besides the 3 S-rows = defect, stop.
  - Ref: `(parity)`; T007 script.

**Checkpoint**: US1 complete — S-deltas enacted + proven; all other behavior identical. MVP could stop here (security holes closed, zero structural churn yet).

---

## Phase 4: User Story 2 — Single ownership of user data (Priority: P1)

**Goal**: ALL user-row writes go through `UsersService`; zero `manager.getRepository(User)` in auth.

**Independent Test**: `grep -rn "getRepository(User)" src/modules/auth/` → zero hits; T003 matrix fully green (no wire diff vs US1 state).

- [ ] T018 [US2] Extend `UsersService` write API in `src/modules/users/users.service.ts` (keep names/signatures; research D5)
  - Steps: add OPTIONAL tx-scoped overloads/params only where auth flows need them: allow passing an `EntityManager` into `createNewUser`, `updatePassword`, Google-link setter, `emailVerified` setter (new small methods `linkGoogleAccount(userId, googleId)`, `markEmailVerified(userId)` reusing the `updatePreferences`-style `FOR UPDATE` pattern lines 111-135). Keep `updatePassword` EXACT current semantics including the dead-param quirk (research D5 — add `// preserves pre-refactor semantics; explicit tokenVersion param intentionally ignored (quirk, follow-up candidate)`).
  - Add/extend `src/modules/users/test/users.service.spec.ts` for each new/changed method (mocked repos).
  - Done when: users unit tests green; no caller wired yet (wiring is T017).
  - Ref: research D4–D5; data-model.md ownership map (`user` row).

- [ ] T019 [US2] Replace the 3 bypass sites in `src/modules/auth/auth.service.ts` (`:264`, `:432`, `:599` — find exact lines via `grep -n "manager.getRepository(User)"`)
  - Steps: per site, replace direct user read/write with the matching `UsersService` method, passing the ambient `manager` where the enclosing flow is transactional. Preserve lock mode (`FOR UPDATE` where the current code locks) and error type/message exactly.
  - Done when: grep proves zero; T003 matrix green with ZERO diff vs US1 state; `npm run build` green.
  - Ref: spec FR-002; plan invariant TI-1.

- [ ] T020 [US2] Boundary audit + gates for the US2 slice (`src/modules/auth/`, `src/modules/users/`, quickstart.md §3 greps)
  - Steps: run quickstart.md §3 greps (`getRepository(User)` in auth → 0; controller persistence → 0) → `npm run lint`, `npm run build`, `npm run test -- --runInBand src/modules/auth src/modules/users`.
  - Done when: all green; diff vs baseline = US1 files + users.service.ts + auth.service bypass replacements only.
  - Ref: spec SC-004 (first clause); quickstart.md §3.

- [ ] T021 [US2] Re-run PowerShell API flow in S-delta mode (`scripts/e2e-auth-users.ps1`)
  - Steps: same command as T017 (`-EnforceRevocation -StripPasswordHash`).
  - Done when: exit 0, `failed=0`, log attached. Ownership changes must be wire-invisible — any new FAIL = defect, stop.
  - Ref: T007 script; T017 log (diff the two summaries: identical).

**Checkpoint**: US1 + US2 complete — secure + single-owned user writes, still no structural store split.

---

## Phase 5: User Story 3 — Explicit transaction and failure boundaries (Priority: P2)

**Goal**: Intent-based stores own persistence; `AuthService` owns tx boundaries; `AuthEventPublisher` owns post-commit emit; controllers tx-free. Failures outside the tx never roll back committed state.

**Independent Test**: Fault-injection (event publish throws; cache throws) → committed token/user state intact + user-visible success unchanged; crash-between-rotate-steps → full rollback (prove via reordered mock or review + race suites green).

- [ ] T022 [US3] `RefreshTokenStore` in `src/modules/auth/stores/refresh-token.store.ts` (new) + rewire rotation
  - Methods: `acquire(manager, userId, tokenHash, expiresAt)` / `rotate(manager, oldHash, newHash, newExpiry)` (invalidates old + cap-5 evict-oldest + inserts new, ONE tx participant) / `revokeOne(manager, hash)` (idempotent) / `revokeAllForUser(manager, userId)` + `purgeExpired(manager, cutoff)`.
  - Move logic from `auth.service.ts:156-183` (create+cap5) and `:225-400` (refresh+theft-nuke) + `:401-457` (logout/logout-all) verbatim-semantics: same queries, same `FOR UPDATE`, same eviction pick (oldest `createdAt`), same 401 messages, same warn(prefix6) + `INCR` counter keys.
  - Store takes tx-scoped `EntityManager`, never `dataSource.transaction` inside (TX-1). Unit-test with mocked manager.
  - Done when: store unit tests green; service delegates (no logic duplicated); T003 refresh/logout rows + T006(a)(d) green.
  - Ref: research D4; data-model.md refresh-session row + transition diagram.

- [ ] T023 [P] [US3] `PasswordResetTokenStore` + `VerificationTokenStore` in `src/modules/auth/stores/` (new files)
  - Reset store: `issue(manager, userId, hash, expiresAt)` (invalidates priors) / `consume(manager, userId, hash)` (revalidates under `FOR UPDATE`, sets `usedAt`, returns userId) — from `auth.service.ts:495-551,570-665`. Validate stays a thin read in the service (S-2).
  - Verification store: `issue` (24h, invalidate priors) / `consume` (sets `usedAt`, returns userId; service then sets flag via `UsersService.markEmailVerified`) / `isCooldownActive(email)` + `markCooldown(email)` (60s `SET NX`, fail-open) — from `:685-920`.
  - Same TX-1 rule; same TTLs/messages/anti-enum behavior.
  - Done when: unit tests green; T003 forgot/validate/reset/verify/resend rows + T006(b)(c)(e) green.
  - Ref: research D4; data-model.md token rows.

- [ ] T024 [P] [US3] `OtpStore` in `src/modules/auth/stores/otp.store.ts` (new) — 501 paths rewired, behavior frozen
  - Move Redis TTL/hash/attempts/cooldown + PG audit logic from `auth.service.ts:921-1167` (`requestWhatsAppOtp`, `verifyWhatsAppOtp`, `handleOtpSuccess`, `findUserByPhone`, `incrementOtpAttempts`, `markOtpVerified`, `timingSafeEqual`) with identical keys/TTLs/attempt-cap/fallback semantics (ADR-0011 Q4).
  - Keep controller 501 guards untouched; OTP endpoints still 501.
  - Done when: OTP unit tests (mocked cache) green; T003 OTP rows still 501; no other flow touched.
  - Ref: research D4; data-model.md otp row.

- [ ] T025 [US3] `AuthEventPublisher` in `src/modules/auth/auth-event.publisher.ts` (new) — broker out of domain
  - Move `emitAuthEvent` (`auth.service.ts:630-657`, `ClientProxy` + try/catch-warn) verbatim-semantics; service calls it ONLY after commit (register `:701-775`, reset `:544`, verify `:762,819,907`). Same event names + payload keys + queue.
  - Signature frozen for CC-C `EventBusPort` adoption (note in file JSDoc). Remove `ClientProxy`/`NOTIFICATION_SERVICE` injection from `AuthService` (keep in publisher).
  - Done when: publish-failure fault test → committed state stands + warn logged (add to race spec file or new `publisher-fault.integration.spec.ts`); T003 event-observing rows green.
  - Ref: research D4; TI-4; spec FR-008.

- [ ] T026 [US3] Thin the orchestrator: rewrite `src/modules/auth/auth.service.ts` to delegate (no logic duplication)
  - Per method (register/login/refresh/logout/logout-all/purge×2/reset/verify/resend/OTP/Google): service opens/owns the ONE tx boundary (`dataSource.transaction`), calls stores + `UsersService` + publisher in the same order as today, maps store results to the SAME return shapes. No `ClientProxy`, no `CACHE_MANAGER`, no `crypto`/`Date` left here (those move in US4 — leave the imports until then, just stop adding new uses).
  - Done when: T003 FULL matrix green with zero diff vs US2 state; T006 races green; file has class+method JSDoc per AGENTS.md §3 (draft; final audit is T031).
  - Ref: research D4; spec FR-003/FR-008; plan TX-1/TX-2.

- [ ] T027 [US3] Controller tx-free verification for `src/modules/auth/auth.controller.ts` (+ `src/modules/users/users.controller.ts` check)
  - Steps: prove (already true, now enforced by review + test): no `DataSource`/`EntityManager`/repository in controllers. If ANY found, move to service. Add a CI-guard unit test? Cheap approach: extend quickstart §3 greps into a documented manual gate in this task (no new framework).
  - Done when: greps zero; `npm run lint`, `npm run build` green.
  - Ref: spec FR-004/SC-004; TI-1.

- [ ] T028 [US3] Re-run PowerShell API flow in S-delta mode (`scripts/e2e-auth-users.ps1`)
  - Steps: same command as T017 (`-EnforceRevocation -StripPasswordHash`).
  - Done when: exit 0, `failed=0`, log attached. The whole store split must be wire-invisible — any FAIL = defect, stop. Keep all three run logs (T017/T021/T028) for the final diff review.
  - Ref: T007 script.

**Checkpoint**: US1–US3 complete — secure, single-owned, explicitly bounded transactions with post-commit side effects.

---

## Phase 6: User Story 4 — Clean seams, no hidden behavior change (Priority: P3)

**Goal**: Inline duplication replaced by named units with identical outputs; HTTP fully owned by controllers; path hygiene.

**Independent Test**: Per-helper identical-output matrices + unchanged controller suites; reviewer finds ≥3 call sites cited per abstraction and zero generic framework types.

- [ ] T029 [US4] Rewire crypto/clock/TTL call sites to T009 ports + `AuthTokenConfig`
  - Files: `auth.service.ts` (sha256 ×14 → `TokenHasher`, `randomBytes` ×7 → `SecureToken`, `new Date/Date.now` ~30× → `Clock`, TTL reads → injected `AuthTokenConfig` + `parseDurationMs`); `auth.controller.ts` (cookie TTL math + `resolveRefreshRaw`/`getRefreshCookieName` → config + shared helper; keep triple-extraction body→cookie→header behavior identical).
  - Add `ports-parity.spec.ts`: same-input→same-output matrix for hasher/token/TTL/clock-frozen-expiry.
  - Done when: matrices green; `grep -n "crypto\|Date.now\|new Date()" src/modules/auth/auth.service.ts` → only inside ports; T003 matrix zero-diff.
  - Ref: research D7; clarified Q4; spec FR-010.

- [ ] T030 [US4] Move in-service 429 to controller in `auth.service.ts:830-855` + `auth.controller.ts:199-212` (resend cooldown)
  - Steps: service throws `VerificationCooldownError(retryAfterMs)` (new tiny class in `auth.service.ts` or `errors.ts` — do NOT add a shared framework error hierarchy); controller catches → identical 429 status + body + `Retry-After` header (prove byte-identical via T003 resend-429 row pre/post). Repeat the pattern for ANY other in-service HTTP construction found (`grep -n "HttpException" src/modules/auth/auth.service.ts`).
  - Done when: T003 resend rows zero-diff; service file has zero `HttpException` imports left (prove via grep).
  - Ref: research D7; spec FR-007.

- [ ] T031 [P] [US4] Logger hygiene + `LocalAuthGuard` proof-gated simplification
  - Logger: replace `console.log` (`auth.controller.ts:124,126`) with injected `Logger`; keep message content.
  - `LocalAuthGuard:15-27`: temporarily REMOVE the manual `plainToInstance+validate` block on a scratch branch → run T003 login-400 rows → if byte-identical (global pipe covers), keep removal; if ANY shape differs, RESTORE and record keep-decision. Proof-gated, never assumed.
  - Done when: logger done + guard decision recorded with test evidence either way.
  - Ref: research D6; AGENTS.md logging rule.

- [ ] T032 [P] [US4] `strateges/` → `strategies/` path-hygiene move
  - Steps: move `strateges/*.strategy.ts` → `strategies/`; update imports (`auth.module.ts:8-10`, `local.strategy` self-import, any spec imports); delete `strateges/`; run `npm run build` + FULL auth/users test suites.
  - Done when: build + suites green; `git status` shows pure renames + import-line edits (reachability evidence = compiler + DI resolution, DC-1).
  - Ref: research D6; spec edge-case bullet.

- [ ] T033 [US4] Rule-of-Three review pass over all new units
  - Steps: for each new abstraction (stores, publisher, ports, cooldown error, config) append its ≥3 call sites (or single crisp responsibility for stores) to its file JSDoc `@responsibility` note; DELETE or inline anything that fails the gate (builder-style single-use wrappers, generic helpers).
  - Done when: review recorded; `grep -rn "Base\|Generic\|StateMachine" src/modules/auth/ src/modules/users/` → zero new framework types.
  - Ref: plan MF-1; spec FR-010/SC-005.

- [ ] T034 [US4] Re-run PowerShell API flow in S-delta mode (`scripts/e2e-auth-users.ps1`)
  - Steps: same command as T017 (`-EnforceRevocation -StripPasswordHash`).
  - Done when: exit 0, `failed=0`, log attached. Final wire proof before polish — any FAIL = defect, stop.
  - Ref: T007 script.

**Checkpoint**: All four stories complete — secure, owned, bounded, clean, with proofs.

---

## Phase 7: Polish & Cross-Cutting Concerns

**Purpose**: Docs, doc-comments, full gates, final diff review. No behavior change in this phase.

- [ ] T035 JSDoc + intent-comment audit on every touched class/method (`auth.service.ts`, all stores, publisher, config, `jwt.guard.ts`, controller, `users.service.ts`)
  - Class-level `/** This service/store/controller is responsible for ... */`; public methods with `@param/@returns/@throws`; `//` intent comments on multi-predicate guards, TTL/expiry math, lock ordering, cap-5 eviction pick, anti-enum branches. Update stale comments (esp. S-1/S-2/D3 sites).
  - Done when: manual audit complete; `npm run lint` green (treats missing docs as failure per AGENTS.md §3).
  - Ref: AGENTS.md §3; spec FR-013.

- [ ] T036 [P] Record decisions: ADR entry in `docs/decisions/` (`0012-auth-users-refactor.md`: S-1/S-2/D3 + store split + frozen guard/factory) + touch-up `docs/architecture/modules.md` auth section + `docs/plan.md` backlog line if the repo convention requires
  - Constraints: record, don't duplicate `docs/plan.md` narrative (constitution IX); link spec/plan/research.
  - Done when: ADR merged in the branch; cross-links valid.
  - Ref: constitution IX; research D1–D8.

- [ ] T037 Final gates + baseline diff review + PowerShell flow sign-off (`src/modules/auth/`, `src/modules/users/`, git diff vs baseline hash, `scripts/e2e-auth-users.ps1`)
  - Steps: `npm run lint` → `npm run build` → `npm run test -- --runInBand src/modules/auth src/modules/users` → `npm run test:e2e` (auth-relevant suites) → quickstart.md §3 greps (all zero) → final `powershell -ExecutionPolicy Bypass -File scripts/e2e-auth-users.ps1 -EnforceRevocation -StripPasswordHash` (exit 0, log kept) → `git diff <baseline-hash> --stat` + full diff read: ONLY intended files; wire diff limited to the 3 approved S rows.
  - Done when: everything green; diff review signed off in the task tracker/PR description with the baseline hash + S-delta test links + all PS run logs (T007/T017/T021/T028/T034/T037).
  - Ref: quickstart.md §4; spec SC-001–SC-005; plan DoD (§11 of REFACTOR_PLAN).

---

## Dependencies & Execution Order

### Phase Dependencies

- **Setup (Phase 1)**: No dependencies — start immediately.
- **Foundational (Phase 2)**: Depends on Setup — **BLOCKS all user stories**. The baseline commit (T007) is the gate; T008/T009 (ports/config) are also blocking since stories rewire onto them.
- **User Stories (Phase 3–6)**: All depend on Foundational. Run SEQUENTIALLY in priority order (US1 → US2 → US3 → US4) — each story diffs against the baseline, and later stories assume earlier ones (stores assume S-deltas; orchestrator thinning assumes stores).
- **Polish (Phase 7)**: Depends on all four stories.

### User Story Dependencies

- **US1 (P1)**: After Foundational — no story dependencies. MVP: stop after Phase 3 (holes closed, zero churn).
- **US2 (P1)**: After Foundational — technically independent of US1's code, but implement after US1 so S-1's `UsersService` guard lookup lands on the extended API. Testable independently via T018 greps + matrix.
- **US3 (P2)**: After US1 + US2 (moves S-1/S-2-affected persistence into stores; consumes extended `UsersService`).
- **US4 (P3)**: After US3 (rewires the thinned service/controller onto ports/config; needs final call sites).

### Within Each Story

- Tests FIRST (T010/T013-then-enact pattern): write → observe expected FAIL (S-delta proof) or GREEN (baseline) → implement → green.
- Baseline-green before slice; parity-matrix green after slice; races re-run wherever locking touched; commit per task or task-pair; stop at any checkpoint to validate.

### Parallel Opportunities ([P] tasks)

- T003, T004, T005, T006: different test files — parallelizable (all authors must run on unmodified code).
- T008, T009: different new files — parallelizable.
- T020, T021: different store files — parallelizable (both depend only on T022's pattern, not its code; when in doubt run sequentially).
- T031, T032: different files (guard vs directory move) — parallelizable.
- T036 alongside T035/T037 prep (docs vs code) — parallelizable.
- Everything else is sequential (same-file edits: auth.service.ts, auth.controller.ts).

---

## Parallel Example: Foundational tests (Phase 2)

```bash
# All four baseline suites touch different files and unmodified production code —
# launch together:
Task: "T003 baseline contract matrix in src/modules/auth/test/baseline-parity.integration.spec.ts"
Task: "T004 dual-JWT 401 matrix in src/modules/auth/test/jwt-paths.integration.spec.ts"
Task: "T005 register-leak proof in src/modules/auth/test/register-leak.integration.spec.ts"
Task: "T006 single-winner races in src/modules/auth/test/token-races.integration.spec.ts"
```

## Parallel Example: US3 stores (Phase 5)

```bash
# Different new files, shared pattern from T022 — launch together once T022's interface pattern is agreed:
Task: "T023 PasswordResetTokenStore + VerificationTokenStore in src/modules/auth/stores/"
Task: "T024 OtpStore in src/modules/auth/stores/otp.store.ts"
```

---

## PowerShell API flow runs (per story)

```powershell
# Baseline (T007, S-switches OFF = record-only pre-state):
powershell -ExecutionPolicy Bypass -File scripts/e2e-auth-users.ps1
# After every story slice (T017/T021/T028/T034/T037, S-switches ON):
powershell -ExecutionPolicy Bypass -File scripts/e2e-auth-users.ps1 -EnforceRevocation -StripPasswordHash
# Point at a non-default host when needed:
powershell -ExecutionPolicy Bypass -File scripts/e2e-auth-users.ps1 -BaseUrl 'http://localhost:3000' -EnforceRevocation -StripPasswordHash
```

---

## Implementation Strategy

### MVP First (US1 Only)

1. Complete Phase 1 (Setup) + Phase 2 (Foundational, incl. baseline commit T008).
2. Complete Phase 3 (US1: S-1/S-2/D3 with regression tests).
3. **STOP and VALIDATE**: T016 parity re-verification + T017 PS flow in S-delta mode; deploy/demo if ready — security posture fixed, zero structural risk taken.

### Incremental Delivery

1. Setup + Foundational → safety net committed.
2. + US1 → holes closed, proven (MVP).
3. + US2 → user writes single-owned, proven by greps + matrix.
4. + US3 → transactions explicit, side effects post-commit, proven by fault-injection.
5. + US4 → duplication removed, HTTP owned by controllers, proven by matrices.
6. Polish → docs + gates + diff sign-off.

### Parallel Team Strategy

With multiple developers: complete Setup + Foundational together (T003–T007 split across devs, one file each). Then, because stories are SEQUENTIAL here (same-file edits), parallelize within-story only where marked [P] (T023/T024, T031/T032, docs). Do not put two devs on `auth.service.ts` simultaneously.

---

## Notes

### PowerShell API test flow → test-task map (`scripts/e2e-auth-users.ps1`)

| Script step | Jest counterpart | Proven in |
|---|---|---|
| register 201 + D3 key check | T005 register-leak proof | T007 baseline, T015 flip, T017+ runs |
| duplicate 400, wrong-pass 401 | T003 contract matrix | every phase |
| users/me + preferences flip | T003 matrix | every phase |
| refresh rotate + reuse 401 | T006(a) races | T007 baseline, T017+ runs |
| forgot anti-enum identical 200s | T003 matrix | every phase |
| validate/verify garbage 400 | T003 matrix | every phase |
| resend 200 → 429 cooldown | T006(e) race + matrix | T007 baseline, T017+ runs |
| OTP 501 | T003 matrix | every phase |
| logout ×2 200, logout-all nuke | T006(d) + matrix | T007 baseline, T017+ runs |
| access-after-nuke (`-EnforceRevocation`) | T011 jwt-unified suite | T017/T021/T028/T034/T037 |
| rate-limit headers | T003 matrix 429 rows | every phase |

- Commit after each task or logical pair; each commit message states R vs S: `refactor(auth)[R]: ...` or `fix(auth)[S-1]: ...` with the baseline hash in S-commits.
- T005's flipped assertion and T011's fail-first are INTENTIONAL red-green proofs — do not "fix" the test to match old code.
- `updatePassword` quirk (research D5) is preserved — any "cleanup" of it inside a refactor commit is a defect.
- Query-count diffs are investigation signals (PQ-1), never gates. Line counts are review signals (SG-1), never extraction reasons.
- If any T003 row changes beyond the 3 approved S rows: STOP, treat as defect, do not proceed to the next task.
