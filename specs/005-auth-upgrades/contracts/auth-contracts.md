# Contracts: Auth Upgrades (Phase 16)

**Feature**: `005-auth-upgrades` | **Spec**: [spec.md](../spec.md) | **Data Model**: [data-model.md](../data-model.md)

Base: `POST /auth/*` (public unless `JwtGuard`), `GET /auth/google*` (Passport). All bodies via global `ValidationPipe` (whitelist/forbidNonWhitelisted/transform). Errors via `AllExceptionsFilter`: `{ statusCode, message, timestamp }` (REST) — `400` validation/weak token, `401` OAuth/JWT revocation (tokenVersion mismatch), `404` no phone on file (internally only), `409` duplicate email/googleId/phone, `429` rate limit with `Retry-After` + `X-RateLimit-*` (full headers per B1 choice B).

## 1. `POST /auth/forgot-password`

Anti-enumeration, always `200`.

**Request** `ForgotPasswordDto`:
```json
{ "email": "alice@example.com" }  // @IsEmail()
```
**Success** `200`:
```json
{ "message": "If an account exists, a reset link has been sent." }
```
Internal: if user exists, in `dataSource.transaction` invalidate prior active tokens (`usedAt IS NULL AND expiresAt > NOW()`) + insert `PasswordResetToken { tokenHash: sha256(crypto.randomBytes(32).toString('hex')), expiresAt: now+15m }`; after commit publish **hybrid** per C choice C: RabbitMQ topic `auth.password_reset_requested` `{userId,email,rawToken,expiresAt}` → email worker (link: `${FRONTEND_URL}/reset-password?token=<raw>&email=<email>`). If not exists: no DB write, `Logger.debug` only. Metric `auth_rate_limit_fallback_total` increments on Redis fail-open per B1.

**Errors**: `400` invalid email, `429` `forgot-password 5/h/IP +3/h/email` (Redis fail-open).

## 2. `POST /auth/validate-reset-token` (optional UX helper)

**Request** `ValidateResetTokenDto`:
```json
{ "email": "alice@example.com", "token": "a3f...64hex" }
```
**Success** `200`:
```json
{ "valid": true }
```
Check: `hash(token) === tokenHash` + `expiresAt > now` + `usedAt IS NULL` + join `User` by email.

**Errors**: `400` `{ message: "Invalid or expired token." }`, `429` `10/h/IP` (shared with reset-password bucket or separate — note in implementation).

## 3. `POST /auth/reset-password`

Single-winner transactional, revokes JWTs per Q3.

**Request** `ResetPasswordDto`:
```json
{ "email": "alice@example.com", "token": "a3f...64hex", "newPassword": "NewStrong123!" }
// @IsEmail(), @IsString @MinLength(8) @MaxLength(72), forbid newPassword === email
```
**Success** `200`:
```json
{ "message": "Password reset successful." }
```
**Transactional** (`dataSource.transaction`):
```text
SELECT PasswordResetToken FOR UPDATE WHERE tokenHash = sha256(token) AND userId = user.id
→ verify not expired / not used (timingSafeEqual for codeHash)
→ bcrypt.hash(newPassword,10) → UPDATE User.password, User.tokenVersion = User.tokenVersion + 1 (chosen C, atomic)
→ UPDATE PasswordResetToken SET usedAt=NOW() + invalidate other active tokens
→ COMMIT; JWTs with payload.tokenVersion !== user.tokenVersion now rejected by JwtStrategy.validate() (old JWTs →401)
```
Second use of same `rawToken` → `400`. Concurrent same token → one `200` one `400` (`FOR UPDATE` single-winner per SC-003).

**Errors**: `400` invalid/expired/used token or weak password (`MinLength`/`MaxLength`/`===email`), `429` rate limit.

## 4. `POST /auth/otp/request`

**Auth**: public, or `JwtGuard` variant `POST /auth/otp/request` with `CurrentUser` (uses phone on file).

**Request** `RequestOtpDto`:
```json
{ "phoneNumber": "+2010xxxxxxx", "purpose": "login" }
// @Matches(/^\+[1-9]\d{1,14}$/) E.164, @IsEnum(['login','verify_phone']) V1 — reset_password rejected 400 in V1
```
`purpose` default `login`. Public path requires `phoneNumber`; authenticated path `phoneNumber` optional (uses `user.phoneNumber`).

**Success** `200`:
```json
{ "message": "OTP sent via WhatsApp.", "expiresIn": 300 }
```
Flow: normalize E.164, rate-limit (`otp/request 5/h/phone +10/h/IP`), cooldown `SET NX EX 60` per phone → `429` if active (full headers per B1), `crypto.randomInt(100000,999999)`, `codeHash=sha256(otp)`, store Redis `otp:whatsapp:<phone>` `EX 300` `{ hash, attempts:0, createdAt, expiresAt, purpose }` **and** insert `OtpVerification` row `purpose, expiresAt: now+5m`; after commit send via `WhatsAppProvider.sendOtp(phone, otp, 5)` (Noop in dev/test) through BullMQ `authOtpSend {phone,otp,expiresIn}` per hybrid C. Redis unavailable → still create DB row, log `Logger.warn` + metric `auth_rate_limit_fallback_total`, return `200`.

**Errors**: `400` invalid phone/purpose, `404` no phone on file (JwtGuard path), `429` cooldown/limit.

## 5. `POST /auth/otp/verify`

**Request** `VerifyOtpDto`:
```json
{ "phoneNumber": "+2010xxxxxxx", "otp": "123456", "purpose": "login" }
// @Matches E.164, @Length(6,6), @IsEnum login|verify_phone
```
**Success** — depends on `purpose`:

- `purpose=login` → `200 { "accessToken": "<jwt>" }` (same `{sub,email,fullName,role}` as `POST /auth/login`; `JwtService.sign`); mark `user.phoneVerified=true` if user exists, delete Redis key + set `OtpVerification.verifiedAt=NOW()`.
- `purpose=verify_phone` → `200 { "verified": true }` (no JWT); mark `user.phoneVerified=true`.

Fallback (Q4): if Redis down or key missing, lookup latest `OtpVerification` where `phoneNumber` + `verifiedAt IS NULL` + `expiresAt > NOW()`, verify `sha256(otp) === codeHash` via `timingSafeEqual`, enforce `attempts < 3`, increment `attempts` on **every** attempt (including success per B2 choice B) before deleting, on success set `verifiedAt`, on 3 fails delete/invalidate. `X-RateLimit-*` headers still returned per B1.

**Errors**: `400` invalid/expired OTP or `purpose=reset_password` in V1, `400/429` after 3 attempts (key deleted, require resend), `429` `otp/verify 10/h/phone`.

**Login choice** (Q2): `POST /auth/login` (email+password, `LocalAuthGuard`) and `POST /auth/otp/request|verify` (phone, passwordless) are independent; both issue same JWT shape; registration `POST /auth/register` still requires password.

## 6. `GET /auth/google`

Public. Initiates OAuth.

**Request**: none. `GoogleAuthGuard extends AuthGuard('google')` scope `profile email` `state: true`.

**Success**: `302` redirect to Google consent. Rate limit `20/h/IP` (fail-open).

## 7. `GET /auth/google/callback`

Public (guard handles). Per Q5 → **JSON**, no redirect.

**Query**: `?code=...&state=...` (Passport handles). `GoogleStrategy.validate(accessToken, refreshToken, profile, done)` → `{ googleId: profile.id, email: profile.emails[0].value, firstName, lastName, verified: profile.emails[0].verified }`; if `verified!==true` → `401`/`400` per FR-016.

`AuthService.handleGoogleLogin(profile)`:
- if `googleId` exists → user
- else if verified `email` exists → **auto-link** `googleId` to existing user per Q1 A (`UPDATE User SET googleId, provider='google' WHERE email`) + issue JWT
- else create `User { email, firstName, lastName, googleId, provider:'google', password:null, phoneVerified:false, emailVerified: verified }` + issue JWT

**Success** `200`:
```json
{ "accessToken": "<jwt>" }
```
Same payload `{ sub:id, email, fullName: firstName+' '+lastName, role, tokenVersion: user.tokenVersion }` as local login (includes `tokenVersion` for revocation per F2 choice C).

**Errors**: `401` OAuth failure/state mismatch/missing `GOOGLE_CLIENT_SECRET` or JWT tokenVersion mismatch (revoked), `400` unverified email, `409` duplicate `googleId` partial unique race, `429` rate limit with full headers B1.

## 8. `GET /auth/google/link`

**Auth**: `JwtGuard` (`@Auth()`). Links Google to current authenticated user.

**Flow**: same `GoogleAuthGuard` → `linkGoogleAccount(userId, profile)` → `UPDATE User SET googleId` where `userId=currentUser.sub` and `googleId` not already taken → `200 { "message": "Google linked." }` or `409` if `googleId` elsewhere.

## Rate limiting (cross-cutting)

All endpoints via `RateLimitGuard` using Redis `INCR+EXPIRE` / `SET NX EX`; on Redis down → fail-open with `Logger.warn` + metric `auth_rate_limit_fallback_total`. Limits: `forgot-password 5/h/IP +3/h/email`, `reset-password & validate 10/h/IP`, `otp/request 5/h/phone+10/h/IP cooldown 60s`, `otp/verify 10/h/phone`, `google/callback 20/h/IP`, `login/register 10/h/IP`. Returns `429 { statusCode:429, message:"Too Many Requests", retryAfter: <sec> }` plus headers `Retry-After`, `X-RateLimit-Limit`, `X-RateLimit-Remaining`, `X-RateLimit-Reset` per B1 choice B (full headers).

## Swagger

Add `@ApiOperation`, `@ApiResponse` for each DTO; `@ApiExcludeEndpoint` not needed for `GET /auth/google` (document as `302`); `GoogleStrategy` env placeholders in `Swagger` example.

