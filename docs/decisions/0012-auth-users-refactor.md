# ADR 0012: Auth + Users Refactor — Orchestrator, Stores, Unified Guard (RP-AUTH)

**Date**: 2026-10-03
**Status**: Accepted
**Spec**: `specs/015-auth-user-refactor/spec.md` | **Plan**: `specs/015-auth-user-refactor/plan.md`
**Branch**: `015-auth-user-refactor`

## Context

`AuthService` (~1267 lines) coupled orchestration, persistence, broker, cache,
and HTTP concerns; user writes bypassed `UsersService` (~9 sites); two JWT
verification paths diverged (manual guard without revocation vs strategy with);
the refresh rotation, forgot-password, and token endpoints were 500-broken
(TypeORM null-where, missing entity metadata, empty-roles guard). The refactor
plan (`docs/REFACTOR_PLAN.md` §RP-AUTH) required behavior-preserving structure
with three approved security deltas (S-1, S-2, D3).

## Decision

- **Orchestrator + intent-based stores**: `AuthService` owns transaction
  boundaries and delegates to `RefreshTokenStore`, `PasswordResetTokenStore`,
  `VerificationTokenStore`, `OtpStore` (tx-scoped manager in, never commit;
  theft nuke keeps its documented own-tx), `UsersService` (sole user writer),
  and `AuthEventPublisher` (post-commit only, fail-open).
- **S-1**: `JwtGuard` is the sole JWT path (signature + user load +
  `tokenVersion` check, payload shape frozen); `logoutAll`/`googleLink` read
  `sub`; `JwtStrategy` retained off-path. `AuthModule` provides/exports
  `JwtGuard` and re-exports `UsersModule` (one-way edges, no cycles).
- **S-2**: `validateResetToken` stays an advisory pre-check; `resetPassword`
  revalidates under `FOR UPDATE` as the sole authority.
- **D3**: register returns the same shape minus the `password` key (bcrypt
  hash no longer leaves the server).
- **B-bundle** (regression-tested, required to make flows work at all): `IsNull`
  rotation count, theft-nuke own-tx, token-entity metadata, empty-roles
  passthrough, iat second-truncation tolerance.
- **Frozen for later phases**: `RateLimitGuard` (table split → RP-CACHE-GUARD),
  `EMAIL_PROVIDER` factory (single factory → RP-NOTIF).
- **Kept R**: POST-default 201s, nested error-body shape, OTP 501, cooldown
  semantics, cap-5 eviction pick, `updatePassword`-era quirks where observed,
  OTP cooldown swallow, resend no-collision-retry.

## Alternatives Considered

- Entity-shape unification (strategy as sole path) — rejected: churns every
  `RolesGuard`/`@CurrentUser()` consumer.
- Generic base/store framework — rejected per MF-1/Rule-of-Three; stores are
  single-responsibility units, helpers cite ≥3 sites.
- `forwardRef` auth↔users cycle — tried, rejected after a deterministic boot
  failure; one-way edges via re-export instead.

## Consequences

- Every guarded route now enforces revocation; concurrent single-use races are
  single-winner with persistent theft-nuke; refresh/forgot/verify/resend work
  end-to-end for the first time (proven by 21-step HTTP matrix + 15-step live
  PS flow + real-PG races).
- Follow-ups recorded (not done): `JwtStrategy` removal with reachability
  evidence; `updatePassword` dead-param cleanup; OTP cooldown enforcement.

## Verification

- `npm run build` clean; touched scope lint-error-free (remaining repo errors
  pre-date this work); 166/166 unit+integration green; live PS flow 15/15 in
  full S-delta mode; contract diff limited to the 3 approved S rows + 5 B rows.
