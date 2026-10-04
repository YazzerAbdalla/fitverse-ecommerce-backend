# Plan — Auth + Users Hardening (audit fixes) + Verification-Token Fold into User

**Date:** 2026-10-04 | **Branch:** `015-auth-user-refactor` | **Status:** Implemented `be84453` → `473df14` (planning file retained as record; A4/A5/A6 approval-gated + A7 removal still open — see §7)
**Checkpoint:** `8d44cdc` "checkpoint auth hardening work on 015 branch" (10 files, mostly formatter churn + import organization; `.vscode/` left untracked on purpose).
**Sources:** senior audit report 2026-10-04 (auth+users, 16 `any`, Clock bypass, dual JWT path, missing DB uniqueness, 7 failing specs) + verification-fold sketch (1:1 columns on `User`, drop table, SafeUser DTO).
**Governing rules:** `AGENTS.md` §§2–8, `docs/REFACTOR_PLAN.md` TI-1…TI-8 + TX-1/TX-2/ST-1/MF-1/PQ-1/DC-1, ADR-0012 (RP-AUTH). Behavior-preserving except the 2 deltas named in §1.

## 0. Locked decisions (open questions → resolved per recommendation)

| # | Question | Decision (locked) |
|---|---|---|
| D1 | Token history loss acceptable? | **Yes.** Verify keeps only the live token; history rows are dropped by migration. Reset keeps its table. Record in ADR-0013. |
| D2 | Delete `VerificationTokenStore` vs slim to cooldown-only? | **Delete the file.** Cooldown (2 Redis calls) moves into `UsersService` or a ~20-line helper — no generic store framework (MF-1). |
| D3 | `purgeExpiredVerificationTokens` fate? | **Delete** method + any scheduler wiring; columns need no purge. Note in ADR-0013. |
| D4 | Expired-but-unused columns? | **Leave stale** until next resend overwrites. `verifyEmail` treats expired as `400` with zero mutation. |
| D5 | Safe-user scope now? | **`GET /users/me` + `register` now** via shared mapper; admin reads later (tracked as follow-up, not this plan). |

## 1. Intentional behavior deltas (everything else is R)

* **B/HISTORY:** per-user verification history rows disappear (only live token backfilled). Wire shapes (`200/400/429`) unchanged.
* **B/PURGE:** `purgeExpiredVerificationTokens` endpoint/job removed (no rows left to purge).
* No public route / event / queue / env-var rename. `resend` anti-enum messages byte-identical.

## 2. Pre-flight (do first — committed checkpoint contains a regression)

* [x] **Revert `src/data-source.ts` `synchronize: true` → `false`.** Done in `89614a0` (verified `npm run build`).

## 3. Part A — Audit hardening fixes (ordered, lowest risk first)

### A1. Fix 7 failing specs — test-implementation drift [Major]
* Files: `src/modules/auth/auth.service.spec.ts:714-930`, `auth-refresh.spec.ts`, `test/verify.integration.spec.ts`, `test/resend.integration.spec.ts`, `test/token-races.integration.spec.ts`, `test/register-leak.integration.spec.ts`.
* Root cause: specs mock pre-RP-AUTH `mockTokenRepo.save` / `getRepository(EmailVerificationToken)`; service now uses `VerificationTokenStore`. Plus `resendVerification` anti-enum message drift (`"If an account exists…"` vs `"This email is not registered or already verified…"`).
* Tasks:
  * [x] Re-mock to stores (`VerificationTokenStore` mock with `newVerificationIssue/findForUpdate/markTokenAsUsed/isCooldownActive/markCooldown`), not repos.
  * [x] Pin the **new** anti-enum message in the spec contract (or revert message to legacy — pick one, record it; current code returns the long message).
  * [x] Re-run real-PG races in CI (`token-races`: verify×2 → `200+400`, resend×2 → `200+429`).
* Done when: `npx jest src/modules/auth src/modules/users` → 162/162 green.

### A2. `any` → typed (16 prod sites) [Minor, mechanical]
* [x] `auth.service.ts:135,258,542,918,940,990` `catch (e: any)` → `catch (error: unknown)` + narrow; `:210,405` `signAsync(payload as any)` → type as `JwtPayload`; `:856` `Promise<any>` → explicit return type.
* [x] `otp.store.ts:102,103,145,160,168,176,190` `(cache as any)` → typed `CachePort` (`get/set/del`) or per-site justification.
* [x] `jwt.strategy.ts:32,34,42,43`, `rate-limit.guard.ts:138,147,179,214,245,417` same treatment.
* Done when: `grep -rn "as any\|: any" src/modules/auth/{auth.service.ts,stores/otp.store.ts,strategies/jwt.strategy.ts,guards/rate-limit.guard.ts}` empty (or justified inline).

### A3. Clock/port compliance [Minor]
* [x] `auth.service.ts:356,570` `Date.now()` → `this.clock.now().getTime()`; `:469,613` `passwordChangedAt: new Date()` → `clock.now()`; `:682-685` direct `crypto.sha256` → `sha256Hex(dto.token)`.
* [x] Stores: `refresh-token.store.ts:75,149,168,186`, `password-reset:52,121,126`, `verification:81,152`, `otp:97,156,179,206,217,264` raw `new Date()/Date.now()` → injected `Clock` (CC-A). `otp.store:155,212` hardcoded `3` → `otpMaxAttempts` from config.
* Done when: no `new Date()`/`Date.now()`/`crypto.` in touched business logic except documented OTP-digit exception.

### A4. Silent secret fallbacks [Major, small]
* [ ] `strategies/jwt.strategy.ts:17` `|| 'secret'`, `google.strategy.ts:19-23` `|| 'test' / 'localhost…'` → fail-fast in prod / warn-once in dev (same pattern as `auth-token.config.ts`). Needs approval (startup behavior) + test (missing secret → boot error in prod, warn in dev).

### A5. DTO floor unification [Minor]
* [ ] `reset-password.dto.ts:9` + `validate-reset-token.dto.ts:9` `token: string` → `Length(64)+Matches(hex)` (match `verify-email.dto.ts:17-19`); `user-register.dto.ts:30-31` `MinLength(4)` → `8` or document why 4 stays. Each as `[B]` with test (contract change).

### A6. DB uniqueness (needs approval — schema change) [Major]
* [ ] Migration (new, never edit committed): partial uniques `phoneNumber WHERE NOT NULL`, `googleId WHERE NOT NULL` (`user.entity.ts:47-55` are `@Index` only today); `tokenHash` uniqueness decision falls away after Part B fold (column, not row). Include concurrency test (double-link → `409`).

### A7. Dual JWT path removal [Minor, needs reachability evidence DC-1]
* [ ] Remove `JwtStrategy` (still provided `auth.module.ts:63`, off-path) after proving: no static import besides module, no DI token use, no route/guard/spec reference. Or document retention. Do NOT silently keep both.

### A8. JSDoc/Swagger backfill on touched files [Minor, lint-gated]
* [x] Missing class/method JSDoc: done in `473df14` for all listed files (strategies/guards/decorators/DTOs/config helpers/`types.ts`/`whatsapp.provider.ts`/`isUniqueViolation`/`register`/`login`/`completeOtpVerification`).
* [ ] Missing Swagger: `register` `400/409`, `login` `400`, `forgot/reset/validate` `200/400`, OTP `501` as `ApiResponse` (not just summary), `@ApiBody` per POST.
* [ ] Logging per skill §11: `debug` before every DB read/write in touched stores (makes duplicate reads visible).

### A9. Naming (fix-if-touching, zero behavior impact)
* [x] `login(user)` → `loginPrincipal`; `dto` ×4 → `resetPasswordDto/verifyEmailDto/requestOtpDto/verifyOtpDto`; `found/user/token/result/normalized` → explicit; `newRaw/newHash` → `newRawRefreshToken/newTokenHash`; `handleOtpSuccess/handleGoogleLogin` → `markOtpVerified/loginWithGoogle`; `rawHashPair` → `mintedTokenHash`; `id/row/token` params → explicit; `userResgisterDto:113` typo → `userRegisterDto`; drop `tooMany(_key)` dead param; `JwtPayloadProps` → `JwtPayload`.

## 4. Part B — Verification-token fold (depends on A1 green)

### B1. `User` columns
* File: `src/modules/users/entity/user.entity.ts:67-74`.
* [x] Add nullable `emailVerificationTokenHash varchar(255)`, `emailVerificationExpiresAt timestamptz`, `emailVerificationUsedAt timestamptz`. No hash index (verify loads by email → compares in-app). Class JSDoc updated.

### B2. New migration (never edit `0006`)
* File: `src/migration/17XXXXXXXXXX-FoldVerificationTokenIntoUser.ts` (new).
* [x] `up`: `ADD COLUMN IF NOT EXISTS` ×3 → backfill live token per user (`DISTINCT ON ("userId")` latest `usedAt IS NULL AND expiresAt > NOW()`) → `DROP TABLE email_verification_token`. `down`: recreate empty table + drop columns. Re-runnable guards like `0006`.

### B3. `UsersService` absorbs intent methods (TI-1: sole User writer)
* File: `src/modules/users/users.service.ts` (+ spec).
* [x] `issueEmailVerificationToken(manager,userId,hash,expiresAt)` (overwrite 3 cols, `usedAt=NULL`); `consumeEmailVerificationToken(manager,userId)` (`usedAt=NOW()+emailVerified=true`, one `save`); `findUserByEmailForUpdate(manager,email)` (`FOR UPDATE`, mirrors `findUserByIdForUpdate:69-80`). Full JSDoc + `//` intent comments.

### B4. `AuthService` rewire (owns tx, TI-3)
* File: `src/modules/auth/auth.service.ts:632-787,493-499`.
* [x] `requestEmailVerification/resendVerification`: cooldown (Redis, outside tx) → tx calls `issue…` → commit → `markCooldown` + emit post-commit (order unchanged). Drop `collisionRetry/isUniqueViolation` params (no `23505` anymore).
* [x] `verifyEmail`: advisory `findUserByEmail` (anti-enum `400`) → tx `findUserByEmailForUpdate` → compare `sha256Hex(dto.token)` vs columns + `usedAt NULL` + `expiresAt > clock.now()` else `400` → `consume…` → commit → emit. Single-winner now via **user-row lock**.
* [x] Delete `purgeExpiredVerificationTokens:493-499` (D3). Fix `682-685` crypto leak while touching (A3).

### B5. Delete dead code (DC-1 reachability: no static/DI/route/spec refs after B4)
* [x] Delete `stores/verification-token.store.ts`, `entities/email-verification-token.entity.ts`; remove from `auth.module.ts:24,34,42-47,69` + `data-source.ts:24,55`.

### B6. Safe-user mapper (the `/users/me` leak fix, D5)
* [x] New `src/modules/users/dto/safe-user-response.dto.ts`: explicit allow-list (`id, firstName, lastName, email, role, provider, phoneNumber?, phoneVerified, emailVerified, marketingOptIn, emailOptIn`) + `@ApiProperty` per prop. `toSafeUser(user)` helper. `GET /users/me:46-57` + `register:165-166` map through it. Never `Omit` (new sensitive cols would leak by default). Grep `return user|return savedUser|...found` for stragglers.

### B7. Tests (mirror A1 suites, new asserts)
* [x] Unit: issue-overwrites, verify-valid → `emailVerified+usedAt`, reuse → `400`, expired → `400`, wrong-hash → `400`, cooldown → `429` + 0 tx, anti-enum messages byte-identical.
* [x] Integration (real PG): `Promise.all(verify,verify)` → `200+400` once; migration up on seeded token rows → columns backfilled → table dropped.
* [x] E2E: `register → verify → GET /users/me` shows `emailVerified:true` with **no** `password/emailVerification*` keys; `resend → verify(new)` ok, `verify(old)` → `400`.

### B8. Docs
* [x] ADR-0013 (fold: history-loss + purge-removal + column semantics + mapper contract); update `architecture/email-service.md`, `architecture/modules.md` (RP-AUTH paragraph), `plan.md §18.2/18.8` deltas.

## 5. Execution order

```text
0. Revert synchronize (B0) → build
1. A1 specs green (unblocks all)
2. B6 mapper first (leak closed even before migration)
3. A2+A3+A9 mechanical (typed, clock, names) on touched files
4. B1→B4→B5 fold → B2 migration → B7 tests → B8 docs
5. A4+A5+A6 approval-gated (secrets/DTO/uniques) — separate commits
6. A7 strategy removal (reachability evidence) + A8 docs backfill
```

Parallelizable after A1: A2/A3/A9 ∥ B1/B6 (disjoint files). Never parallelize: B2 migration with B7 tests (migration lands first); A6 uniques with B2 (separate migrations, order B2 then A6).

## 6. Verification gates (per part)

* `npm run lint` touched-files clean; `npm run build` ✅; `npx jest src/modules/auth src/modules/users` green (incl. real-PG races); `npm run test:e2e` register→verify→me flow.
* R-parts: no wire/event/queue/env delta (diff-reviewed); B-parts (§1): history-loss + purge-removal documented + regression tests.
* Invariants re-checked: TI-1 (UsersService sole writer), TI-3 (AuthService owns tx, stores never commit), TI-4 (emit post-commit), TI-7 (single-winner), TI-8 (hash-only, prefix-6 logs).
* JSDoc per `AGENTS.md` §3 on every touched class/method; `//` intent on every multi-predicate guard + TTL arithmetic.

## 7. Risks / follow-ups (not in this plan)

* A7 evidence gathered 2026-10-04: `JwtStrategy` still required by `JwtAuthGuard` (passport `'jwt'`) on `google/link:388` + `jwt-paths.spec` characterization — removal deferred, tracked (see ADR-0013).
* `EMAIL_PROVIDER` factory duplication (`auth.module.ts:84-98` vs notifications) frozen for RP-NOTIF — do not unify here.
* `RateLimitGuard` table split frozen for RP-CACHE-GUARD.
* Admin `User` reads still return full rows (D5 follow-up).
* `phoneNumber`/`googleId` partial uniques (A6) need DBA-approved migration if pursued.
* Pre-existing lint errors in untouched files (`refresh.integration.spec.ts` require/empty-block) — out of scope.
