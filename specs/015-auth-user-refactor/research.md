# Research: Auth + Users Refactor (RP-AUTH)

**Feature**: `specs/015-auth-user-refactor` | **Date**: 2026-10-02
**Scope**: `src/modules/auth/**`, `src/modules/users/**` only (FR-009)

All findings below are verified against the current code (line refs), not the
plan's audit alone. Decisions labeled `[S]` are the three approved S-deltas
(S-1, S-2, D3-strip); everything else is `[R]` behavior-preserving.

## D1. S-1 unification target: JwtGuard + tokenVersion check `[S]`

- **Decision**: `JwtGuard` (`guards/jwt.guard.ts:11-38`) becomes the sole JWT path.
  It keeps `JwtService.verifyAsync` + Bearer extraction, then loads the user via
  `UsersService` and enforces the `tokenVersion` check (plus the
  `passwordChangedAt`/`iat` fallback), mirroring `strateges/jwt.strategy.ts:30-43`.
  `request.user` keeps the **payload shape** (`sub/email/fullName/role/tokenVersion`),
  which is what `RolesGuard` (`guards/roles.guard.ts`) and `@CurrentUser()`
  (`decorators/current-user.decorator.ts`, typed as `JwtPayloadProps`) consume —
  and what `@Auth()` (hardcodes `JwtGuard`, `decorators/auth.decorator.ts:7-11`)
  already provides on every guarded route including order/reservation/cart.
- **Rationale**: Payload shape is the de-facto standard; every downstream consumer
  is already written against it. Adopting the strategy's entity shape instead would
  churn all consumers.
- **Mandatory companion change**: `logoutAll` (`auth.controller.ts:306-309`) and
  `googleLink` (`:346-351`) read `(user as any).id`, which is only populated today
  because the stacked `JwtAuthGuard` (passport, entity shape) overwrites
  `request.user` after `JwtGuard` runs. Under the unified guard `request.user` is
  the payload (`sub`, no `id`), so both handlers switch to `sub` — internal-only
  change, zero observable delta, pinned by tests calling both routes pre/post.
- **Alternatives considered**:
  - Unify to `JwtStrategy`/entity shape — rejected: churns `RolesGuard`,
    `@CurrentUser()` typings, and every cross-module consumer of the payload shape.
  - `JwtGuard` delegates to `JwtStrategy.validate` internally — rejected: validate
    returns the entity; the guard would still need to re-derive the payload, so
    direct `UsersService` lookup + check inside the guard is simpler and keeps one
    code path for the check logic (shared private helper co-located with the guard).
- **Retention (DC-1)**: `JwtStrategy`/`JwtAuthGuard`/passport `jwt` strategy
  registration are NOT deleted in this phase (reachability beyond auth — e.g.
  other modules' tests/imports — is unverified). They stay wired but unused on the
  request path; removal is a follow-up with its own reachability evidence.

## D2. S-2 validate/reset authority split `[S]`

- **Decision**: `validateResetToken` (`auth.service.ts:553-568`, plain `findOne`)
  stays an unlocked, non-authoritative UX pre-check (same 200/400 contract).
  `resetPassword` (`:570-…`, `FOR UPDATE`) becomes the sole authority: it
  revalidates hash/expiry/use **inside its transaction while holding the lock**,
  then consumes the token + bcrypt-hashes the new password + `tokenVersion++`
  atomically. New regression test: concurrent validate+reset proves the TOCTOU
  window is closed at the authority point (validate may say valid, reset is the
  decider; double-reset → one 200 one 400).
- **Rationale**: Matches the approved clarification; keeps the read path
  lock-free while the mutating path stays single-winner.
- **Alternatives considered**: locking the validate path too — rejected per
  clarification (adds contention to a UX pre-check with no correctness gain once
  reset revalidates).

## D3. Register response strips the password hash `[S]`

- **Decision**: Baseline characterization **proves** `register`
  (`auth.service.ts:67-94`) returns `data: newUser` where
  `newUser = { ...dto, password: hashedPassword }` — the bcrypt hash is sent in
  the 201 body today. The approved D3 ("keep shape + pin no-password-leak") is
  therefore satisfiable only by stripping the `password` key from `data` while
  keeping every other key identical. That single-key strip IS the approved S-delta;
  the pin test (`data` has no `password`/`hash` key) fails on baseline, passes after.
- **Rationale**: Returning a password hash (even bcrypt) in a response body is a
  credential-material leak (logs, caches, clients); the minimal fix preserves the
  approved shape decision.
- **Alternatives considered**: keep byte-identical body — rejected: irreconcilable
  with the approved no-leak pin.

## D4. Decomposition: orchestrator + intent-based stores + publisher

- **Decision**: `AuthService` (1267 lines; methods inventoried:
  register/userValidation/login/createRefreshTokenForUser/refresh/logout/logoutAll/
  purge×2/requestPasswordReset/validateResetToken/resetPassword/requestEmailVerification/
  verifyEmail/resendVerification/OTP×5 +timingSafeEqual/handleGoogleLogin/linkGoogleAccount/
  TTL×2/isUniqueViolation) becomes a thin orchestrator. Persistence moves to
  intent-based stores receiving the caller's tx-scoped `EntityManager`, never
  committing (TX-1/ST-1):
  - `RefreshTokenStore` (`acquire`/`rotate`/`revokeOne`/`revokeAllForUser`/`purgeExpired`)
    — owns cap-5 LRU (`:165-183` vs `:330-345` merged, same eviction),
    single-use rotation, theft bulk-nuke.
  - `VerificationTokenStore` (email verify 24h) + `PasswordResetTokenStore` (15m) —
    own hash/issue/invalidate-priors/consume (anti-enum + invalidate-priors ×3 unified).
  - `OtpStore` — owns Redis TTL/hash/attempts/cooldown + PG audit fallback (OTP stays
    501-isolated; only the store is shared).
  - `UsersService` (extended, per clarification — D5) owns ALL user-row writes,
    replacing the ~3 `manager.getRepository(User)` bypass sites (`:264,432,599`).
  - `AuthEventPublisher` — owns `emitAuthEvent` (`:630-657`, `ClientProxy` inside
    domain); after-commit only (TI-4). Signature frozen so CC-C `EventBusPort` can
    adopt it in RP-OUTBOX.
  - Cooldown/counter Redis access (`resendVerification` 60s `SET NX`, refresh reuse
    `INCR` counters) moves behind `CooldownTracker`/`AttemptCounter` seams in auth
    scope; keys/TTLs/fail-open semantics byte-identical (CC-C canonicalizes later).
- **Rationale**: Splits at tx/orchestration/persistence/transport seams (plan §3);
  each unit has ≥3 call sites or one crisp responsibility (Rule of Three); no
  generic base/state-machine abstractions (MF-1).

## D5. UsersService extension shape (clarified)

- **Decision**: Extend existing methods (keep names/signatures; add optional params
  only where a tx-scoped manager must be threaded, e.g. `updatePassword`,
  `createNewUser`, Google-link/verify-flag setters). Token flows get separate
  stores (D4), not new user-surface methods.
- **Observed quirk (preserve, do not silently fix)**: `updatePassword` (`users.service.ts:65-72`)
  builds an `update` object honoring the explicit `tokenVersion` param but then
  ignores it, always incrementing via query-builder fn. `[R]` preserve byte-for-byte;
  record as follow-up candidate, never "fix" inside the refactor diff.

## D6. Frozen in this phase (characterize only)

- `RateLimitGuard` (623 lines, 16 route keys) — pinned 429/header/bucket tests only;
  table-driven split belongs to RP-CACHE-GUARD (clarified Q1).
- `EMAIL_PROVIDER` factory duplication (`auth.module.ts:51-65` vs notifications) —
  untouched; single-factory consolidation belongs to RP-NOTIF (clarified Q3).
- `JwtStrategy`/`JwtAuthGuard` wiring — retained but off the request path (D1).
- OTP 501 behavior; `strateges/`→`strategies/` move is path-hygiene only
  (`strategies/` currently holds just `google.strategy.spec.ts`; real strategies live
  in the typo dir — move + atomic import updates, build+tests prove zero delta).
- `LocalAuthGuard:15-27` manual DTO validation duplicates the global pipe: remove
  ONLY if the 400-shape characterization proves identical output via the global pipe;
  otherwise keep. Proof-gated, never assumed.

## D7. HTTP-out-of-service + typed config (clarified Q4)

- **Decision**: `resendVerification`'s in-service 429 (`auth.service.ts:830-855`)
  becomes a domain `VerificationCooldownError(retryAfterMs)` thrown by the service
  and translated to the identical 429 + `Retry-After` by the controller (status,
  body, headers pinned pre/post). Same pattern for any other in-service HTTP
  construction found during implementation.
- **Decision**: Full typed `AuthTokenConfig` parsed once at startup
  (`JWT_SECRET/JWT_EXPIRES_IN/REFRESH_TOKEN_TTL/REFRESH_TOKEN_COOKIE_*/RESET_TOKEN_TTL/
  EMAIL_VERIFICATION_TTL/OTP_TTL/OTP_MAX_ATTEMPTS/OTP_RESEND_COOLDOWN/GOOGLE_*/FRONTEND_URL`),
  warn-once on fallback, values identical to today's `??` defaults
  (`auth.service.ts:159,349,507,687,953`; controller cookie options). No new
  hard-fail (OD-1/CF-1). Unifies the triple TTL parsing
  (`parseTtlMs:1221` vs `parseTtlWithDefault:666` vs controller cookie math) into one
  `parseDurationMs` with identical outputs (unit matrix).
- **Crypto/clock**: `sha256` ×14 + `randomBytes(32).hex` ×7 → `TokenHasher`/
  `SecureToken`; `new Date()/Date.now()` ~30× → `Clock` (fakes in tests). These are
  the CC-A primitives vendored minimally in auth scope with CC-A-compatible
  signatures.

## D8. Baseline-first verification (clarified Q5)

- **Decision**: One full pre-split baseline commit BEFORE any structural change:
  contract matrix (all routes × 200/400/401/403/404/409 incl. cookie/header diff,
  `register.data.password` presence, dual-path JWT shapes, `logoutAll` `.id` reliance),
  single-winner races (refresh/reset/verify reuse via `Promise.all` on real PG),
  cooldown/rate-limiter fail-open proofs. Every later slice diffs against it.
  Gates per slice: `lint/build/test/test:e2e` (auth scope) + race suites where
  locking touched; query shapes recorded as signals (PQ-1).
