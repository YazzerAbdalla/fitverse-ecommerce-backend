# Contracts — Refresh Token Rotation — Phase 17

**Feature**: `013-refresh-token` | **Date**: 2026-09-23 | **Spec**: [spec.md](../spec.md) | **Plan**: [plan.md](../plan.md)

---

## 1. POST /auth/login (extended)

**Auth**: public (uses `LocalAuthGuard` internally) — `POST /auth/login` stays `RateLimitGuard(LocalAuthGuard)` per `auth.controller.ts`.

**Request**:
```http
POST /auth/login HTTP/1.1
Content-Type: application/json

{ "email": "alice@example.com", "password": "P@ssw0rd!" }
```
`LoginDto` unchanged (`email` `@IsEmail`, `password` `@IsString @MinLength(8)`).

**Success 200**:
```json
{
  "message": "User loged in successfuly",
  "accessToken": "eyJhbGc... (15m, payload {sub,email,fullName,role,tokenVersion})",
  "refreshToken": "a3f1c9e8...64 hex (crypto.randomBytes(32).toString('hex'))"
}
```
Headers: `Set-Cookie: refresh_token=a3f1c9e8...; HttpOnly; Secure=<secure>; SameSite=Strict; Path=/auth; Max-Age=604800` (`Max-Age = REFRESH_TOKEN_TTL 7d /1000`)
DB: `INSERT RefreshToken {userId, tokenHash=sha256(refreshToken), expiresAt=now+7d, revokedAt NULL}` — cap 5 LRU eviction if needed. `Logger.log` with `hashPrefix=tokenHash.slice(0,6)`.

**Errors**: `401 Unauthorized` bad creds `{statusCode:401, message:"Unauthorized", timestamp}` no `RefreshToken` row; `429 Too Many Requests` `Retry-After: 3600` `X-RateLimit-*` when `RateLimitGuard` `10/h IP` exceeded; `400` validation.

**Swagger**: `@ApiBody type LoginDto` `@ApiResponse 200 {accessToken, refreshToken}` `@ApiResponse 401/429`.

---

## 2. GET /auth/google/callback (extended per clarification)

Same contract as `POST /auth/login` but no body — `GoogleAuthGuard` `req.user = GoogleProfile { googleId, email, verified, firstName, lastName }`:

**Success 200**:
```json
{ "accessToken": "eyJ...", "refreshToken": "64hex" }
```
Headers: same `Set-Cookie`. Persists `RefreshToken` with cap 5.

**Errors**: `400 Google email not verified` if `verified=false`; `429 20/h IP` (existing `google/callback` limit); `409 Google account already linked` on `23505`.

---

## 3. POST /auth/refresh

**Auth**: public (bearer is `refreshToken` itself, not `accessToken`) — `@UseGuards(RateLimitGuard)` outermost, no `JwtGuard`.

**Request** (body precedence, else cookie fallback):
```http
POST /auth/refresh HTTP/1.1
Content-Type: application/json
Cookie: refresh_token=a3f1c9e8...64 hex (alternative)
# Body:
{ "refreshToken": "a3f1c9e8...64 hex" }
```
`RefreshTokenDto` (`refreshToken?: string @IsString @Length(64,64) @Matches(/^[0-9a-f]{64}$/) @IsOptional()`) — at least one source required else `401`. Global `ValidationPipe` `forbidNonWhitelisted`.

**Handler** (inside `dataSource.transaction`):
```text
raw = dto.refreshToken ?? req.cookies[REFRESH_TOKEN_COOKIE_NAME] ?? parseCookie(req.headers.cookie)
if !raw → 401 {message:"Invalid or expired refresh token"}
tokenHash = sha256(raw)
SELECT RefreshToken WHERE tokenHash=:hash FOR UPDATE
if !found → 401 (no theft nuke)
load User where id=row.userId; if !user → 401
if row.revokedAt NOT NULL → 401 + theft: UPDATE RefreshToken SET revokedAt=NOW() WHERE userId=:userId AND revokedAt IS NULL + Logger.warn + INCR (outside tx) — no new pair
if row.expiresAt <= NOW() → 401 (expired, no theft nuke)
else // active
  UPDATE old SET revokedAt=NOW() WHERE id=:row.id
  newRaw = crypto.randomBytes(32).toString('hex'); newHash=sha256(newRaw); newExpiresAt=now+7d
  // cap 5 LRU: if count active >=5 revoke oldest FOR UPDATE before INSERT
  INSERT new RefreshToken {userId, tokenHash=newHash, expiresAt=newExpiresAt}
  newAccessToken = JwtService.signAsync {sub,email,fullName,role,tokenVersion:user.tokenVersion} 15m
COMMIT
if user.emailVerified===false → res.setHeader('X-Email-Unverified','true') + Logger.warn
```

**Success 200**:
```json
{ "accessToken": "eyJ...new 15m", "refreshToken": "new64hex" }
```
Headers: `Set-Cookie: refresh_token=new64hex; HttpOnly; Secure; SameSite=Strict; Path=/auth; Max-Age=604800` + `X-Email-Unverified: true` if unverified.

**Errors**:
- `401 {statusCode:401,message:"Invalid or expired refresh token",timestamp}` for `!found`/`revokedAt`/`expiresAt<=NOW()`/`!user`/`tokenVersion` bulk-revoked — theft branch also `401` plus side-effect bulk revoke (idempotent theft).
- `400 {statusCode:400}` validation length/match.
- `429 Too Many Requests` dual buckets `10/h IP` + `5/h hash 6-prefix` before `FOR UPDATE` (`X-RateLimit-Limit/Remaining`, `Retry-After: 3600`).

**Swagger**: `@ApiOperation Refresh via Cookie or Body` `@ApiBody type RefreshTokenDto` `@ApiResponse 200 {accessToken, refreshToken}` `@ApiResponse 401/400/429`.

**Concurrency**: `Promise.all([refresh(oldRaw), refresh(oldRaw)])` → one `200` + rotation, one `401` theft revoke-all; DB has exactly one new active.

---

## 4. POST /auth/logout

**Auth**: public (possession proves ownership) — `@UseGuards(RateLimitGuard)` outermost, no `JwtGuard` required; if `Authorization: Bearer` present, ignore ownership check (still `200`).

**Request**:
```http
POST /auth/logout HTTP/1.1
Content-Type: application/json
Cookie: refresh_token=a3f1c9e8... (alternative)
{ "refreshToken": "a3f1c9e8...64 hex" }
```
Same DTO body|cookie resolution; if neither → `200` anti-enum (do not `401` to prevent oracle — per spec `200` even if not found).

**Handler**:
```text
raw = dto.refreshToken ?? cookie; if !raw → return 200 {message:"Logged out"} (anti-enum)
tokenHash=sha256(raw)
UPDATE RefreshToken SET revokedAt=NOW() WHERE tokenHash=:hash AND revokedAt IS NULL
// 0 rows if not found/already revoked → still 200
```

**Success 200** (idempotent):
```json
{ "message": "Logged out" }
```
Second `POST /auth/logout` same `raw` → `200` `0` rows.

**Errors**: `429 20/h IP` only; `400` validation length.

**Swagger**: `@ApiResponse 200` `@ApiResponse 429`.

---

## 5. POST /auth/logout-all

**Auth**: `JwtGuard` required — `@Auth()` / `@UseGuards(RateLimitGuard, JwtAuthGuard)` any role.

**Request**:
```http
POST /auth/logout-all HTTP/1.1
Authorization: Bearer eyJ...15m (valid tokenVersion)
Content-Type: application/json
{}
```
Body `{}` `forbidNonWhitelisted` empty.

**Handler** (`dataSource.transaction`):
```text
userId = req.user.sub
SELECT User WHERE id=:userId FOR UPDATE (optional serialize)
UPDATE User SET tokenVersion = tokenVersion + 1 WHERE id=:userId
UPDATE RefreshToken SET revokedAt=NOW() WHERE userId=:userId AND revokedAt IS NULL
COMMIT → Logger.log logout-all userId
```

**Success 200**:
```json
{ "message": "All sessions revoked" }
```
Subsequent `JwtGuard` with old `accessToken` → `401 tokenVersion mismatch` (`JwtStrategy.validate` `payload.tokenVersion !== user.tokenVersion`). Subsequent `POST /auth/refresh` with any old `refreshToken` → `401` (`revokedAt NOT NULL`).

**Errors**: `401 Unauthorized` unauthenticated; `429 10/h user` (`rl:POST /auth/logout-all:user:<sub>`); `400` non-empty body.

**Swagger**: `@Auth()` `@ApiResponse 200` `@ApiResponse 401/429`.

---

## Rate-limit headers (all throttled routes)

- Success: `X-RateLimit-Limit: <max>`, `X-RateLimit-Remaining: <max-count>`
- `429`: `HttpException 429` with `options.headers { 'Retry-After': ceil(windowMs/1000)='3600', 'X-RateLimit-Limit': String(limit), 'X-RateLimit-Remaining':'0' }` forwarded by `AllExceptionsFilter` → `res.setHeader` → JSON `{statusCode:429, message:"Too Many Requests", timestamp}` (existing `src/filters/all-exceptions.filter.ts` already forwards `options.headers` per Phase 10)
- Dual `refresh` buckets: both must pass; `INCR+EXPIRE` `rl:POST /auth/refresh:ip:<ip>` `10` + `rl:POST /auth/refresh:hash:<6prefix>` `5` fail-open on `CACHE_MANAGER throw` → `Logger.warn RateLimit Redis fail-open for <routeKey>: <msg>` + allow `true`.

## Cookie attributes

- Name `REFRESH_TOKEN_COOKIE_NAME` default `refresh_token` (`ConfigService`)
- `HttpOnly: true`, `Secure: ConfigService REFRESH_TOKEN_COOKIE_SECURE === 'true'` (prod `true`, dev `false` when `NODE_ENV !== 'production'`), `SameSite: Strict`, `Path: /auth` (or `/auth/refresh` per plan), `Max-Age: ceil(REFRESH_TOKEN_TTL ms /1000)` (`604800` for `7d`)

## Error envelope (REST)

All via `AllExceptionsFilter`:
```json
{ "statusCode": 401, "message": "Invalid or expired refresh token", "timestamp": "2026-09-23T..." }
```
`POST /auth/refresh` may also set `X-Email-Unverified: true` on `200` when `user.emailVerified=false` (allow+warn per Q5 C).

## No-go

- `GET /auth/refresh` → `405` (only `POST`).
- No `client.emit` inside any `dataSource.transaction`; no Redis/RabbitMQ inside `refresh` transaction.
- No raw `refreshToken` logged; `Logger` prefix `tokenHash.slice(0,6)` only.
