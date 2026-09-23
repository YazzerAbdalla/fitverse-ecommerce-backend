# Feature Specification: Refresh Token Rotation — Phase 17

**Feature Branch**: `013-refresh-token`  
**Created**: 2026-09-23  
**Status**: Draft  
**Input**: User description: "start on phase 17 refresh token"
**Source**: `docs/plan.md` §17 (Phase 17 — Refresh Token, planned 2026-09-23), `src/modules/auth/auth.service.ts` + `auth.controller.ts` (Phase 16: `POST /auth/login` `JwtService.sign {sub,email,fullName,role,tokenVersion} 15m`, `tokenVersion` revocation, `PasswordResetToken`/`OtpVerification`), `src/modules/users/entity/user.entity.ts` (`tokenVersion int default 0`, `passwordChangedAt`), `specs/005-auth-upgrades/spec.md` (auth baseline), constitution I/III (PostgreSQL authoritative, Redis/RabbitMQ not authoritative)

---

## 1. Overview

Phase 16 delivered password-reset, Google OAuth, and stateless `tokenVersion` revocation but left `POST /auth/login` issuing only a short-lived `accessToken` (`JWT_EXPIRES_IN=15m`). Clients that keep an `accessToken` longer than `15m` currently see `401` and must re-login with password — manual E2E `docs/manual-e2e-test-flow.md:§1.5` documents `POST /auth/refresh → 404` as expected. Phase 17 closes this gap with **opaque refresh token rotation** so a client can silently obtain a new `accessToken` without re-entering credentials, while preserving `tokenVersion` as the global revocation nuke and without making Redis/RabbitMQ authoritative for auth state.

**Decision summary (from `docs/plan.md` §17):**

```text
Login → DB inserts RefreshToken { tokenHash=sha256(raw), expiresAt=now+7d }
Refresh → hash(raw) → FOR UPDATE lookup → verify not revoked/expired → user exists + tokenVersion OK → transaction: revoke old (revokedAt=NOW()) + insert new hash + sign new accessToken (tokenVersion from User) → return new pair (+ Set-Cookie)
Logout → revoke single hash (idempotent 200)
Logout-all → User.tokenVersion++ + revoke all active hashes for user (same as reset-password)
Theft detection: reuse of already-revoked hash → 401 + revoke all for user + warn log
Transport: dual — Body {refreshToken} 64 hex OR HttpOnly cookie refresh_token ; response returns both JSON and Set-Cookie
TTLs: access 15m (unchanged), refresh 7d (env REFRESH_TOKEN_TTL)
PG is source of truth; Redis is only cache/rate-limit/lock; never log rawRefresh
```

This phase is **orthogonal** to Phases 7-13 (order/infra) and does not change `Product/Inventory/Reservation/Order` invariants. It must ship **before** `Phase 14 — Testing` so final `npm run test:e2e` can cover `register → login → refresh → cart → checkout → complete` without `401` flakes.

### Goal

A logged-in client whose `accessToken` expired (`15m`) can call `POST /auth/refresh` with its `refreshToken` (body or `HttpOnly` cookie) and receive a **rotated** pair `{accessToken (15m), refreshToken (new 64 hex, 7d)}` exactly once — reuse of the old token is rejected `401` and optionally revokes all sessions for theft protection — while `POST /auth/logout` revokes a single session and `POST /auth/logout-all` revokes all sessions via `tokenVersion++`. — `docs/plan.md` §17.9 Exit Criteria: *login returns hash-stored refresh, refresh rotates single-use, logout/ logout-all revoke, no double-issue under concurrency.*

---

## User Scenarios & Testing *(mandatory)*

### User Story 1 — Silent refresh after accessToken expiry — single-use rotation (Priority: P1)

A user logs in (`POST /auth/login {email,password} → 200 {accessToken, refreshToken}`), uses `GET /order` with `Authorization: Bearer <accessToken>` while it is valid (`200`), waits until `accessToken` expires (`15m`, or mocked `exp` in tests), receives `401` on next `GET /order`, then calls `POST /auth/refresh {refreshToken}` (or with `Cookie: refresh_token=...`) and receives `200 {accessToken: <new 15m>, refreshToken: <new 64 hex>}` with old `tokenHash` now `revokedAt IS NOT NULL`. The new `accessToken` grants `GET /order → 200`. A second call with the **same old** `refreshToken` returns `401 {message:"Invalid or expired refresh token"}` and **does not** issue a new pair; optionally it revokes all remaining `RefreshToken` for that user (theft detection).

**Why this priority**: Core value — without rotation, every `15m` forces password re-entry, breaking mobile/SPA sessions. Rotation with single-use prevents replay if `refreshToken` leaks from logs/storage.

**Independent Test**: Can be fully tested by `register → login` capture `rawRefresh` via `AuthService.lastRawRefresh` or JSON, decode `accessToken` `exp`, call `GET /order` with old `accessToken` expired `401`, call `POST /auth/refresh {refreshToken: rawRefresh}` `200` capture `newRaw`, call `GET /order` with `newAccess 200`, call `POST /auth/refresh {refreshToken: rawRefresh}` (old) `401`, verify `RefreshToken` table has old row `revokedAt NOT NULL` and new row `revokedAt NULL`.

**Acceptance Scenarios**:

1. **Given** a logged-in user with `rawRefresh` stored as `sha256(rawRefresh)` `expiresAt=now+7d` `revokedAt NULL` and `accessToken exp now+15m`, **When** `POST /auth/refresh {refreshToken: rawRefresh}` inside `DataSource.transaction` with `SELECT RefreshToken FOR UPDATE where tokenHash=hash`, **Then** system verifies `revokedAt IS NULL && expiresAt > NOW()` and `User exists && User.tokenVersion matches accessToken tokenVersion`, sets `old.revokedAt=NOW()`, inserts new `RefreshToken {userId, tokenHash=sha256(newRaw), expiresAt=now+7d}`, signs `accessToken {sub,email,fullName,role,tokenVersion: user.tokenVersion}`, returns `200 {accessToken, refreshToken: newRaw}` and `Set-Cookie: refresh_token=newRaw; HttpOnly; Secure; SameSite=Strict; Path=/auth; Max-Age=604800`, old hash is revoked and second use fails.
2. **Given** a valid `refreshToken` but its `expiresAt <= NOW()` (7d elapsed) or `revokedAt NOT NULL` (already used or logged-out), **When** `POST /auth/refresh` is called, **Then** system returns `401 Unauthorized {message:"Invalid or expired refresh token"}` and does not issue new pair, does not mutate `Inventory/Order/Reservation`.
3. **Given** a valid `refreshToken` for user A, **When** `POST /auth/refresh` is called concurrently twice with same `rawRefresh` via `Promise.all`, **Then** exactly one succeeds `200` with rotation, the other returns `401` (single-winner via `FOR UPDATE` serialization), `RefreshToken` table has exactly one new active row, `stock`/`reservedAmount` unchanged `0` mutations, and theft-detection branch revokes all remaining active tokens for user and logs `Logger.warn refresh reuse detected userId=<id> hashPrefix=<6 chars>`.
4. **Given** a `refreshToken` presented via `Cookie: refresh_token=<raw>` with empty body `{}`, **When** `POST /auth/refresh` is called, **Then** system reads `req.cookies[REFRESH_TOKEN_COOKIE_NAME]` as fallback and succeeds `200` identically to body path (dual transport per §17.4).

---

### User Story 2 — Login issues refresh token alongside access token (Priority: P1)

A user calls `POST /auth/login {email,password}` with valid credentials (via `LocalAuthGuard` → `AuthService.userValidation` bcrypt) and receives `200 {message, accessToken (15m), refreshToken (64 hex)}` plus `Set-Cookie: refresh_token=...; HttpOnly; Path=/auth; Max-Age=604800`. The DB now contains a `RefreshToken` row with `tokenHash=sha256(raw)`, `expiresAt=now+7d`. `POST /auth/register` does not auto-issue refresh — only login (and refresh) do.

**Why this priority**: Prerequisite for P1 refresh — without creation on login, no refresh exists to rotate. Shares same security properties (hash never raw, never logged).

**Independent Test**: Unit mock `DataSource`/`JwtService`: call `authService.login(user)` then assert `repo.save` called with `tokenHash` 64 hex sha256 and `expiresAt` within `7d ± 5s`, and returned `refreshToken` `Length 64` hex; integration real PG: `login → SELECT tokenHash,expiresAt FROM refresh_token WHERE userId=:id` `count 1` `expiresAt > NOW()`; E2E `POST /auth/login → body.refreshToken` `64` and `set-cookie` header contains `refresh_token=`.

**Acceptance Scenarios**:

1. **Given** valid credentials for existing user, **When** `POST /auth/login` succeeds, **Then** response contains `accessToken` JWT decodable `{sub, email, fullName, role, tokenVersion}` `exp 15m` and `refreshToken` `64` hex random (`crypto.randomBytes(32).toString('hex')`), DB row `tokenHash = sha256(refreshToken)` exists, `rawRefresh` never stored.
2. **Given** invalid credentials, **When** `POST /auth/login` is called, **Then** `401 Unauthorized` and no `RefreshToken` row is created.

---

### User Story 3 — Logout revokes single refresh token and logout-all revokes all sessions (Priority: P2)

A user with two devices (two `refreshToken`s `r1`, `r2` from two logins) calls `POST /auth/logout {refreshToken: r1}` (or with cookie) and receives `200 {message:"Logged out"}` — `r1` row `revokedAt=NOW()`, `r2` still active. A subsequent `POST /auth/refresh {refreshToken: r1}` returns `401`. Calling `POST /auth/logout {refreshToken: r1}` again returns `200` idempotent (already revoked, `0` delta) — matching Phase 12 `COMPLETED→COMPLETED 200` policy. Separately, an authenticated user calls `POST /auth/logout-all` with `Authorization: Bearer <accessToken>` (`JwtGuard`) and receives `200 {message:"All sessions revoked"}` — `User.tokenVersion` increments, all `RefreshToken WHERE userId=:id AND revokedAt IS NULL` set `revokedAt=NOW()`, and any prior `accessToken` or `refreshToken` fails `JwtStrategy.validate tokenVersion` or `refresh` hash check with `401`.

**Why this priority**: Session hygiene — single-device logout vs compromised-account nuke. `tokenVersion++` reuse keeps revocation stateless (already proven by `reset-password`).

**Independent Test**: Real PG: login twice `r1,r2` → `SELECT count(*) active` `2`; `POST /auth/logout {r1} 200` → `active 1` (`r2` only); `POST /auth/refresh r1 401` `r2 200`; `POST /auth/logout r1 200` idempotent `active 1`; `POST /auth/logout-all` (Bearer) `200` → `User.tokenVersion 0→1` `active 0` `POST /auth/refresh r2 401 tokenVersion mismatch`.

**Acceptance Scenarios**:

1. **Given** `RefreshToken` `r1` active `revokedAt NULL`, **When** `POST /auth/logout {refreshToken: r1}` is called (public, token ownership via hash lookup — or `JwtGuard` variant where `currentUser.id` must match `row.userId` else `200` anti-enumeration), **Then** `UPDATE RefreshToken SET revokedAt=NOW() WHERE tokenHash=hash AND revokedAt IS NULL` and return `200`, DB `r1 revokedAt NOT NULL`.
2. **Given** `RefreshToken` `r1` already `revokedAt NOT NULL`, **When** `POST /auth/logout {refreshToken: r1}` again, **Then** return `200` idempotent, `UPDATE` `0` rows, no error.
3. **Given** an authenticated user with `accessToken` `tokenVersion 0` and two active refresh rows, **When** `POST /auth/logout-all` with `Authorization: Bearer <accessToken>` succeeds, **Then** `User.tokenVersion 1`, all active refresh rows `revokedAt=NOW()`, subsequent `POST /auth/refresh` with any old `r` returns `401` and any old `accessToken` fails `JwtGuard 401 tokenVersion mismatch`.
4. **Given** `User.resetPassword` increments `tokenVersion` (existing Phase 16), **When** password reset commits, **Then** `POST /auth/refresh` with any pre-reset `refreshToken` returns `401` (tokenVersion check), proving global nuke covers refresh too.

---

### User Story 4 — Rate limiting and observability for refresh/logout (Priority: P2, cross-cutting)

As a system, refresh and logout endpoints must be protected against brute-force hash enumeration and must remain observable without leaking `rawRefresh`.

**Why this priority**: `refreshToken` is bearer-equivalent; enumeration + hot-loop on `FOR UPDATE` would degrade auth. Shares `RateLimitGuard` already used for `POST /auth/login` etc.

**Independent Test**: Unit mock `CACHE_MANAGER`: exceed `POST /auth/refresh` `10/h/IP` → `429`; Redis down → fail-open `200` with `Logger.warn`. Integration `FLUSHDB` then `11x POST /auth/refresh` same IP → `11th 429`.

**Acceptance Scenarios**:

1. **Given** `RateLimitGuard` limits `POST /auth/refresh 10/hour/IP (+ 10/hour/user when authenticated)`, `POST /auth/logout 20/hour/IP` (see FR-007), **When** limits exceeded, **Then** returns `429 Too Many Requests` with `Retry-After: 3600` and `X-RateLimit-*` headers, `DataSource.transaction` `0` calls on `429` path.
2. **Given** Redis unavailable, **When** `POST /auth/refresh` or `POST /auth/logout` is called, **Then** request proceeds (fail-open) with `Logger.warn RateLimit Redis fail-open for auth:refresh: <msg>` and rate headers may be absent, never `500` due to cache.
3. **Given** any refresh/logout success or `401` reuse, **When** handled, **Then** logs contain hashed prefix only (e.g., `refresh rotated userId=... hashPrefix=abc123...` or `refresh reuse detected prefix=...`), never `rawRefresh`.

---

### Edge Cases

- What happens when `POST /auth/refresh` is called with `refreshToken` that was never issued (random 64 hex) or with truncated `63` chars? → `401 Invalid or expired refresh token`, `400 validation` for length, no DB mutation, no `tokenVersion` increment.
- What happens when `POST /auth/refresh` body contains `refreshToken` **and** cookie `refresh_token` differ? → Body takes precedence; if body missing, cookie is fallback; if both missing → `401`.
- What happens when `refreshToken` hash lookup finds row but `User` was deleted (FK CASCADE) or found `row` but `User.tokenVersion` mismatches `payload tokenVersion` (post `reset-password`/`logout-all`)? → `401` and row treated as revoked (no new pair).
- What happens when `expiresAt` is exactly `NOW()`? → Expired, `401`; `CHECK expiresAt > createdAt` would reject `expiresAt <= createdAt` at INSERT — use `expiresAt = now + 7d`.
- How does system handle concurrent `logout` and `refresh` with same `r1`? → `FOR UPDATE` on `RefreshToken` inside `refresh` transaction serializes with `UPDATE ... WHERE revokedAt IS NULL` in `logout` — one wins, other sees `revokedAt NOT NULL → 401` (refresh) or `0` rows `200` (logout idempotent).
- What happens when `POST /auth/login` is retried due to client timeout after DB committed `RefreshToken` but before JSON reached client? → Two active rows for same user is allowed — refresh tokens are independent sessions; no duplicate-key violation; client may have two `refreshToken`s, both valid until one is rotated/logged-out (different from `PasswordResetToken` single-active invalidation).
- How does system handle `REFRESH_TOKEN_TTL` parse `REFRESH_TOKEN_TTL=7d` vs `604800s`? → `parseTtlMs` handles `s/m/h/d` via `ConfigService` (already pattern for `RESET_TOKEN_TTL`); invalid → fallback `7d` + `Logger.warn`.
- What happens when `POST /auth/logout` is called unauthenticated with `refreshToken` belonging to another user? → Lookup by `tokenHash` alone, so it revokes that hash regardless — acceptable as `refreshToken` possession proves ownership; do not require `JwtGuard` for `logout` (allow anonymous revocation by token, `200` anti-enum even if not found to prevent oracle).
- What happens when `RefreshToken` `tokenHash` `unique WHERE revokedAt IS NULL` partial index collision due to `crypto.randomBytes(32)` collision (prob negligible) → `23505` → retry generate new `rawRefresh` once, else `500` with `Logger.error`.
- What happens when `HttpOnly` cookie `Secure` is `true` in prod but request is `http` in dev? → `REFRESH_TOKEN_COOKIE_SECURE` `ConfigService` default `true` prod, `false` when `NODE_ENV !== 'production'`; `SameSite=Strict`, `Path=/auth`, `Max-Age=604800`.
- How does system handle `GET /auth/refresh` vs `POST`? → Only `POST /auth/refresh` is defined; `GET` returns `405` via Nest router.
- What happens when `RateLimitGuard 429` fires before `ValidationPipe 400`? → Guard outermost (`@UseGuards(RateLimitGuard)` before `JwtGuard`/`ValidationPipe`) → `429` path `DataSource.transaction 0` calls, preserving inventory rule (no lock held).

---

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: System MUST expose `POST /auth/login` (existing, extended) and `GET /auth/google/callback` (and link flow when re-issuing JWT) that after successful credential validation (`LocalAuthGuard` + `UsersService.findUserByEmail` + `bcrypt.compare` for login; `GoogleStrategy` verified profile for OAuth) generates **both** `accessToken` (`JwtService.signAsync {sub,email,fullName,role,tokenVersion:user.tokenVersion} 15m via JWT_EXPIRES_IN`) and `refreshToken` (`crypto.randomBytes(32).toString('hex')` `64` hex `256 bits`, same as `PasswordResetToken`) and persists `RefreshToken {userId, tokenHash=sha256(raw), expiresAt=now+REFRESH_TOKEN_TTL(7d)}` inside `DataSource` (no need for `transaction` because single insert, but use manager when combining with tokenVersion checks later). Response `200 {accessToken, refreshToken}` plus `Set-Cookie: <REFRESH_TOKEN_COOKIE_NAME>=<raw>; HttpOnly; Secure=<secure>; SameSite=Strict; Path=/auth; Max-Age=<ttlSec>`; `rawRefresh` never logged, only `Logger.log` with hash prefix.

- **FR-002**: System MUST add `RefreshToken` entity in PostgreSQL (source of truth, not Redis) with fields `id uuid PK @PrimaryGeneratedColumn('uuid')`, `userId uuid FK → User.id ON DELETE CASCADE @Index`, `tokenHash varchar(255) @Index` (`sha256` hex 64 chars), `expiresAt timestamptz` (`CHECK expiresAt > createdAt`), `revokedAt timestamptz nullable` (`NULL` = active), `createdAt @CreateDateColumn`, `updatedAt @UpdateDateColumn` (optional), plus indexes `IDX_refresh_token_userId`, `IDX_refresh_token_tokenHash`, `IDX_refresh_token_expiresAt`, composite `IDX_refresh_token_userId_expiresAt`, partial unique `UQ_refresh_token_hash_active UNIQUE(tokenHash) WHERE revokedAt IS NULL` (optional but recommended; if omitted, rely on application `revokedAt IS NULL` check), and enforce max 5 active per user via application LRU eviction (revoke oldest active on overflow). `synchronize:false`, migration only.

- **FR-003**: System MUST expose `POST /auth/refresh` (public, no `JwtGuard` — bearer is the `refreshToken` itself) accepting `Body {refreshToken?: string}` (`@IsString @Length(64,64) @Matches(/^[0-9a-f]{64}$/)` hex, `@IsOptional()` when cookie present) and fallback `Cookie: <REFRESH_TOKEN_COOKIE_NAME>=<raw>`; at least one source required else `401`. Handler hashes `raw` with `sha256`, does `SELECT RefreshToken WHERE tokenHash=:hash FOR UPDATE` inside `dataSource.transaction` (EntityManager), verifies `found && revokedAt IS NULL && expiresAt > NOW()`, loads `User by userId`, verifies `user exists && user.tokenVersion === payload tokenVersion` if refresh were JWT — for opaque, just `user exists` and `user.tokenVersion` is copied into new `accessToken` (so post `logout-all` old refresh fails because new `accessToken` would carry new `tokenVersion` but refresh path short-circuits: if `user.tokenVersion` was incremented since refresh was issued, old refresh rows are already `revokedAt` via `logout-all`'s bulk revoke, so check `revokedAt IS NULL` suffices; explicit `tokenVersion` equality check on refresh is therefore optional but if implemented, compare `user.tokenVersion` against token issuance snapshot — simplest: treat any `refreshToken` issued before `tokenVersion++` as revoked by the bulk `UPDATE revokedAt`). If `user.emailVerified=false`, still succeed but log `Logger.warn` and set response header `X-Email-Unverified: true`.
  - On success (`RESERVED` equivalent `active`): `UPDATE old SET revokedAt=NOW() WHERE id=:id` (invalidate used token, single-use rotation), `INSERT new RefreshToken {userId, tokenHash=sha256(newRaw), expiresAt=now+7d}`, `sign new accessToken {sub,email,fullName,role,tokenVersion:user.tokenVersion}`, commit, return `200 {accessToken, refreshToken: newRaw}` plus new `Set-Cookie`.
  - On already `revokedAt NOT NULL` (reuse of rotated token) → `401 Invalid or expired refresh token` and **theft detection**: `UPDATE RefreshToken SET revokedAt=NOW() WHERE userId=:userId AND revokedAt IS NULL` (revoke all remaining for that user) and `Logger.warn refresh reuse theft detected userId=:id hashPrefix=:prefix` (hashed prefix 6 chars), count `INCR idempotency:duplicate:skipped:refresh` optional, no new pair.
  - On `not found` or `expiresAt <= NOW()` → `401` without theft revoke, no `UPDATE`, no new pair.
  - All writes via `EntityManager`, no `CACHE_MANAGER` or `client.emit` inside transaction; `Logger` after commit with hash prefix only.

- **FR-004**: System MUST expose `POST /auth/logout` (public, allows anonymous by token) accepting same `{refreshToken}` body or cookie; lookup `tokenHash`, if found and `revokedAt IS NULL` then `UPDATE SET revokedAt=NOW()` (or `manager.update`); if not found or already `revokedAt NOT NULL` then return `200 {message:"Logged out"}` idempotent (`0` rows `200`, anti-enumeration — do not `404`). No `JwtGuard` required (possession proves ownership), but if `Authorization: Bearer` present, optionally assert `currentUser.id === row.userId` else still `200` (do not leak existence). Rate-limited via `RateLimitGuard`.

- **FR-005**: System MUST expose `POST /auth/logout-all` (`@Auth()` / `JwtGuard` required, any role) with empty body `{}` (or `forbidNonWhitelisted`) that atomically increments `User.tokenVersion` (`"tokenVersion" + 1` or `tokenVersion: () => '"tokenVersion" + 1'`) **and** bulk `UPDATE RefreshToken SET revokedAt=NOW() WHERE userId=:userId AND revokedAt IS NULL` inside `dataSource.transaction` (EntityManager, `SELECT User FOR UPDATE` optionally to serialize), returns `200 {message:"All sessions revoked"}`. Subsequent `JwtGuard` fails old `accessToken` (`payload.tokenVersion !== user.tokenVersion → 401`), subsequent `POST /auth/refresh` with any pre-nuke `refreshToken` fails `401` (row already `revokedAt`).

- **FR-006**: System MUST preserve existing `User.tokenVersion` semantics from Phase 16 (`reset-password` already `tokenVersion++` + `passwordChangedAt`). `JwtStrategy.validate` already compares `payload.tokenVersion === user.tokenVersion else 401`. `RefreshToken` rotation MUST embed current `user.tokenVersion` into new `accessToken` so that `reset-password` and `logout-all` implicitly revoke outstanding refresh flows without separate table scan (bulk `revokedAt` is explicit, `tokenVersion` is guard). No schema change to `User` beyond Phase 16.

- **FR-007**: System MUST enforce rate limiting via `RateLimitGuard` (distributed `CACHE_MANAGER` `rl:*` `INCR+EXPIRE` fail-open already) for new endpoints: `POST /auth/refresh 10/hour/IP (+ 10/hour/user when cookie/Bearer identifies user)`, `POST /auth/logout 20/hour/IP`, `POST /auth/logout-all 10/hour/user` (table below), with `ConfigService` overrides `REFRESH_RL_MAX`, `REFRESH_RL_WINDOW_MS=3600000`, `LOGOUT_RL_MAX`, `LOGOUT_ALL_RL_MAX` clamped `>=60000` else fallback + `Logger.warn`; on `429` return `HttpException 429` with `headers { 'Retry-After': ceil(windowMs/1000)='3600', 'X-RateLimit-Limit': String(limit), 'X-RateLimit-Remaining':'0' }` forwarded by `AllExceptionsFilter`; outermost guard order `@UseGuards(RateLimitGuard)` before `JwtGuard`/`ValidationPipe` so `429` path `DataSource.transaction` `0` calls; on `CACHE_MANAGER throw` log `Logger.warn RateLimit Redis fail-open for <routeKey>: <msg>` and allow (`true`), headers may be absent.

  | Endpoint | Limit (default) | Dimension | Window | Guard key |
  |----------|-----------------|-----------|--------|-----------|
  | `POST /auth/refresh` | `10 IP` + `5 per tokenHash` | `ip` (`x-forwarded-for` first) AND `tokenHash 6-prefix` (`sha256` prefix) — both buckets enforced, either `429` before `FOR UPDATE` | `3600000` (`REFRESH_RL_WINDOW_MS`) | `rl:POST /auth/refresh:ip:<ip>` + `rl:POST /auth/refresh:hash:<6prefix>` |
  | `POST /auth/logout` | `20` | `ip` | `3600000` | `rl:POST /auth/logout:ip:<ip>` |
  | `POST /auth/logout-all` | `10` | `user` (`req.user.sub ?? ip`) | `3600000` | `rl:POST /auth/logout-all:user:<sub>` |

- **FR-008**: System MUST handle transport duality: return `refreshToken` in **both** `Set-Cookie` and JSON body on `login` and `refresh` so browser clients use `HttpOnly` cookie and non-browser (`supertest`, Postman, mobile) use `Body.refreshToken`. Cookie name `REFRESH_TOKEN_COOKIE_NAME` (`ConfigService` default `refresh_token`), flags `HttpOnly true`, `Secure = ConfigService REFRESH_TOKEN_COOKIE_SECURE === 'true'` (prod `true`, dev `false` fallback), `SameSite=Strict`, `Path=/auth` (or `/auth/refresh`), `Max-Age= ceil(REFRESH_TOKEN_TTL ms /1000)`. `POST /auth/refresh` and `POST /auth/logout` resolve raw as `dto.refreshToken ?? req.cookies[cookieName] ?? req.signedCookies[cookieName]`; if neither → `401`. Swagger documents `Refresh via Cookie or Body`.

- **FR-009**: System MUST enforce security constraints: `tokenHash` is `sha256` hex always, never store or log `rawRefresh` (log hashed prefix `tokenHash.slice(0,6)` only), `CHECK expiresAt > createdAt` in entity, service also checks `expiresAt > NOW()` (DB + service defense), single-use rotation (`revokedAt` on use), concurrent `refresh` with same hash is single-winner via `FOR UPDATE`, reuse triggers theft revoke-all as per FR-003. `REFRESH_TOKEN_TTL=7d` default (`ConfigService` `parseTtlMs` supports `s/m/h/d`, invalid → `7*24*3600_000` + warn). Nightly purge `DELETE WHERE (revokedAt IS NOT NULL AND revokedAt < NOW() - INTERVAL '7 days') OR (expiresAt < NOW() - INTERVAL '7 days')` (BullMQ or query, `7d` retention per clarification).

- **FR-010**: System MUST read all new config via `ConfigService` from `.env`: `REFRESH_TOKEN_TTL=7d` (or `REFRESH_TOKEN_TTL_MS`), `REFRESH_TOKEN_COOKIE_NAME=refresh_token`, `REFRESH_TOKEN_COOKIE_SECURE=true`, `REFRESH_RL_MAX/REFRESH_RL_WINDOW_MS/LOGOUT_RL_MAX/LOGOUT_ALL_RL_MAX` (optional overrides), plus existing `JWT_SECRET`, `JWT_EXPIRES_IN=15m`, `RESET_TOKEN_TTL`, `REDIS_URL`, `RABBITMQ_URL`. Never hardcode hosts/secrets/URLs; never commit `.env`.

- **FR-011**: System MUST document and Swagger-annotate each throttled auth route with `@ApiResponse 401`, `@ApiResponse 429`, request/response DTOs `RefreshTokenDto` (`@IsString @Length(64,64) @Matches(/^[0-9a-f]{64}$/) @IsOptional()` when cookie allowed) and `LoginDto` unchanged, reuse global `ValidationPipe` `whitelist+forbidNonWhitelisted+transform`; errors via Nest `UnauthorizedException 401`, `BadRequestException 400`, `TooManyRequests 429` serialized by global `AllExceptionsFilter` as `{statusCode,message,timestamp}` plus `Retry-After` headers.

- **FR-012**: System MUST respect module boundaries and code documentation per `AGENTS.md` §3/§8: `AuthService` owns `RefreshToken` business API (`login` extension, `refresh`, `logout`, `logoutAll`), `UsersService` owns `User` CRUD, no other module `@InjectRepository(RefreshToken)`; new files under `src/modules/auth/entities/refresh-token.entity.ts`, `dto/refresh-token.dto.ts`, `auth.service.ts` extensions, `auth.controller.ts` new routes; every new `Service`/`Controller`/`Entity` gets class-level `/** This service is responsible for ... It handles ... and enforces ... */`, every public method `/** ... @param @returns @throws */` with `@throws UnauthorizedException` etc., every complex condition (`if !found || revokedAt || expiresAt<=now`, `available = stock - reservedAmount` not touched here) has inline `//` intent comment; use injected `Logger`, not `console.log`; `synchronize:false`.

### Key Entities

- **RefreshToken (new, PostgreSQL authoritative)**: `id uuid PK (@PrimaryGeneratedColumn('uuid'))`, `userId uuid FK → User.id ON DELETE CASCADE @Index` (`@ManyToOne` optional, `userId` column), `tokenHash varchar(255) @Index` (`sha256` hex of `rawRefresh`, `64` chars), `expiresAt timestamptz` (`now + REFRESH_TOKEN_TTL`, `CHECK expiresAt > createdAt`), `revokedAt timestamptz nullable` (`NULL` = active, set on rotation/logout/logout-all/theft), `createdAt timestamptz @CreateDateColumn`, `updatedAt timestamptz @UpdateDateColumn` optional. Indexes: `(userId)`, `(tokenHash)`, `(expiresAt)`, `(userId, expiresAt)`, partial unique `(tokenHash) WHERE revokedAt IS NULL` (optional). No Redis `tokenHash` storage — PG is source.

- **User (altered Phase 16, reused)**: Existing `User` with `tokenVersion int default 0` (global JWT revocation nuke), `passwordChangedAt timestamptz nullable`, `provider`, `googleId`, `phoneNumber` etc. No new columns for Phase 17; `RefreshToken.userId` FK. `tokenVersion` increment on `reset-password` and `logout-all` invalidates all outstanding `accessToken` (`JwtStrategy` checks `payload.tokenVersion === user.tokenVersion`) and outstanding `RefreshToken` (bulk `revokedAt` + optional `tokenVersion` guard).

- **RateLimit Redis Keys (ephemeral)**: `rl:POST /auth/refresh:ip:<ip> → count TTL 3600`, `rl:POST /auth/logout:ip:<ip> → count`, `rl:POST /auth/logout-all:user:<sub> → count`, `idempotency:duplicate:skipped:refresh` (`INCR EX 86400` if theft counter enabled). Fail-open on Redis down.

---

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001 (Login issues refresh)**: `POST /auth/login {email,password}` with valid creds returns `200 {accessToken, refreshToken}` where `refreshToken` is `64` hex, `accessToken` decodes `{sub,email,fullName,role,tokenVersion}` `exp` within `900±5s`, DB row `tokenHash=sha256(refreshToken)` `expiresAt=now+7d ±5s` `revokedAt NULL`, `Set-Cookie` header `refresh_token=<same raw>; HttpOnly; Max-Age=604800` present; invalid creds `401` and `SELECT count(*) FROM refresh_token WHERE userId=:id` `0` for that attempt (100% of login tests pass).

- **SC-002 (Refresh rotation single-use)**: For a valid `rawRefresh`, first `POST /auth/refresh {refreshToken: rawRefresh}` returns `200 {accessToken, refreshToken: newRaw}` with new `accessToken exp 15m` and `newRaw 64 hex != old`, DB old row `revokedAt NOT NULL` new row `revokedAt NULL`, second use of **old** `rawRefresh` returns `401` and does not create another row, `GET /order` with old `accessToken 401` but with new `accessToken 200` (100% of rotation/reuse tests pass).

- **SC-003 (Theft detection concurrent single-winner)**: Two concurrent `POST /auth/refresh` with same `rawRefresh` via `Promise.all` result in exactly one `200` (with rotation) and one `401`, DB has exactly one new active row (`active count 1`), no double `accessToken` from same old hash, and with theft option enabled, the `401` branch bulk revokes all remaining active `RefreshToken` for that user and logs `warn` with hash prefix, verified by `SELECT count(*) active` after both.

- **SC-004 (Expiry and revocation)**: Calling `POST /auth/refresh` with `expiresAt <= NOW()` (inserted `expiresAt = NOW() - 1s` fixture) returns `401`; calling with `revokedAt NOT NULL` (after `logout`) returns `401`; calling with unknown hash returns `401`; none mutates `Inventory`/`Order`/`Reservation` (`UPDATE inventory 0`).

- **SC-005 (Logout idempotent and logout-all nuke)**: `POST /auth/logout {refreshToken: r1}` active `r1` → `200` `r1 revokedAt NOT NULL` `r2 active`; second `POST /auth/logout {r1}` → `200` idempotent `active count` unchanged; `POST /auth/logout-all` (Bearer) → `200` `User.tokenVersion 0→1` `active 0` for that user, `POST /auth/refresh r2 401`, `GET /order` with old `accessToken 401` (JwtGuard tokenVersion mismatch), new `POST /auth/login → 200` works with `tokenVersion 1`.

- **SC-006 (Reset-password revokes refresh)**: After `POST /auth/reset-password {email, token, newPassword}` succeeding (`tokenVersion 0→1`), any pre-reset `refreshToken` returns `401` on `POST /auth/refresh` (bulk revoke or tokenVersion guard), proving global revocation covers refresh (verified by reset-password → refresh sequence).

- **SC-007 (Transport duality)**: `POST /auth/refresh` with `Body {refreshToken}` `200`, with `Cookie: refresh_token=<raw>` and `{}` body `200` (same rotation), with neither `401`; `POST /auth/login` and `POST /auth/refresh` both set `Set-Cookie: refresh_token=...; HttpOnly; Secure; SameSite=Strict; Path=/auth` (assert header), Swagger documents `Refresh via Cookie or Body`.

- **SC-008 (Rate limiting and no regression)**: Exceeding `POST /auth/refresh` `11/10` per hour from same IP returns `429` with `Retry-After: 3600` and `X-RateLimit-*`; with Redis `FLUSHDB` or `CACHE_MANAGER` `throw` → request still `200` with `Logger.warn` (fail-open); `grep -c "client.emit" src/modules/auth/auth.service.ts` `0` inside any `dataSource.transaction`, `grep -c "FOR UPDATE" src/modules/auth/auth.service.ts` `>=1`; `npm run build` passes, `npm run test -- --runInBand` (unit + integration real PG + E2E `supertest`) passes `synchronize:false`, `AllExceptionsFilter` forwards `401/429`, no `stock`/`reservedAmount` mutation from auth paths.

---

## Assumptions

- `JWT_EXPIRES_IN` remains `15m` (Phase 16) and `JWT_SECRET` unchanged; `accessToken` shape `{sub,email,fullName,role,tokenVersion}` remains.
- `User.tokenVersion` increment is already atomic `UPDATE ... tokenVersion = "tokenVersion" + 1` inside `reset-password` transaction (Phase 16) — Phase 17 reuses same pattern for `logout-all`.
- `crypto.randomBytes(32).toString('hex')` `sha256` hashing for `rawRefresh` matches `PasswordResetToken` pattern (already audited).
- `cookie-parser` middleware already enabled or will be added to `main.ts`/`app.module.ts` to populate `req.cookies`; if not, fallback to parsing `req.headers.cookie`.
- `REFRESH_TOKEN_TTL` default `7d` (`604800000ms`); `parseTtlMs` already handles `s/m/h/d` for `RESET_TOKEN_TTL` — extend to `d`.
- Login does **not** invalidate prior `RefreshToken` rows — multiple concurrent sessions per user are allowed (different devices). Diverges from `PasswordResetToken` single-active invalidation.
- `POST /auth/logout` is `200` anti-enumeration even when `tokenHash` not found — same as `forgot-password` `200` — to prevent hash oracle.
- Theft detection revoke-all on reuse is enabled in V1 (per `docs/plan.md` §17.5); if product prefers log-only, the bulk `UPDATE` is a one-line toggle and spec already documents both.
- `synchronize:false` remains; `RefreshToken` delivered via migration `17xxxxxxxxxx-CreateRefreshToken` (never auto-sync), seed untouched.
- Existing `RateLimitGuard` `CACHE_MANAGER` `createKeyv` `REDIS_URL` shared with `BullMQ` (Phase 10) — no new Redis client.
- E2E `supertest` uses real PG 17 `docker-compose` when available, else mocked `DataSource` unit; `--runInBand` for `FOR UPDATE` determinism.
- `POST /auth/refresh` is not `JwtGuard` protected — `refreshToken` is the credential; `POST /auth/logout-all` is `JwtGuard` protected — `accessToken` proves ownership for global nuke.

---

## Dependencies

- Phases 0–16 modules: `AuthModule` (`AuthService`, `JwtGuard`, `RateLimitGuard`, `UsersService`), `Users` entity, `PasswordResetToken`/`OtpVerification` (reference but not mutated), `AppModule` infra `TypeOrmModule` global `DataSource`, `JwtModule`, `CacheModule` (`CACHE_MANAGER` `createKeyv`), `ConfigModule`, `BullModule` shared `REDIS_URL`, global `ValidationPipe`/`AllExceptionsFilter`/`Logger`.
- Config `ConfigService` keys: `JWT_SECRET`, `JWT_EXPIRES_IN`, `REFRESH_TOKEN_TTL`, `REFRESH_TOKEN_COOKIE_NAME`, `REFRESH_TOKEN_COOKIE_SECURE`, `REFRESH_RL_MAX`, `REDIS_URL`, `RABBITMQ_URL` (not used here but present).
- External: `bcrypt 10`, `passport-jwt`, `passport-google-oauth20` (Phase 16), `ioredis` via `cache-manager`/`bullmq`.

---

## Out of Scope (this phase)

- Changing checkout from cart-only to explicit `items[]` or changing `Order`/`Reservation` state machines — Phase 17 is auth-only.
- New `Payment` Stripe, `EmailVerificationToken`, `Dashboard` RBAC, `Client Idempotency-Key` header dedup — reuse `tokenVersion`/`status` guard pattern only.
- Refresh via sliding-window extension without rotation (keep single-use rotation).
- Device fingerprint binding beyond `User-Agent` logging (future).
- Remember-me `30d` vs `7d` per-client toggle (use same `7d` TTL for all, prioritize spec).
- Google OAuth provider `refresh_token` rotation (Google `refresh_token` stored in future `UserOAuthAccount` table, not here).
- Persisted `ProcessedEvent` dedup table beyond `RefreshToken.revokedAt` + `tokenHash` partial unique — V1 PG `revokedAt` + `FOR UPDATE` suffices.
- Real SMTP/SES send in CI — use `NoopEmailProvider` pattern if needed; auth rotation tests assert `200` not network.

---

## Clarifications

### Session 2026-09-23 (Phase 17 kickoff — decisions from `docs/plan.md` §17.3-17.5, prior Phase 16 Q&A)

- Q: Opaque random `RefreshToken` vs JWT `refresh_token` with `jti`? → **A: Opaque random `crypto.randomBytes(32)` + `sha256` hash stored (same as `PasswordResetToken`).** Rejected JWT refresh — cannot revoke individually without `tokenVersion++` nuking all sessions; opaque allows selective revocation and single-use rotation with low audit surface.
- Q: Refresh transport — `Authorization: Bearer` vs body vs `HttpOnly` cookie? → **A: Dual — return `refreshToken` in both `Set-Cookie: refresh_token` (`HttpOnly`, `Secure`, `SameSite=Strict`, `Path=/auth`, `Max-Age=604800`) and JSON `{refreshToken}`; accept either `Body.refreshToken` or `Cookie.refresh_token` on `POST /auth/refresh`/`logout` (body precedence, documented `Refresh via Cookie or Body`).** Avoids forcing browser `HttpOnly` vs non-browser `Postman` choice.
- Q: Reuse of already-rotated `refreshToken` — `401` only or also revoke all for theft? → **A: `401 Invalid or expired refresh token` + revoke all remaining `RefreshToken` for that `userId` (`SET revokedAt=NOW() WHERE userId=:id AND revokedAt IS NULL`) + `Logger.warn refresh reuse theft detected`.** Protects against token database leak replay.
- Q: `logout` idempotency — `401` if already revoked or `200`? → **A: `200 {message:"Logged out"}` idempotent — second `logout` with same hash returns `200` with `0` `UPDATE` rows, anti-enumeration (unknown hash also `200`), matching Phase 12 `COMPLETED→COMPLETED 200` policy for retry safety.**
- Q: `logout-all` scope — `tokenVersion++` nukes `accessToken` only, or also `RefreshToken` rows? → **A: Both — `tokenVersion++` + bulk `UPDATE RefreshToken SET revokedAt=NOW() WHERE userId=:id AND revokedAt IS NULL` atomically, so old `accessToken` fails `JwtStrategy` and old `refreshToken` fails `revokedAt` check.**

### Session 2026-09-23 (Clarification)

- Q: Should Google OAuth callback also issue a refresh token like `POST /auth/login`? → A: Yes — `GET /auth/google/callback` (and `GET /auth/google/link` when issuing new JWT) MUST return `200 {accessToken, refreshToken}` + `Set-Cookie: refresh_token` with same `RefreshToken` persistence, rotation, and revocation semantics as password login.
- Q: Should the system cap active refresh tokens per user? → A: Yes — max 5 active `RefreshToken` per user; on creation when 5 active exist, revoke oldest (`ORDER BY createdAt ASC LIMIT 1 SET revokedAt=NOW()` with `FOR UPDATE` on that row) before inserting new (LRU eviction) to bound table growth.
- Q: Should `POST /auth/refresh` enforce per-tokenHash limit in addition to per-IP? → A: Yes — dual buckets: `10/h per IP` (`rl:POST /auth/refresh:ip:<ip>`) AND `5/h per tokenHash` (`rl:POST /auth/refresh:hash:<6prefix>`); either bucket exceeding returns `429` before `FOR UPDATE`.
- Q: What retention before purge of expired/revoked `RefreshToken` rows? → A: Purge `7 days` after `expiresAt` or `revokedAt` (match TTL window) via nightly job `DELETE WHERE (revokedAt IS NOT NULL AND revokedAt < NOW() - INTERVAL '7 days') OR (expiresAt < NOW() - INTERVAL '7 days')`.
- Q: Should `POST /auth/refresh` be blocked when `User.emailVerified=false`? → A: Allow — refresh succeeds even if `emailVerified=false` but system logs `Logger.warn refresh unverified email userId=:id` and returns response header `X-Email-Unverified: true` for observability (client may prompt verification).

