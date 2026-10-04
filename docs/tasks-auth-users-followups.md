# Tasks — Auth + Users Follow-ups (A4/A5/A6/A7/A8-residual)

**Source:** `docs/plan-auth-users-hardening.md` §7 + `docs/decisions/0013-verification-token-fold.md`
**Branch:** `015-auth-user-refactor` | **Status:** A7 done (`8f498e8`); A4 done (commit below); A5/A6/A8-residual open
**Gates for every task:** `npm run build` clean · touched-scope lint error-free ·
`npm run test -- src/modules/auth src/modules/users` green (serial, real PG) ·
no wire/event/queue/env change unless the task says `[B]`/`[S]` + regression test.

## Order

```text
[x] A7 (done `8f498e8` — single JWT path, google/link via @Auth())
  → A4 (secrets — done, see below)
  → A5 (DTO floors, contract [B] — own commit, needs approval)
  → A6 (partial uniques, schema [B] — own commit, needs DBA approval)
  → A8-residual (Swagger, docs-only, safe anytime)
```

Parallelizable: A8-residual anytime. Never parallelize: A6 migration with any
other migration work; A4 with release/deploy timing (changes boot behavior).

---

## A7. Remove the dual JWT path (needs the evidence in ADR-0013 §A7 + plan §7)

- [x] T-A7.1 Rewire `GET /auth/google/link` (`auth.controller.ts:388`) from
  `@UseGuards(JwtAuthGuard, GoogleAuthGuard)` to `@Auth()` + `GoogleAuthGuard`
  (or `@Auth()` alone if link needs no role — currently role-bypass by design;
  keep that semantic). `user.sub ?? user.id` at `:349` collapses to `user.sub`
  (payload shape always has `sub` under `JwtGuard`).
- [x] T-A7.2 Delete `strategies/jwt.strategy.ts` + the legacy passport
  wrapper `guards/jwt-auth.guard.ts` (`JwtAuthGuard` — NOT `JwtGuard`;
  `guards/jwt.guard.ts` stays as the sole path). Remove `JwtStrategy` from
  `auth.module.ts:19,60`; fix the three doc comments
  referencing it (`guards/jwt.guard.ts:43,88`, `modules/users/users.service.ts:5`,
  `modules/notifications/notifications.gateway.ts:64` — reword to sole-path).
- [x] T-A7.3 Rewrite `test/jwt-paths.integration.spec.ts`: drop the
  `JwtStrategy` construction sections (`:179,195,222`) + the entity-vs-payload
  divergence test (`:212`) — the divergence disappears with the path. Keep the
  `JwtGuard` revocation matrix (P0-2 characterization must stay green).
- [x] T-A7.4 Verify: `grep -rn "JwtStrategy\|JwtAuthGuard" src/ test/` empty
  (except ADR/plan history); build + full serial suite green.
- **Done when:** single JWT path (`JwtGuard`), no passport `'jwt'` registration,
  google/link works via `@Auth()`, suite green. Commit:
  `refactor(auth): remove off-path JwtStrategy, link via JwtGuard` (`8f498e8`, 18/18 suites, 165/165 tests).

## A4. Secret fail-fast (startup behavior — needs approval) `[S]`

- [x] T-A4.0 `JWT_SECRET || 'secret'` is already gone — it died with
  `JwtStrategy` in A7 (`8f498e8`). Verified: `grep "|| 'secret'" src/` empty;
  `JwtModule` (`auth.module.ts:49`) and the WS gateway (`gateway.ts:58`) read
  the key with no fallback (fail-closed). Nothing to do.
- [x] T-A4.1 `google.strategy.ts:39-42` (`GOOGLE_CLIENT_ID/SECRET || 'test'`,
  `GOOGLE_CALLBACK_URL || 'localhost…'`) → fail-fast in prod / warn-once in
  dev (same pattern as `auth-token.config.ts` `warnOnce`). Rule: throw at
  strategy construction when `NODE_ENV=production` and any key missing; warn
  + fallback otherwise. Note: `super()` must stay first — read the keys into
  locals from `configService` before `super()`, validate after.
- [x] T-A4.2 Tests: construct `GoogleStrategy` with empty config in prod mode
  → throws; in dev → warns + falls back. Existing suites keep passing (they
  provide explicit config).
- **Done when:** no silent `|| 'secret'/'test'` in touched wiring; behavior
  documented in ADR-0013 addendum. Commit: `fix(auth): fail-fast on missing
  secrets in prod`.

## A5. DTO floor unification (contract change — needs approval) `[B]`

- [ ] T-A5.1 `dto/reset-password.dto.ts:9` + `dto/validate-reset-token.dto.ts:9`
  `token: string` → `@Length(64,64) + @Matches(/^[0-9a-f]{64}$/)` (match
  `verify-email.dto.ts:17-19`). Garbage tokens 400 at validation instead of
  service — update contract docs + parity expectations if any pin the old path.
- [ ] T-A5.2 `dto/user-register.dto.ts:30-31` `MinLength(4)` → `MinLength(8)`
  **or** record why 4 stays (weak registration floor vs reset floor).
- [ ] T-A5.3 Unit tests per changed DTO (length/hex rejection, min-length
  rejection); E2E register weak-password case still 400.
- **Done when:** floors consistent (or divergence documented), tests pin the
  new 400s. Commit: `fix(auth): unify token/password DTO floors`.

## A6. DB partial uniques (schema change — needs DBA approval) `[B]`

- [ ] T-A6.1 New migration (never edit committed): partial uniques
  `phoneNumber WHERE "phoneNumber" IS NOT NULL`,
  `googleId WHERE "googleId" IS NOT NULL` (`user.entity.ts:47-55` are
  `@Index`-only today). Entity: `@Unique` + partial index expressions.
- [ ] T-A6.2 Concurrency test: double-link same `googleId` →
  one wins, other `409` (proves the DB, not the app, serializes).
- [ ] T-A6.3 Backfill check: migration must no-op cleanly if duplicates
  already exist (query + report; resolve data before applying).
- **Done when:** migration applies on seeded DB, double-link 409 proven,
  rollback path verified. Commit: `feat(users): partial uniques for
  phoneNumber/googleId`.

## A8-residual. Swagger + logging coverage (docs-only, safe anytime)

- [ ] T-A8.1 Per-route `@ApiResponse`: `register` `400/409`, `login` `400`,
  `forgot/reset/validate` `200/400`, OTP routes `501` as `ApiResponse`
  (today only in summary text), `@ApiBody` per POST. Swagger UI loads without
  errors; snapshot the new responses in `contracts/` if the repo keeps one.
- [ ] T-A8.2 Skill §11 `debug` before every DB read/write in touched stores
  (`RefreshTokenStore.findByHashForUpdate`, `PasswordResetTokenStore` lookups,
  `UsersService` finders) so duplicate reads are visible in logs.
- [ ] T-A8.3 Confirm `docs/plan.md` §18 deltas reference the fold (columns vs
  table) — one paragraph, link ADR-0013. (The `specs/014-*` history files stay
  untouched: they record what was true at the time.)
- **Done when:** Swagger covers every success/error status on touched routes;
  `grep ApiResponse` per route ≥ statuses the handler can return. Commit:
  `docs(auth): complete Swagger responses + debug-log coverage`.

---

## Out of scope (tracked elsewhere, do NOT pull in)

- `EMAIL_PROVIDER` single factory → RP-NOTIF.
- `RateLimitGuard` table split → RP-CACHE-GUARD.
- Admin `User` reads allow-list → needs product decision (D5 follow-up).
- Pre-existing lint errors in untouched files (`refresh.integration.spec.ts`
  `require()`/empty-block) → separate chore if ever touched.
- `test/verify.e2e-spec.ts` full-app run in CI with infra up.
