# Contract: Auth + Users Parity Matrix (RP-AUTH)

**Feature**: `specs/015-auth-user-refactor` | **Date**: 2026-10-02

This is the behavioral gate for the whole phase (spec SC-001/SC-004, FR-001).
Every row is captured in the pre-split baseline commit (research D8) and
re-verified after each structural slice. `=` means byte-identical (modulo fresh
token/UUID values); `[S]` rows are the three approved deltas.

## REST routes (all in `AuthController`; DTOs, verbs, paths frozen)

| Method + Path | Auth | Success (=) | Error cases (=) |
|---|---|---|---|
| `POST /auth/register` | public + RL | 201 `{message, data}` `[S]` minus `data.password` key only (research D3) | 400 duplicate / validation; 429 |
| `POST /auth/login` | public + RL + Local | 201 `{message, accessToken, refreshToken}` + `Set-Cookie` (POST default, kept as R) | 401 bad creds; 400 validation; 429 |
| `POST /auth/refresh` | public + RL (dual buckets) | 201 rotated pair + rotated cookie (POST default, kept as R); `X-Email-Unverified` when unverified | 401 invalid/expired/revoked + theft nuke; 400; 429 (before any lock) |
| `POST /auth/logout` | public + RL | 201 idempotent (POST default, kept as R; body-or-cookie token; unknown token still success) | 429 |
| `POST /auth/logout-all` | `@Auth()` (S-1: unified JwtGuard sole path) | 201 (POST default, kept as R); old access+refresh dead | 401 unauth; 429 |
| `POST /auth/forgot-password` | public + RL | 201 anti-enum neutral (POST default, kept as R; known + unknown identical) | 400 validation; 429 (IP + email buckets) |
| `POST /auth/validate-reset-token` | public + RL | 200 `{valid:true}` (advisory; unlocked read `[S]` per D2) | 400 invalid/expired/used |
| `POST /auth/reset-password` | public + RL | 200 + `tokenVersion++` + bulk revoke (authority `[S]` per D2) | 400 invalid/expired/used/weak/`==email`; 429 |
| `GET /auth/verify-email` (`?token&email`) | public + RL | 200 `{verified:true}` + flag set | 400 invalid/expired/used; 429 |
| `POST /auth/verify-email` | public + RL | 200 (same) | 400; 429 |
| `POST /auth/resend-verification` | public + RL | 201 anti-enum (POST default, kept as R); 60s-cooldown 429 + `Retry-After` (moved to controller, identical wire bytes) | 400 validation; 429 (cooldown + IP + email buckets) |
| `POST /auth/otp/request`, `POST /auth/otp/verify` | public + RL | 501 (unchanged, isolated) | 501 |
| `GET /auth/google`, `GET /auth/google/callback` | Google guards + RL | 302 / 200 pair + cookie (verified-email auto-link/create) | 400 unverified provider email; 429 |
| `GET /auth/google/link` | JWT + Google guards | 200 linked | 401/403; 429 |
| `PATCH /users/me/preferences` | JWT | 200 flags (either-or; `FOR UPDATE` serialized) | 400 neither-flag; 401; 404 |

## Guard contract `[S-1]`

- `@Auth(...roles)` keeps `UseGuards(JwtGuard, RolesGuard)`; unified `JwtGuard`
  denies revoked-version tokens (401) on every route where the old manual guard
  let them through — that delta IS the approved S-1 change, covered by the
  revoked-user 401 matrix on both pre-paths (baseline) and the unified path.
- `RolesGuard` 403 semantics, `CurrentUser()`/`CurrentUser(prop)` shapes, and
  `request.user` payload shape: unchanged.
- Internal only: `logoutAll`/`googleLink` read `sub` instead of `id` (same value;
  no wire change).

## Events / cookies / headers (frozen)

- Post-commit events `auth.password_reset_requested`, `email.verification_requested`,
  `auth.email_verified` — payload keys, queue names, after-commit timing unchanged.
- Refresh cookie (`refresh_token`, `HttpOnly`, `Secure`, `SameSite=Strict`,
  `Path=/auth`, `Max-Age` from TTL) and `X-Email-Unverified` header: unchanged.
- Rate-limit buckets/keys/windows + fail-open (allow + warn, never 500): unchanged;
  throttling never holds a DB lock.
- Raw tokens/secrets never stored or logged (hashed 6-char prefixes only): unchanged.
