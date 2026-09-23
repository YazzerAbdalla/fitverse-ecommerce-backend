# ADR: Refresh Token Rotation — Opaque + FOR UPDATE + Theft Revoke-All (Phase 17)

**Date**: 2026-09-23 | **Status**: Accepted | **Spec**: `specs/013-refresh-token/spec.md` | **Plan**: `specs/013-refresh-token/plan.md` | **Branch**: `013-refresh-token`

## Context

Phase 16 left `POST /auth/login` issuing only short-lived `accessToken 15m` (`JWT_SECRET`, `JWT_EXPIRES_IN=15m`, `tokenVersion` nuke) → clients saw `401` every `15m` and had to re-enter password. Manual E2E `docs/manual-e2e-test-flow.md:§1.5` documented `POST /auth/refresh → 404`. Requirement before Phase 14 testing: add silent refresh without making Redis/RabbitMQ authoritative, preserving `tokenVersion` global nuke, handling `HttpOnly` browser vs non-browser transports, and preventing replay.

## Decision

- **Opaque RefreshToken** `crypto.randomBytes(32).toString('hex') 64 hex 256 bits` + `sha256` hash stored in PG `RefreshToken` (`id uuid PK, userId FK CASCADE, tokenHash varchar255 @Index, expiresAt timestamptz CHECK>createdAt, revokedAt nullable, createdAt/updatedAt, indexes userId/tokenHash/expiresAt/userId,expiresAt, partial UQ tokenHash WHERE revokedAt IS NULL`) — `synchronize:false` migration `1755900000005-CreateRefreshToken`.
- **Single-use rotation** `POST /auth/refresh` `SELECT ... FOR UPDATE where tokenHash=:hash` inside `dataSource.transaction` → active `revokedAt IS NULL && expiresAt > NOW()` → `UPDATE old revokedAt=NOW()` + cap 5 LRU (revoke oldest active if `count>=5`) + `INSERT new {tokenHash=sha256(newRaw),expiresAt=now+7d}` + `sign {sub,email,fullName,role,tokenVersion:user.tokenVersion} 15m` → `200 {accessToken,refreshToken}+Set-Cookie: refresh_token HttpOnly Secure SameSite=Strict Path=/auth Max-Age=604800` dual body|cookie (body precedence, `cookie-parser`).
- **Theft** reuse `revokedAt NOT NULL` → `401 Invalid or expired refresh token` + bulk `UPDATE revokedAt=NOW() WHERE userId=:userId AND revokedAt IS NULL` + `Logger.warn hashPrefix 6` + optional `INCR idempotency:duplicate:skipped:refresh`.
- **Login + Google** `POST /auth/login` (`LocalAuthGuard`) and `GET /auth/google/callback` (`GoogleStrategy` verified email) both create `RefreshToken` cap5 after `sign` and return `{accessToken,refreshToken}+Set-Cookie` (clarification Google A).
- **Logout** `POST /auth/logout` public body|cookie `UPDATE revokedAt WHERE tokenHash AND revokedAt IS NULL` `200` idempotent anti-enum; `POST /auth/logout-all` `@Auth() JwtGuard` `tokenVersion++` + bulk `revokedAt` atomic `200`.
- **Rate-limit** dual `POST /auth/refresh 10/h IP + 5/h hash 6-prefix` before `FOR UPDATE`, `POST /auth/logout 20/h IP`, `POST /auth/logout-all 10/h user` via `CACHE_MANAGER rl:* INCR+EXPIRE` fail-open outermost before `JwtGuard`, `ConfigService REFRESH_*` clamped.
- **Retention** `7d` after `expiresAt`/`revokedAt` nightly `DELETE` (purge 7d matches TTL).
- **EmailVerified** allow `refresh` even if `emailVerified=false` but `Logger.warn` + `X-Email-Unverified: true` header (Q5 C).

## Alternatives Considered

- JWT `refresh_token` with `jti` + DB `jti` — **rejected**: cannot selectively revoke without `tokenVersion++` nuke, adds `verify` path.
- Sliding reuse `expiresAt+=7d` no `revokedAt` — **rejected**: no theft detection, stolen lives 7d longer.
- Body-only vs cookie-only — **rejected**: forces `localStorage` XSS or `Cookie` header manual; dual covers both.
- `401` log-only on reuse vs `401`+revoke-all — **rejected**: weaker blast radius; bulk nuke chosen per plan §17.5.
- Cap unbounded vs cap10 — **rejected**: unbounded bloat; 5 LRU balances device limit vs storage (easy bump via config).
- `30d` purge vs never — **rejected**: 30d looser storage, never unbounded.

## Consequences

- **Positive**: Silent `15m` renewal, single-use theft detection, cap 5 bounds active set, dual rate-limit before `FOR UPDATE` prevents hot-loop, PG authoritative `FOR UPDATE` single-winner `Promise.all 200+401`, `reset-password`/`logout-all` `tokenVersion++` implicitly revokes refresh via bulk `revokedAt`.
- **Negative**: Extra `INSERT` per login/refresh (<10ms), `FOR UPDATE` holds row during `sign` (~5ms), `cookie-parser` middleware added, `RefreshToken` table retention 7d cleanup needed.
- **Migrations**: `1755900000005-CreateRefreshToken` never edit prior.
- **Verification**: SC-001 login 64hex+sha256, SC-002 rotation `200`+`401`, SC-003 concurrent `200+401` theft, SC-004 expiry 401, SC-005 logout idempotent+logout-all tokenVersion 1, SC-006 reset-password→refresh 401, SC-007 dual transport, SC-008 `429` fail-open `npm run build/test -- --runInBand` 236 tests.
