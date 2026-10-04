# ADR 0013: Verification Token Folded into User (1:1) + SafeUser Allow-List

**Date**: 2026-10-04
**Status**: Accepted
**Branch**: `015-auth-user-refactor` (commits `be84453` → `473df14`)
**Supersedes (parts)**: ADR-email-service §Tokens (EmailVerificationToken table), ADR 0012 (VerificationTokenStore, purge job)

## Context

Phase 18 modeled email verification as a one-to-many `email_verification_token`
table (history rows per resend) with a dedicated `VerificationTokenStore`
(prior-invalidation + collision retry + cooldown + 7d purge) and a
`GET /users/me` that stripped only `password` by rest-spread — any new
server-side column would leak by default.

## Decision

- **1:1 columns on `User`**: `emailVerificationTokenHash` /
  `emailVerificationExpiresAt` / `emailVerificationUsedAt` (all nullable, no
  hash index — verify loads by email, compares in-app). Migration
  `1755900000010-FoldVerificationTokenIntoUser` backfills the latest live
  token per user (`DISTINCT ON`, unused + unexpired only), then drops the table
  (fresh DBs skip via `to_regclass` guard). Down recreates the table empty.
- **History loss (B/HISTORY, intentional)**: per-user token history disappears;
  only the live link survives. Reset tokens keep their table (different
  lifecycle: multi-active + audit).
- **UsersService owns the writes** (TI-1): `issueEmailVerificationToken` /
  `consumeEmailVerificationToken` / `findUserByEmailForUpdate`. AuthService owns
  tx boundaries (TI-3); single-winner now serializes on the **user-row**
  `FOR UPDATE` instead of the token-row lock. No `23505` path remains, so the
  collision-retry/`isUniqueViolation` plumbing is deleted with the store.
- **Cooldown stays Redis, moves into AuthService** (it already owns
  `CACHE_MANAGER`): same key `resend:cooldown:<email>`, same 60s TTL, same
  fail-open. `VerificationCooldownError` moves to
  `verification-cooldown.error.ts` (wire shape unchanged).
- **Purge removal (B/PURGE, intentional)**:
  `purgeExpiredVerificationTokens` deleted (no rows left to purge; stale
  columns are left until the next resend overwrites them, D4).
- **SafeUser allow-list (D5)**: new `SafeUserResponseDto` + `toSafeUser()` —
  explicit field pick, never rest-spread. `GET /users/me` and `register` map
  through it. Wire delta (additive, backward compatible): register `data` now
  also carries `id/role/provider/flags` (previously DTO-echo without `id`).
- **Collateral hardening in the same line** (A2/A3/A9, all R): `catch
  (error: unknown)` + narrowing across AuthService; `Clock` for all token
  timestamps (service + 3 stores); `OtpStore` typed cache port +
  `otpMaxAttempts` from config + `issueOtp` rename; `RateLimitGuard` typed
  request/buckets/cache port (non-string email/phone no longer bucketed —
  still counted on IP, then 400s at validation); `loginWithGoogle`,
  `completeOtpVerification`, explicit `*Dto` params; `JwtPayload` rename;
  JSDoc backfill on strategies/guards/decorators/DTOs/config helpers.
- **A7 deferred with evidence**: `JwtStrategy` + `JwtAuthGuard` retained —
  `JwtAuthGuard` still guards `google/link:388`, the module provides the
  passport `'jwt'` strategy for it, and `jwt-paths.spec` characterizes both
  paths (P0-2). Removal = rewire link to `@Auth()` + spec rewrite; tracked,
  not done here.
- **Approval-gated, NOT done**: A4 secret fail-fast, A5 DTO floors,
  A6 partial uniques (each needs a separate decision + migration/test).

## Alternatives Considered

- Keep the table + add `userId` unique (1:1 via constraint) — rejected: keeps a
  join + purge + collision machinery for a single live value.
- `Omit<User, ...>` for the safe shape — rejected: new sensitive columns leak
  by default; allow-list fails closed.
- Cooldown into UsersService — rejected: UsersService has no cache and should
  stay persistence-only; AuthService already owns `CACHE_MANAGER`.

## Consequences

- One fewer table, join, purge job, and collision path; verify/resend races
  still single-winner (proven by rewritten real-PG suites).
- `register → verify → GET /users/me` E2E unchanged except register `data`
  gains `id`; `/users/me` can never leak token columns.
- Follow-ups: A4/A5/A6 approvals, A7 removal, per-route Swagger `ApiResponse`
  completion on register/login/forgot/reset/validate, `refresh.integration`
  pre-existing lint errors (untouched files).

## Verification

- `npm run build` clean; touched-scope lint error-free (remaining repo errors
  pre-date this work: `refresh.integration.spec.ts` require/empty-block).
- `npm run test -- src/modules/auth src/modules/users` (serial, real PG):
  **18/18 suites, 168/168 green**, incl. rewritten verify/resend/races +
  new mapper + UsersService intent specs.
