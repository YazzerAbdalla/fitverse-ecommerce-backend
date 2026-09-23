# Architecture — Refresh Token Rotation (Phase 17)

**Date**: 2026-09-23 | **Spec**: `specs/013-refresh-token/spec.md` | **Plan**: `specs/013-refresh-token/plan.md` | **Branch**: `013-refresh-token`

Phase 16 made `tokenVersion` revocation stateless (reset-password `tokenVersion++` → `JwtStrategy.validate` `payload.tokenVersion === user.tokenVersion else 401`). Phase 17 adds silent `15m` renewal via opaque refresh token single-use rotation without making Redis/RabbitMQ authoritative.

## Persistence

```text
RefreshToken PG authoritative (synchronize:false migration 1755900000005-CreateRefreshToken)
  id uuid PK, userId FK CASCADE @Index, tokenHash varchar255 @Index sha256 64hex, expiresAt timestamptz CHECK>createdAt, revokedAt nullable, createdAt/updatedAt
  indexes userId/tokenHash/expiresAt/userId,expiresAt + partial UQ tokenHash WHERE revokedAt IS NULL

User.tokenVersion int default 0 already (no schema change) — bulk revokedAt + tokenVersion++ are dual nuke
```

## Lifecycle

```text
Login POST /auth/login OR GET /auth/google/callback (verified email)
  → randomBytes(32).hex 64 raw + sha256 hash + expiresAt now+7d (parseTtlMs d)
  → cap 5 LRU: if active>=5 revoke oldest FOR UPDATE ORDER BY createdAt ASC LIMIT 1
  → INSERT RefreshToken {userId,tokenHash,expiresAt} → sign {sub,email,fullName,role,tokenVersion} 15m → Set-Cookie: refresh_token HttpOnly Secure SameSite=Strict Path=/auth Max-Age=604800 → 200 {accessToken,refreshToken}

Refresh POST /auth/refresh public (RateLimitGuard outermost before FOR UPDATE)
  raw = body.refreshToken ?? cookies[refresh_token] ?? header.cookie fallback; if !raw → 401
  sha256 raw → FOR UPDATE SELECT WHERE tokenHash=:hash
  if !found → 401
  if revokedAt → 401 + theft bulk UPDATE revokedAt WHERE userId AND revokedAt IS NULL + Logger.warn prefix 6 + INCR idempotency:duplicate:skipped:refresh
  if expiresAt <= NOW → 401
  else active: UPDATE old revokedAt NOW() + cap5 check + newRaw/hash/expiresAt INSERT + sign newAccessToken tokenVersion current → COMMIT → Set-Cookie rotated + X-Email-Unverified:true if !emailVerified

Logout POST /auth/logout public body|cookie
  raw ?? 200 anti-enum; sha256 → UPDATE WHERE tokenHash AND revokedAt IS NULL → 200 (0 rows idempotent)

LogoutAll POST /auth/logout-all @Auth JwtGuard
  FOR UPDATE User WHERE id=:sub → tokenVersion++ + bulk UPDATE revokedAt WHERE userId → 200 → old accessToken 401 via JwtStrategy, old refresh 401 via revokedAt

Purge nightly DELETE WHERE (revokedAt < NOW()-7d) OR (expiresAt < NOW()-7d) → log purged n
```

## Rate-limit / Observability

```text
RateLimitGuard distributed CACHE_MANAGER rl:* INCR+EXPIRE fail-open outermost
  POST /auth/refresh 10/h IP + 5/h hash 6-prefix dual buckets before FOR UPDATE (both must pass)
  POST /auth/logout 20/h IP
  POST /auth/logout-all 10/h user (sub ?? ip)
  429 → Retry-After:3600 X-RateLimit-Limit/Remaining via AllExceptionsFilter.options.headers
  Redis down → Logger.warn fail-open allow true, headers absent

Logging prefix only (tokenHash.slice(0,6) never raw)
  refresh rotated userId hashPrefix->newPrefix, reuse theft warn, logout revoked prefix, logout-all revoked all
  X-Email-Unverified:true header when emailVerified false (allow+warn)
  cookie-parser app.use before ValidationPipe populates req.cookies
```

## Contracts

- `POST /auth/login` `200 {accessToken 15m, refreshToken 64hex}+Set-Cookie` `401` `429`
- `GET /auth/google/callback` `200 {accessToken,refreshToken}+Set-Cookie` (Google A)
- `POST /auth/refresh` `200 {accessToken,refreshToken}+Set-Cookie` vs `401` + theft revoke-all + `X-Email-Unverified`
- `POST /auth/logout` `200 {message:"Logged out"}` idempotent `429`
- `POST /auth/logout-all` `@Auth` `200 {message:"All sessions revoked"}` `401` `429`
```

