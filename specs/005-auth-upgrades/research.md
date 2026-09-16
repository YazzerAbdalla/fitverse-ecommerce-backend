# Research: Auth Upgrades (Phase 16)

**Feature**: `005-auth-upgrades` | **Date**: 2026-09-15 | **Spec**: [spec.md](./spec.md) | **Plan**: [plan.md](./plan.md)

## Decisions

### D1 — Opaque crypto token vs JWT for password reset

**Decision**: Opaque random token `crypto.randomBytes(32).toString('hex')` (256 bits) + sha256 hash storage; no JWT reset token.  
**Rationale**: Simpler revocation (single `usedAt` row), no JWT secret rotation risk, constant-time not needed for hash lookup, shorter audit surface. Matches `docs/plan.md` §16.1.2 rejection of JWT alternative.  
**Alternatives considered**: JWT `reset_jwt` (would require JWT verify, expiry via `exp`, deny-list for revocation — heavier). Rejected per plan.

### D2 — Store ONLY sha256 hash, never rawToken

**Decision**: `tokenHash = crypto.createHash('sha256').update(rawToken).digest('hex')` indexed; rawToken returned once to caller, never logged (only prefix at debug).  
**Rationale**: Breach containment — DB dump does not yield usable tokens; sha256 cheap vs bcrypt (no need for slow hash on high-entropy token).  
**Alternatives considered**: bcrypt hash (slower, not needed for 256-bit entropy; sha256 lookup via index is O(1)). Chosen sha256 as in FR-002.

### D3 — Single-winner concurrency via `FOR UPDATE` + prior-token invalidation

**Decision**: `requestPasswordReset` wraps `UPDATE priorTokens SET usedAt=NOW() WHERE userId AND usedAt IS NULL AND expiresAt > NOW()` + `INSERT` new row in one `dataSource.transaction`. `resetPassword` does `SELECT ... FOR UPDATE` on `PasswordResetToken` where `tokenHash` + `userId`, checks `expiresAt > now` + `usedAt IS NULL`, then `bcrypt.hash` + `User.password` + `passwordChangedAt=NOW()` + `token.usedAt=NOW()` + invalidate others, all in same `EntityManager` transaction. Concurrent same-token `reset-password` yields one 200 one 400 (SC-003).  
**Rationale**: Mirrors Phase 3 `Inventory FOR UPDATE` pattern; prevents double-use and phantom token. No Redis/RabbitMQ I/O inside tx (commit → publish per FR-015).  
**Alternatives considered**: Optimistic version column (would still need retry); advisory lock (heavier). Pessimistic row lock simplest.

### D4 — JWT revocation after reset via `passwordChangedAt` (Q3)

**Decision**: Add `User.passwordChangedAt timestamptz nullable, @Index`. On `resetPassword` success set `passwordChangedAt = NOW()`. `JwtStrategy.validate(payload)` fetches user and rejects if `payload.iat * 1000 < user.passwordChangedAt.getTime()` (or token `iat < passwordChangedAt`). Alternative token version increment (`tokenVersion`) equivalent. Per Q3 answer B — revoke all.  
**Rationale**: Stateless JWT needs lightweight revocation; `passwordChangedAt` covers all prior tokens without deny-list storage; short TTL alone insufficient per user requirement. No extra table.  
**Alternatives considered**: Redis deny-list (needs storage/cleanup); no revocation (rejected per Q3); per-token jti list (heavier). `passwordChangedAt` chosen.

### D5 — WhatsApp OTP generation + hashed storage + Redis+PG fallback (Q4)

**Decision**: OTP `crypto.randomInt(100000,999999).toString()` (not `Math.random`), hash `sha256`, store **both** in Redis `otp:whatsapp:<phone>` TTL 300s and in PostgreSQL `OtpVerification` (codeHash, expiresAt, attempts, verifiedAt) in same flow. Primary verify via Redis (`attempts` increment, delete on success/3 fails, cooldown 60s via `SET NX EX`). When Redis down, fallback to DB row: check `expiresAt > NOW()` and `attempts < OTP_MAX_ATTEMPTS`, increment attempts, set `verifiedAt` on success, delete/invalidate on limits.  
**Rationale**: Redis is cheap TTL but ephemeral; fallback keeps login available when Redis blips (Q4 answer B). PG row also provides audit. Constitution I exception scoped to ephemeral OTP, documented in ADR.  
**Alternatives considered**: Redis-only strict 503 (rejected per Q4), PG-only (heavier TTL polling). Hybrid primary+fallback chosen.

### D6 — WhatsApp provider abstraction (Noop for test)

**Decision**: `interface WhatsAppProvider { sendOtp(phoneNumber, otp, expiresInMinutes): Promise<{messageId}> }` with `NoopWhatsAppProvider` (dev/test, captures OTP in-memory for E2E), `TwilioWhatsAppProvider`, `MetaCloudWhatsAppProvider` (prod). Selected via `WHATSAPP_PROVIDER` env (`noop|twilio|meta`). Never hit real API in tests; mock via provider.  
**Rationale**: Keeps business logic testable, swaps provider without code change; follows plan §16.2 provider abstraction.  
**Alternatives considered**: Direct Twilio SDK everywhere (would make tests flaky, no swapping). Abstraction chosen.

### D7 — Google OAuth via `passport-google-oauth20`, auto-link verified email (Q1), `password` nullable, JSON response (Q5)

**Decision**: Add `passport-google-oauth20` + `@types/passport-google-oauth20`. `GoogleStrategy extends PassportStrategy(Strategy,'google')` scope `profile email`, `state: true` CSRF, `GOOGLE_CLIENT_ID/SECRET/CALLBACK_URL` via `ConfigService`. `AuthService.handleGoogleLogin(profile)` logic: if `googleId` exists → return user; else if verified `email` exists (`profile.emails[0].verified===true`) → link `googleId` to existing user (auto-link per Q1 A); else create `User { email, firstName, lastName, googleId, provider:'google', password:null }`. `password` column made `nullable`; `googleId` partial unique `WHERE googleId IS NOT NULL`. Callback `GET /auth/google/callback` returns `200 { accessToken }` JSON per Q5 A (no redirect); `GET /auth/google/link` with `JwtGuard` for authenticated linking.  
**Rationale**: Matches plan §16.3; auto-link verified email is V1 simplest; JSON response is API-clean (redirect can be added later without breaking JSON).  
**Alternatives considered**: Separate `UserOAuthAccount` table (deferred to multi-provider future per plan §16.3.2); require password confirmation before link (Q1 B/C/D rejected per user choice A); redirect to `FRONTEND_URL` (Q5 B/C rejected per Q5 A).

### D8 — Rate limiting via Redis `INCR+EXPIRE` / `SET NX EX`, fail-open

**Decision**: Custom `RateLimitGuard` or `ThrottlerGuard` reusing `CacheModule` (`@nestjs/cache-manager` + `@keyv/redis`). Limits per FR-014: `forgot-password 5/h/IP +3/h/email`, `reset-password 10/h/IP`, `otp/request 5/h/phone+10/h/IP cooldown 60s`, `otp/verify 10/h/phone`, `google/callback 20/h/IP`, `login/register 10/h/IP`. Use atomic `INCR` + `EXPIRE` or `SET NX EX` counters; on Redis unavailable → fail-open with `Logger.warn` + metric, request proceeds (availability over strict limit per FR-014). Publish `429` with `Retry-After`. No extra `@nestjs/throttler` unless proven lighter.  
**Rationale**: Redis is already infra for cache; fail-open keeps auth available when Redis blips; does not compromise inventory correctness (constitution Additional Constraints).  
**Alternatives considered**: Fail-closed on Redis down (would DOS auth when Redis blips — rejected); DB-backed limiter (heavier). Fail-open chosen.

### D9 — Optional `JwtStrategy` (Passport JWT) migration to enforce `passwordChangedAt`

**Decision**: Add `jwt.strategy.ts extends PassportStrategy(Strategy,'jwt')` with `secretOrKey: ConfigService.get('JWT_SECRET')`, `jwtFromRequest: ExtractJwt.fromAuthHeaderAsBearerToken()`. `validate(payload)` loads user via `UsersService.findUserByEmail` or `findById`, checks `payload.iat < passwordChangedAt` then returns user. Keep `LocalStrategy` unchanged (but update `userValidation` to return `null` when `User.password IS NULL` and strategy is local — pure OAuth must use Google). `JwtAuthGuard extends AuthGuard('jwt')` optional wrapper; existing manual `JwtGuard` can be kept or replaced — research concludes migration is low-risk.  
**Rationale**: Centralizes JWT verification + revocation check; follows Nest Passport best practice; enables `AuthGuard('jwt')` reuse for `google/link`.  
**Alternatives considered**: Patch manual `JwtGuard.verify` inline (duplicates Passport logic, harder to test). `JwtStrategy` preferred.

### D10 — Async notifications after DB commit (post-commit publish)

**Decision**: After `forgot-password` and `otp/request` DB commits, publish event `PasswordResetRequested { userId, email, tokenHash, expiresAt }` / `OtpRequested { phone, otp }` (raw OTP only in publish, not stored) via RabbitMQ (`@nestjs/microservices` RMQ) or BullMQ job; worker delegates to email service / `WhatsAppProvider`. Tests assert event published, not actual delivery; no provider I/O inside transaction (constitution Additional Constraints).  
**Rationale**: Keeps transactional path short, async failures do not roll back committed token/OTP; matches `docs/architecture/data-flow.md` commit-then-publish.  
**Alternatives considered**: Send directly inside tx (would couple infra failure to business failure — rejected).

### D11 — Login choice and deferred email OTP (Q2)

**Decision**: Registration `POST /auth/register` still **requires** `password` (`MinLength 4` existing, `MinLength 8` for reset). Login offers **choice**: `POST /auth/login` (email+password via `LocalAuthGuard`) **OR** `POST /auth/otp/request|verify` with `purpose=login` (WhatsApp phone, issues same JWT `{sub,email,fullName,role}`), discovered via Swagger. `purpose` enum in V1 = `login|verify_phone` only; `reset_password` via OTP and email OTP deferred. Document deferred email OTP in `docs/plan.md` §16.8 Future.  
**Rationale**: Per Q2 custom answer — Amazon-style passwordless phone login without weakening registration; email OTP future keeps scope bounded.  
**Alternatives considered**: OTP for `reset_password` in V1 (adds link between OTP and recovery token — deferred); email OTP in V1 (doubles provider surface — deferred).

## Open Risks

- `GOOGLE_CLIENT_SECRET` rotation needs env reload without code change — mitigate via `ConfigService` read, no restart caching.
- `User.passwordChangedAt` index needed for JWT check on every request — low-cardinality but hot path; add `@Index` and ensure `validate()` caches briefly if needed (research D9).
- Twilio/Meta credentials in `.env` — never committed; CI uses Noop.

