# Feature Specification: Auth Upgrades — Forgot Password, Recovery Token, WhatsApp OTP, Google OAuth

**Feature Branch**: `005-auth-upgrades`  
**Created**: 2026-09-15  
**Status**: Draft  
**Input**: User description: "start the auth upgrade phase in the docs/plan.md Phase 16 — forgot password, recovery token, WhatsApp OTP, Google OAuth"

## Clarifications

### Session 2026-09-15

- Q: When a Google OAuth login arrives for an email that already exists as a local (password) account, how should the system link the accounts? → A: Auto-link if Google email is verified — if verified_email true, auto-link googleId to existing local user and issue JWT (no extra password/OTP step in V1).
- Q: Which WhatsApp OTP purposes must be supported and what is the login UX? → A: Registration still requires password (traditional). Login offers two choices: password OR WhatsApp OTP (phone) — Amazon-style passwordless. WhatsApp OTP in V1 supports purpose=login (issues JWT) and purpose=verify_phone (marks phoneVerified). Email OTP is deferred to a future phase; reset_password via OTP is out of scope for V1 (use email recovery token instead). Write deferred email OTP to plan.md as future work.
- Q: After a successful password reset, should existing JWTs be invalidated? → A: Yes — revoke all prior JWTs on reset (force re-login on all devices). Implement via passwordChangedAt/ token version check, not just short TTL.
- Q: If Redis is unavailable during OTP verify, should system fallback to PostgreSQL audit? → A: Yes — fallback to PostgreSQL OtpVerification row when Redis is down (DB becomes source of truth in degraded mode), instead of hard 503.
- Q: Should Google OAuth callback return JSON or redirect? → A: JSON — return 200 { accessToken } directly from /auth/google/callback (no frontend redirect in V1).

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Forgot Password & Secure Recovery (Priority: P1)

A registered user who forgot their password requests a reset link, receives a recovery token via email (email only in V1 — WhatsApp recovery link deferred), validates the token, and sets a new password to regain access without contacting support.

**Why this priority**: Password recovery is the highest-value auth gap — without it, lockout = support ticket. It unblocks all other auth flows and is prerequisite for OTP-as-reset-channel. Delivers immediate user retention value.

**Independent Test**: Can be fully tested by registering a user → calling `POST /auth/forgot-password` → extracting raw token via test hook → `POST /auth/validate-reset-token` → `POST /auth/reset-password` with new password → `POST /auth/login` with new password succeeds and old password fails. Existing email and non-existing email both return 200 (anti-enumeration).

**Acceptance Scenarios**:

1. **Given** a registered user with email `alice@example.com`, **When** she calls `POST /auth/forgot-password { email: "alice@example.com" }`, **Then** system returns `200 { message: "If an account exists, a reset link has been sent." }`, creates a `PasswordResetToken` with `tokenHash = sha256(rawToken)`, `expiresAt = now + 15m`, invalidates any prior active tokens for that user, and emits async notification after DB commit.
2. **Given** a non-existing email `nobody@example.com`, **When** `POST /auth/forgot-password` is called, **Then** system still returns `200` with same message, creates no token, and logs at `debug` only (no user enumeration).
3. **Given** a valid unexpired unused token for `alice@example.com`, **When** she calls `POST /auth/reset-password { email, token, newPassword }` inside transaction with `SELECT ... FOR UPDATE` on token, **Then** password is bcrypt-hashed (10 rounds), `User.password` updated, `token.usedAt = now()`, all other active tokens for user invalidated, and response is `200 { message: "Password reset successful." }`.
4. **Given** an expired, already-used, or wrong token, **When** `POST /auth/reset-password` or `POST /auth/validate-reset-token` is called, **Then** system returns `400 { message: "Invalid or expired token." }` and does not change password.
5. **Given** a successful reset, **When** the same raw token is reused, **Then** second attempt returns `400` (single-use enforced) and does not double-modify inventory/auth state.

---

### User Story 2 - WhatsApp OTP Verification & Passwordless Login (Priority: P2)

A registered user can log in either with email+password (traditional) or with phone+WhatsApp OTP (passwordless, Amazon-style). Registration still requires password. Separately, a user can verify their phone via WhatsApp OTP. OTP is delivered via WhatsApp within TTL; email OTP is deferred to a future phase.

**Why this priority**: Provides second channel for identity verification and passwordless login without weakening registration invariants. Lower than P1 because it depends on external provider abstraction and Redis TTL, but critical for users who prefer phone over email. Email OTP explicitly out of scope for V1.

**Independent Test**: Can be fully tested by registering user with password → `POST /auth/login { email, password }` 200 AND `POST /auth/otp/request { phoneNumber: "+2010xxxxxxx", purpose: "login" }` → mock `WhatsAppProvider` captures 6-digit OTP → `POST /auth/otp/verify { phoneNumber, otp, purpose:"login" }` returns `200 { accessToken }` (same JWT shape) while `purpose:"verify_phone"` returns `200 { verified:true }`; expired OTP or 4th attempt fails with 400/429.

**Acceptance Scenarios**:

1. **Given** a valid E.164 phone `+2010xxxxxxx` with no active OTP, **When** `POST /auth/otp/request` is called, **Then** system normalizes phone, checks Redis cooldown (60s per phone) and rate limits, generates `crypto.randomInt(100000,999999)`, stores `sha256(otp)` in Redis key `otp:whatsapp:<phone>` with TTL 300s (`{ hash, attempts:0, createdAt, expiresAt }`) and optional `OtpVerification` audit row, sends via `WhatsAppProvider`, returns `200 { message, expiresIn:300 }`.
2. **Given** a valid OTP stored in Redis, **When** `POST /auth/otp/verify` is called with correct code within TTL and ≤3 attempts, **Then** system increments attempts, deletes Redis key on success, marks `user.phoneVerified=true` if user exists, and for `purpose=login` issues JWT (same shape as local login: `{sub,email,fullName,role}`), for `purpose=verify_phone` returns `verified:true` (no JWT). `purpose=reset_password` is not supported in V1 — returns 400 if sent.
3. **Given** an expired OTP (TTL elapsed) or non-existent key, **When** verify is called, **Then** returns `400 "Invalid or expired OTP"`.
4. **Given** 3 failed attempts, **When** 4th verify is attempted, **Then** system deletes key, returns `400/429`, and requires new `otp/request` (brute-force mitigation).
5. **Given** a resend request within 60s cooldown with active OTP, **When** `otp/request` is called again, **Then** returns `429 { message: "Resend cooldown active, try in X seconds" }` (idempotent resend).
6. **Given** a user at login screen, **When** they choose password vs OTP option, **Then** both paths are available: `POST /auth/login` (LocalAuthGuard) and `POST /auth/otp/request|verify` (phone) are independently discoverable via Swagger/ui.

---

### User Story 3 - Google OAuth Login & Account Linking (Priority: P3)

A user signs in with Google via OAuth 2.0, either creating a new account, reusing an existing Google-linked account, or linking Google to an existing local email account, and receives the same JWT as local login.

**Why this priority**: Highest friction reduction for onboarding, but P3 because it requires external OAuth config, new strategy, and migration (`password` nullable, `googleId` unique). Builds on User model alterations from P1.

**Independent Test**: Can be fully tested with mocked Google profile: `GET /auth/google` → 302 redirect, `GET /auth/google/callback?code=...` with `GoogleStrategy.validate` mocked → `AuthService.handleGoogleLogin` creates/links user → returns `200 { accessToken }` with `sub,email,fullName,role` payload; subsequently `GET /cart` with JWT succeeds.

**Acceptance Scenarios**:

1. **Given** no user exists with `googleId=google-123` or `email=alice@gmail.com`, **When** Google callback provides verified profile `{ googleId, email, firstName, lastName }`, **Then** system creates `User { email, firstName, lastName, googleId, provider:'google', password:null }` with `role=User` and issues JWT.
2. **Given** a user exists with same `googleId`, **When** callback occurs, **Then** system returns existing user and issues JWT (no duplicate creation).
3. **Given** a local user exists with same verified email but no `googleId`, **When** callback occurs with `verified_email=true`, **Then** system links `googleId` to existing user (if policy allows) and issues JWT; if `verified_email=false` returns `400/401`.
4. **Given** an authenticated user calls `GET /auth/google/link` with `JwtGuard`, **When** Google callback succeeds, **Then** links Google to current user (`googleId` unique where not null).
5. **Given** missing/invalid `GOOGLE_CLIENT_SECRET` or OAuth state mismatch, **When** callback occurs, **Then** returns `401/400` and does not create user.

---

### User Story 4 - Rate Limiting & Anti-Abuse on Auth Endpoints (Priority: P2, cross-cutting)

As a system, auth endpoints must be protected against brute-force and enumeration without blocking legitimate users, even when Redis is degraded.

**Why this priority**: Security/correctness requirement that spans P1-P3; without it, forgot-password/OTP become abuse vectors. P2 because it gates production readiness.

**Independent Test**: Can be tested by spamming `POST /auth/forgot-password` 6 times/hour from same IP → 6th returns `429`; spamming `otp/verify` beyond limits → `429`; disconnecting Redis → request still succeeds with warning log (fail-open).

**Acceptance Scenarios**:

1. **Given** rate limits `forgot-password: 5/hour/IP + 3/hour/email`, `otp/request:5/hour/phone+10/hour/IP`, **When** limits exceeded, **Then** returns `429 Too Many Requests` with `Retry-After`.
2. **Given** Redis unavailable, **When** any auth endpoint is called, **Then** request proceeds (fail-open) with `Logger.warn` and metric emitted, never corrupting auth state.

### Edge Cases

- What happens when two concurrent `POST /auth/reset-password` use the same raw token? → Transaction with `FOR UPDATE` on token row ensures single winner: first succeeds `200`, second sees `usedAt` non-null and returns `400`.
- What happens when two concurrent `POST /auth/forgot-password` for same email? → Both succeed anti-enum; second invalidates first's token inside transaction; only latest token usable.
- How does system handle `password === email` or weak password? → `ResetPasswordDto` `MinLength 8`, `MaxLength 72`, rejects if `newPassword === email`, optional strength regex; returns `400 validation`.
- What happens when OTP Redis key missing but audit row exists? → Normally verify fails `400` (Redis is TTL authority), but when Redis is down, audit row is used as fallback — verify checks `expiresAt`/`attempts` against DB and succeeds/fails accordingly (clarified 2026-09-15).
- How does system handle Google unverified email? → Reject or require OTP verification before linking (configurable; default reject with `400 "Google email not verified"`).
- What happens when `User.email` duplicate insert? → DB unique constraint returns `409` (add `UNIQUE(email)` migration if not enforced; currently only `@Index`).
- What happens when `phoneNumber` duplicate where not null? → Partial unique index `WHERE phoneNumber IS NOT NULL` returns `409`.
- What happens when `googleId` duplicate where not null? → Partial unique index returns `409`.
- How does system handle authenticated `otp/request` without phone on file? → Returns `404 "No phone number on file"` for `JwtGuard` path.
- What happens when WhatsApp provider fails to send OTP? → Does not throw 500 to client for enumeration; returns `200` to requester but logs provider error at `error` level; verify will fail until resend.

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: System MUST expose `POST /auth/forgot-password` (public) accepting `{ email }` and ALWAYS return `200 { message: "If an account exists, a reset link has been sent." }` regardless of email existence (anti-enumeration), while internally creating a hashed reset token only for existing users.
- **FR-002**: System MUST generate recovery tokens as cryptographically random `crypto.randomBytes(32).toString('hex')` (64 chars, 256 bits), store ONLY `sha256` hash (`tokenHash`) with `expiresAt = now + RESET_TOKEN_TTL (15m)` and enforce `CHECK expiresAt > createdAt` (entity definition see FR-013).
- **FR-003**: System MUST invalidate prior active reset tokens for the user on new `forgot-password` (SET `usedAt=NOW()` where `userId=? AND usedAt IS NULL AND expiresAt > NOW()`) inside `DataSource.transaction` with `EntityManager`.
- **FR-004**: System MUST expose `POST /auth/validate-reset-token { email, token }` returning `200 { valid:true }` for valid token or `400 invalid/expired` otherwise, and `POST /auth/reset-password { email, token, newPassword }` that validates hash, expiry, single-use (`usedAt IS NULL`) via `SELECT ... FOR UPDATE`, bcrypt-hashes new password (10 rounds), updates `User.password` and increments `User.tokenVersion` (or sets `passwordChangedAt=NOW()`), sets `usedAt`, invalidates other active tokens, and revokes all prior JWTs (JWT `tokenVersion`/`iat` < current `User.tokenVersion` fails `JwtStrategy.validate`) — all atomically. Implementation uses `tokenVersion int default 0` in User and JWT payload `{sub,email,fullName,role,tokenVersion}` per chosen revocation strategy C.
- **FR-005**: System MUST enforce password rules on reset: `MinLength 8`, `MaxLength 72`, DTO validation via global `ValidationPipe` (whitelist/forbidNonWhitelisted), and forbid `newPassword === email`.
- **FR-006**: System MUST implement WhatsApp OTP via `WhatsAppProvider` interface (`sendOtp(phone, otp, expiresInMinutes)`) with `NoopWhatsAppProvider` (dev/test), `TwilioWhatsAppProvider` and/or `MetaCloudWhatsAppProvider` (prod), selectable via `WHATSAPP_PROVIDER` env.
- **FR-007**: System MUST expose `POST /auth/otp/request { phoneNumber?, purpose? }` (public requires `phoneNumber`; `JwtGuard` variant allows `phoneNumber` optional — uses `currentUser.phoneNumber` when omitted, else `404` if no phone on file) and `POST /auth/otp/verify { phoneNumber, otp, purpose? }` where `phoneNumber` is E.164 (`/^\+[1-9]\d{1,14}$/`), `otp` is 6 digits, and `purpose` is enum `login|verify_phone` in V1 (`reset_password` deferred, email OTP deferred). `RequestOtpDto.phoneNumber` is `@IsOptional()` when authenticated, otherwise `@IsNotEmpty`. Login MUST support two interchangeable options: `POST /auth/login` (email+password) OR `POST /auth/otp/request|verify` (phone+WhatsApp OTP passwordless); registration still requires password.
- **FR-008**: System MUST generate OTP via `crypto.randomInt(100000, 999999)`, hash with `sha256` before storage, store in Redis `otp:whatsapp:<phone> = { hash, attempts, createdAt, expiresAt }` with TTL `OTP_TTL=300s` AND persist to PostgreSQL `OtpVerification` in same transaction, enforce `OTP_MAX_ATTEMPTS=3` and `OTP_RESEND_COOLDOWN=60s` per phone via `SET NX EX` (or DB check when Redis down), increment `attempts` on **every** `verify` attempt (including successful one before deleting) and delete/invalidate key/row after success or after max attempts. When Redis is unavailable, verification MUST fallback to PostgreSQL row (check `expiresAt > NOW()` and `attempts < 3`). Use `timingSafeEqual` or hashed lookup for codeHash compare.
- **FR-009**: System MUST persist `OtpVerification` entity in PostgreSQL (`phoneNumber indexed, userId nullable FK SET NULL, purpose enum('login','verify_phone') in V1, codeHash, expiresAt, attempts, verifiedAt`); primary verification uses Redis, but when Redis is unavailable the DB row becomes fallback source of truth (enforce same TTL/attempt checks). Email OTP audit deferred.
- **FR-010**: System MUST implement Google OAuth via `passport-google-oauth20` with `GoogleStrategy (PassportStrategy(Strategy,'google'))`, scopes `profile email`, and expose `GET /auth/google` (302), `GET /auth/google/callback` returning `200 { accessToken }` JSON (no redirect in V1), and `GET /auth/google/link` (`JwtGuard`) also returning JSON.
- **FR-011**: System MUST implement `AuthService.handleGoogleLogin(profile)` logic: if `googleId` exists → return user; else if verified `email` exists → link `googleId` to existing user; else create new `User { email, firstName, lastName, googleId, provider:'google', password:null }`, issuing JWT with same payload shape `{sub,email,fullName,role}` as local login.
- **FR-012**: System MUST alter `User` entity: add `phoneNumber varchar nullable @Index unique where not null`, `phoneVerified boolean default false`, `googleId varchar nullable unique where not null`, `provider enum('local','google') default 'local'`, make `password varchar nullable`, add `tokenVersion int default 0` (for JWT revocation — increment on `reset-password`, embedded in JWT per chosen strategy C; alternatively `passwordChangedAt timestamptz` if strategy A), add `UNIQUE(email)` DB constraint (currently only `@Index`), and enforce `CHECK provider IN ('local','google')`.
- **FR-013**: System MUST add `PasswordResetToken` entity (`id uuid PK, userId FK CASCADE indexed, tokenHash varchar(255) indexed, expiresAt timestamptz, usedAt nullable, createdAt`) with indexes `(userId)`, `(tokenHash)`, `(expiresAt)`, `(userId, expiresAt)` (behavior see FR-002/FR-003/FR-004).
- **FR-014**: System MUST enforce rate limiting via Redis (`INCR+EXPIRE` or `SET NX EX`): `forgot-password 5/hour/IP + 3/hour/email`, `reset-password 10/hour/IP`, `otp/request 5/hour/phone +10/hour/IP cooldown 60s`, `otp/verify 10/hour/phone`, `google/callback 20/hour/IP`, `login/register 10/hour/IP`, and fail-open with `Logger.warn` when Redis unavailable. On `429` return `Retry-After: <seconds>` header **plus** `X-RateLimit-Limit`, `X-RateLimit-Remaining`, `X-RateLimit-Reset` per chosen full-headers option B, and increment metric `auth_rate_limit_fallback_total` on fail-open.
- **FR-015**: System MUST emit async notification after DB commit for `forgot-password` and `otp/request` (commit → publish **hybrid** per chosen C: RabbitMQ `auth.password_reset_requested` `{userId,email,rawToken,expiresAt}` for email + BullMQ `authOtpSend` `{phone,otp,expiresIn}` for WhatsApp, never provider I/O inside DB transaction), and mock provider in tests.
- **FR-016**: System MUST handle errors via Nest HTTP exceptions (`BadRequestException` invalid token/OTP/phone, `TooManyRequestsException`/`429`, `UnauthorizedException` OAuth, `NotFoundException` internally only) serialized by global `AllExceptionsFilter`; auth endpoints must not leak existence.
- **FR-017**: System MUST read all new config via `ConfigService` from `.env`: `RESET_TOKEN_TTL=15m`, `OTP_TTL=5m`, `OTP_MAX_ATTEMPTS=3`, `OTP_RESEND_COOLDOWN=60s`, `WHATSAPP_PROVIDER`, `WHATSAPP_FROM_NUMBER`, `TWILIO_*`, `META_*`, `GOOGLE_CLIENT_ID/SECRET/CALLBACK_URL`, `FRONTEND_URL`, `JWT_SECRET/EXPIRES_IN`; never hardcode or commit secrets.
- **FR-018**: System MUST respect module boundaries: `AuthService` owns auth business logic, `UsersService` owns user CRUD, other modules (inventory/reservation/order) remain unaware of auth internals; no cross-module `@InjectRepository(User)`.

### Key Entities

- **User (altered)**: Existing account with added `phoneNumber` (E.164 nullable, partial unique), `phoneVerified` (bool), `googleId` (nullable, partial unique), `provider` enum `local|google`, `password` now nullable (for OAuth users), `email` now `UNIQUE` (was only indexed). Relations unchanged (`orders`, `cart`).
- **PasswordResetToken**: Opaque recovery credential per user; `tokenHash` (sha256 hex, indexed), `expiresAt` (+15m), `usedAt` (null until single-use), `userId` FK CASCADE. Multiple rows per user allowed but only one active; prior active invalidated on new request.
- **OtpVerification**: Ephemeral phone verification attempt; `phoneNumber`, `userId` nullable, `purpose` enum `login|verify_phone` in V1 (reset_password deferred), `codeHash` (sha256 of 6-digit), `expiresAt` (+5m), `attempts` (0..3), `verifiedAt` nullable. Stored in PostgreSQL; primary verify via Redis, fallback to DB when Redis down.
- **WhatsApp OTP (Redis)**: Not a DB entity; transient `otp:whatsapp:<phone>` cached value with TTL 300s, holds hashed code and attempt counter.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: Users who forget password can complete reset flow (forgot → validate → reset → login with new password) in under 2 minutes, and `POST /auth/forgot-password` returns 200 for both existing and non-existing emails without enumeration leakage (verified by manual test and automated anti-enum test).
- **SC-002**: Recovery tokens are single-use and expire within 15 minutes: second use of same raw token fails with 400, and token used after `expiresAt` fails with 400 (100% of reuse/expiry tests pass).
- **SC-003**: Concurrent `reset-password` with same token results in exactly one success (200) and one failure (400) under real PostgreSQL `FOR UPDATE` transaction (concurrency test with parallel requests).
- **SC-004**: WhatsApp OTP request delivers code via abstracted provider within 5 seconds (mock provider in tests), verifies within TTL 300s on correct code, and rejects after 3 failed attempts or after TTL (100% of TTL/attempt tests pass).
- **SC-005**: Google OAuth callback issues a valid JWT (same `{sub,email,fullName,role}` shape as local login) that grants access to protected routes (`GET /cart` 200) for all three cases: new Google user creation, existing GoogleId reuse, and email-linking (mocked profile tests).
- **SC-006**: Rate limiting blocks excess auth requests with 429 and `Retry-After`; when Redis is down, auth endpoints still succeed (fail-open) and log warning (chaos test by disabling Redis).
- **SC-007**: Database enforces new invariants: duplicate `email` → 409, duplicate non-null `googleId` → 409, duplicate non-null `phoneNumber` → 409, insert with `expiresAt <= createdAt` → check violation, all verified by integration tests with real PostgreSQL.
- **SC-008**: Test coverage: unit 30+ (hash, expiry, anti-enum, OTP attempts, Google linking), integration 10+ (real DB constraints, transactions, concurrent token reuse, Redis TTL), E2E 3 flows (forgot→reset→login, otp/request→verify→JWT, google callback→JWT→protected) all pass before merge.

## Assumptions

- `User.email` uniqueness will be enforced via new DB unique constraint (currently only `@Index`); migration adds `UQ_user_email` and partial uniques for `googleId`/`phoneNumber` where not null.
- `JWT_EXPIRES_IN` remains short (60s dev, configurable to `15m` in prod); on successful `reset-password`, all prior JWTs are revoked — implement via `User.tokenVersion` increment (chosen revocation strategy C: JWT payload includes `tokenVersion`, `JwtStrategy.validate` compares `payload.tokenVersion === user.tokenVersion`; alternative `passwordChangedAt` `iat` check also valid). Forces re-login on all devices; increment is atomic inside same `reset-password` transaction.
- WhatsApp provider in dev/test is `NoopWhatsAppProvider` that logs and captures OTP in-memory for E2E; Twilio/Meta providers are runtime-selectable but not required for local CI.
- OTP is ephemeral: Redis is primary TTL authority; PostgreSQL `OtpVerification` is audit/forensics normally, but serves as fallback source of truth when Redis is unavailable (clarified 2026-09-15 — degraded-mode DB fallback); document exception in ADR.
- Google OAuth `state: true` provides CSRF protection via Passport; `profile.emails[0].verified` must be true to trust email; otherwise reject.
- Linking existing local email to Google on first OAuth login is allowed without additional password confirmation in V1, but ADR will flag account-takeover risk and recommend optional email-OTP confirmation for strict mode (future enhancement).
- Rate limiting fail-open (availability over strict limit) is acceptable for auth; metric/log emitted when Redis unavailable; not a security regression because JWT/password invariants remain.
- `synchronize: false` remains; all User/PasswordResetToken/OtpVerification changes delivered via TypeORM migrations (`17xxxxx-*`), never auto-synced.
- Existing `AuthService.userValidation` will be updated to return `null` when `User.password` is null and strategy is local (pure OAuth user must use Google path).
- Frontend reset link format `https://app.example.com/reset-password?token=<raw>&email=<email>` is placeholder; actual `FRONTEND_URL` from env; rawToken never logged, only `tokenHash` prefix at `debug`.

