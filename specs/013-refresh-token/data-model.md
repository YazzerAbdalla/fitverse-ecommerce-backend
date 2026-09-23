# Data Model — Refresh Token Rotation — Phase 17

**Feature**: `013-refresh-token` | **Date**: 2026-09-23 | **Spec**: [spec.md](./spec.md) | **Plan**: [plan.md](./plan.md)

## Entities

### RefreshToken (new, `auth` domain, PostgreSQL authoritative)

**Table**: `RefreshToken` (`@Entity('RefreshToken')` or `refresh_token` per TypeORM naming — keep `camelCase` per `AGENTS.md`)

| Column | Type | Constraints | Notes |
|--------|------|-------------|-------|
| `id` | `uuid` | `@PrimaryGeneratedColumn('uuid')` | PK |
| `userId` | `uuid` | `FK → User.id ON DELETE CASCADE`, `@Index('IDX_refresh_token_userId')` | Owner; cascade delete when user removed |
| `tokenHash` | `varchar(255)` | `@Index('IDX_refresh_token_tokenHash')`, `NOT NULL` | `sha256` hex `64` chars of `rawRefresh`; never store `raw` |
| `expiresAt` | `timestamptz` | `NOT NULL`, `@Check('"expiresAt" > "createdAt"')`, `@Index('IDX_refresh_token_expiresAt')` | `now + REFRESH_TOKEN_TTL(7d)`; `CHECK` enforces future |
| `revokedAt` | `timestamptz` | `nullable`, default `NULL` | `NULL` = active; set `NOW()` on rotation / `logout` / `logout-all` / theft; no `CHECK` beyond service checks |
| `createdAt` | `timestamptz` | `@CreateDateColumn`, `NOT NULL` | Insertion time |
| `updatedAt` | `timestamptz` | `@UpdateDateColumn`, `NOT NULL` | Last mutation (`revokedAt` set) |

**Indexes**:
- `IDX_refresh_token_userId` on `userId`
- `IDX_refresh_token_tokenHash` on `tokenHash`
- `IDX_refresh_token_expiresAt` on `expiresAt`
- `IDX_refresh_token_userId_expiresAt` composite `(userId, expiresAt)`
- Partial unique `UQ_refresh_token_hash_active UNIQUE(tokenHash) WHERE revokedAt IS NULL` — optional but recommended to prevent duplicate active hash (collision prob negligible, `23505` retry once)

**Checks**:
- `@Check('"expiresAt" > "createdAt"')` → `CHK_refresh_token_expires_gt_createdAt`
- App-level `expiresAt > NOW()` on read (DB + service defense per FR-009)

**Relations**:
- `@ManyToOne(() => User, user => user.refreshTokens, { onDelete: 'CASCADE' })` + `@JoinColumn({ name: 'userId' })` on `RefreshToken`; inverse `@OneToMany(() => RefreshToken, rt => rt.user)` on `User` (optional, not required for navigation — can be unidirectional as `PasswordResetToken`).

**Invariants** (enforced DB + service):
- `tokenHash` is `sha256` hex `64` chars (`@Matches(/^[0-9a-f]{64}$/)` on DTO, `LENGTH(tokenHash)=64` optional `CHECK`).
- `revokedAt IS NULL` ↔ active; `revokedAt NOT NULL` → `401` on `refresh` reuse branch → theft revoke-all.
- Cap 5 active: service `SELECT count(*) WHERE userId=:id AND revokedAt IS NULL` `>=5` → `FOR UPDATE` oldest `SELECT id WHERE userId=:id AND revokedAt IS NULL ORDER BY createdAt ASC LIMIT 1 FOR UPDATE` → `UPDATE revokedAt=NOW()` before `INSERT new`.

### User (existing, Phase 16, read-only this phase)

**No schema change** beyond Phase 16 `1755900000000-AuthUpgradesUserAndResetToken` (`tokenVersion int default 0`, `passwordChangedAt timestamptz nullable`, `phoneNumber`, `googleId`, `provider` enum `local|google`, `email @Unique`, `password nullable`, `emailVerified bool`). `RefreshToken.userId` FK references this.

**Reused semantics**:
- `tokenVersion int default 0` — global JWT revocation nuke. `JwtStrategy.validate` compares `payload.tokenVersion === user.tokenVersion else 401`. Incremented on `reset-password` (existing) and `logout-all` (new) via `userRepo.update(id, { tokenVersion: () => '"tokenVersion" + 1' })` inside `DataSource.transaction`.
- No `refreshTokenVersion` column — `User.tokenVersion` suffices (D5).

## Lifecycle & State Transitions

```text
Login (POST /auth/login OR GET /auth/google/callback)
  → crypto.randomBytes(32).toString('hex') raw 64
  → tokenHash = sha256(raw) 64 hex
  → expiresAt = now + REFRESH_TOKEN_TTL(7d) (parseTtlMs d/h/m/s)
  → cap 5 LRU: if active>=5 revoke oldest FOR UPDATE
  → INSERT RefreshToken {userId, tokenHash, expiresAt, revokedAt NULL}
  → sign accessToken {sub,email,fullName,role,tokenVersion:user.tokenVersion} 15m
  → Set-Cookie: refresh_token=raw; HttpOnly; Secure; SameSite=Strict; Path=/auth; Max-Age=604800
  → return 200 {accessToken, refreshToken: raw}

Refresh (POST /auth/refresh {refreshToken?} OR Cookie: refresh_token)
  raw = dto.refreshToken ?? req.cookies[cookieName] ?? parse req.headers.cookie
  if !raw → 401
  tokenHash = sha256(raw)
  BEGIN DataSource.transaction
    SELECT RefreshToken WHERE tokenHash=:hash FOR UPDATE
    if !found → ROLLBACK 401 Invalid or expired refresh token (no userId, no theft nuke)
    load User where id=row.userId
    if !user → ROLLBACK 401
    if row.revokedAt NOT NULL → ROLLBACK 401 + after-rollback THEFT: UPDATE RefreshToken SET revokedAt=NOW() WHERE userId=:userId AND revokedAt IS NULL + Logger.warn + INCR (outside tx or after)
    if row.expiresAt <= NOW() → ROLLBACK 401 (expired, no theft nuke)
    // active branch
    UPDATE old SET revokedAt=NOW() WHERE id=:row.id
    newRaw = crypto.randomBytes(32).toString('hex')
    newHash = sha256(newRaw)
    newExpiresAt = now + 7d
    cap 5 LRU again before INSERT? (count includes old being revoked, so +1 active → check count after revoke; if still >=5 revoke oldest of remaining)
    INSERT new RefreshToken {userId, tokenHash=newHash, expiresAt=newExpiresAt}
    sign newAccessToken {sub,email,fullName,role,tokenVersion:user.tokenVersion}
  COMMIT
  if user.emailVerified === false → res.setHeader('X-Email-Unverified','true') + Logger.warn
  return 200 {accessToken: newAccessToken, refreshToken: newRaw} + Set-Cookie: refresh_token=newRaw

Logout (POST /auth/logout {refreshToken?} OR Cookie)
  raw = dto.refreshToken ?? cookie
  if !raw → 200 (anti-enum, no DB) — spec says 200 even if not found to prevent oracle; alternative: 200 with message
  tokenHash = sha256(raw)
  UPDATE RefreshToken SET revokedAt=NOW() WHERE tokenHash=:hash AND revokedAt IS NULL
  // 0 rows if not found/already revoked → still 200
  return 200 {message:"Logged out"}

LogoutAll (POST /auth/logout-all Bearer accessToken @Auth)
  BEGIN DataSource.transaction
    SELECT User WHERE id=:currentUserId FOR UPDATE (optional serialize)
    UPDATE User SET tokenVersion = tokenVersion + 1 WHERE id=:currentUserId
    UPDATE RefreshToken SET revokedAt=NOW() WHERE userId=:currentUserId AND revokedAt IS NULL
  COMMIT
  return 200 {message:"All sessions revoked"}
  // subsequent JwtGuard: payload.tokenVersion !== user.tokenVersion → 401
  // subsequent refresh with any old hash → revokedAt NOT NULL → 401

Purge (nightly)
  DELETE FROM refresh_token WHERE (revokedAt IS NOT NULL AND revokedAt < NOW() - INTERVAL '7 days') OR (revokedAt IS NULL AND expiresAt < NOW() - INTERVAL '7 days')
```

## Validation Rules (DTO)

- `RefreshTokenDto.refreshToken?: string` — `@IsString() @Length(64,64) @Matches(/^[0-9a-f]{64}$/) @IsOptional()` when cookie allowed; `POST /auth/refresh` at least one source required else `401` (not `400` — spec says `401 Invalid or expired` if both missing to avoid distinguishing).
- `LoginDto` unchanged (`email`, `password`) — still `POST /auth/login` accepts `{email,password}`; response now `{accessToken, refreshToken}` not just `accessToken`.
- `LogoutDto` same as `RefreshTokenDto` (reuse).
- Global `ValidationPipe` `whitelist+forbidNonWhitelisted+transform` rejects unknown fields `400`.

## Indexes & Constraints Summary

- `FK_refresh_token_userId` `ON DELETE CASCADE`
- `IDX_refresh_token_userId`, `IDX_refresh_token_tokenHash`, `IDX_refresh_token_expiresAt`, `IDX_refresh_token_userId_expiresAt`
- `CHK_refresh_token_expires_gt_createdAt` `(expiresAt > createdAt)`
- `UQ_refresh_token_hash_active` partial unique `tokenHash WHERE revokedAt IS NULL` (optional)
- No `available = stock - reservedAmount` here — auth touches zero inventory; `Inventory CHECK`s remain per Phase 1.

## Idempotency & Concurrency

- `POST /auth/refresh` single-winner via `SELECT ... FOR UPDATE where tokenHash=:hash` — second `Promise.all` sees `revokedAt NOT NULL` after first commits → `401` theft branch, no double `INSERT new`.
- `POST /auth/logout` idempotent `200` — `UPDATE ... WHERE revokedAt IS NULL` `0` rows on second call → `200`.
- `POST /auth/logout` vs `refresh` race: `FOR UPDATE` row lock serializes `refresh` transaction with `UPDATE WHERE revokedAt IS NULL` in `logout`; loser sees `revokedAt NOT NULL → 401` (refresh) or `0` rows `200` (logout).
- Cap 5 LRU uses `FOR UPDATE` on oldest row to avoid double-eviction under concurrent logins.

## Scale & Retention

- Active set per user bounded to 5 (D6) → max rows `5 * users`; purge `7d` keeps audit 7d beyond expiry/revocation.
- `RefreshToken` not in Redis/RabbitMQ truth — `RateLimitGuard` `rl:*` is limiter cache only.
