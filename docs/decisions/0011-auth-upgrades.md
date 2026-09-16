# ADR-0011 — Auth Upgrades: Forgot Password, WhatsApp OTP, Google OAuth

**Status**: Accepted — implemented in `005-auth-upgrades` (spec `specs/005-auth-upgrades/spec.md` + clarifications 2026-09-15 + 2026-09-16 WhatsApp DEFERRED password-only)

**Update 2026-09-16**: WhatsApp OTP **deferred to future** — login is **password-only** (`POST /auth/login` requires password) in V1. `POST /auth/otp/request|verify` now returns `501 Not Implemented` (controller TODO guard) until WhatsApp Business setup ready. No WhatsApp env required now; `OtpVerification` table still migrates but remains unused TODO. Provider `Noop` remains for future re-enable. Email OTP also deferred (§16.8).

**Context**: Phase 16 needed password recovery, passwordless phone login, and Google OAuth without weakening JWT invariants or coupling to inventory/reservation. Constitution requires PostgreSQL source of truth, modular monolith, and DB-backed tests.

**Decisions**:

- **Q1 Google auto-link (FR-011)**: If `googleId` not found and verified `email` exists (`profile.emails[0].verified===true`), auto-link `googleId` to existing local user and issue JWT. No extra password/OTP step in V1. Unverified email → `400`. Alternative `require password confirmation` deferred to strict mode (future ADR). Tradeoff: slight account-takeover risk if attacker controls verified Google email, but verified flag + email uniqueness mitigates; UX vs strictness.
- **Q2 Login choice (FR-007) → updated 2026-09-16**: Originally **password OR WhatsApp OTP** (Amazon-style). Now **password-only in V1** per product decision — `POST /auth/login` requires password; WhatsApp OTP `POST /auth/otp/request|verify` returns `501 TODO` until future phase. WhatsApp OTP V1 design (`purpose=login` + `verify_phone`) preserved as TODO; re-enable by removing `501` guard in `auth.controller.ts:69`. Registration still requires password.
- **Q3 JWT revocation (FR-004)**: **TokenVersion stateless** (chosen C). Add `User.tokenVersion int default 0`, embed `tokenVersion` in JWT. On `reset-password` atomically increment `User.tokenVersion` inside same `FOR UPDATE` transaction that sets `usedAt` and bcrypt hash. `JwtStrategy.validate` checks `payload.tokenVersion === user.tokenVersion` else `401` → all old JWTs revoked, force re-login. Alternative `passwordChangedAt` `iat` check was considered (requires DB fetch on every request, slight staleness if cached); `tokenVersion` is zero-cost stateless. `passwordChangedAt` column kept nullable for compat but not used.
- **Q4 OTP fallback (FR-008/009)**: Primary verify via Redis `otp:whatsapp:<phone>` TTL 300s, but when Redis down/unavailable fallback to PostgreSQL `OtpVerification` latest row (`expiresAt > NOW() && verifiedAt IS NULL`). Increment `attempts` on **every** attempt including success per B2 choice B (before delete), `timingSafeEqual` for `codeHash`. Constitution I exception: OTP is ephemeral, not inventory/order/payment, so Redis-as-TTL with PG fallback is scoped and ADR-documented; primary remains Redis. Alternative strict 503 on Redis down rejected (availability).
- **Q5 OAuth response (FR-010)**: `GET /auth/google/callback` returns `200 {accessToken}` JSON, not `302` to `FRONTEND_URL`. JSON is API-clean; redirect can be added later via `?redirect` param without breaking JSON. Alternative redirect chosen B rejected for V1.
- **B1 Rate-limit headers**: Return `Retry-After` + `X-RateLimit-Limit/Remaining/Reset` (full headers) + metric `auth_rate_limit_fallback_total` on fail-open. Alternative minimal `Retry-After` only rejected for debuggability.
- **C2 Hybrid queue**: After DB commit, publish **RabbitMQ** `auth.password_reset_requested` `{userId,email,rawToken,expiresAt}` for email and **BullMQ** `authOtpSend` `{phone,otp,expiresIn}` for WhatsApp per hybrid choice C. Never provider I/O inside tx (constitution async rule). Alternative single broker unified rejected to keep email durable (RabbitMQ) and OTP short-lived (BullMQ) separation.
- **User alterations (FR-012)**: `User` adds `phoneNumber` partial unique `WHERE phoneNumber IS NOT NULL`, `phoneVerified`, `googleId` partial unique `WHERE googleId IS NOT NULL`, `provider enum local|google`, `password nullable`, `tokenVersion`, `passwordChangedAt` nullable, `emailVerified`, `UNIQUE(email)`. Migration `1755900000000-AuthUpgradesUserAndResetToken` owns these; `1755900000001-AddOtpVerification` only creates `otp_verification` table (F3).
- **Rate limiting (FR-014)**: Redis `INCR+EXPIRE` / `SET NX EX` per route, fail-open with `Logger.warn` + metric. Limits as in spec; headers per B1.

**Consequences**:

- Login UX is **password-only in V1** (2026-09-16) — Swagger shows `POST /auth/login` as sole login path; `POST /auth/otp/request|verify` documented as `501 TODO Future`.
- Old JWTs revoked immediately on reset; clients must re-login.
- OTP remains **TODO Future** — when re-enabled, will be available when Redis blips (fallback), but primary TTL still Redis.
- Email OTP and WhatsApp OTP both **deferred to future** — no WhatsApp Business setup required now.

**Verification**: Unit 30+ (hash, expiry, anti-enum, OTP attempts per B2, Google auto-link), integration real PG `FOR UPDATE` single-winner + constraints + Redis fail-open, E2E 3 flows per SC-008.

**References**: `specs/005-auth-upgrades/spec.md` Session 2026-09-15 (5 Q&A), `plan.md`, `research.md` D1-D11, `data-model.md`, `contracts/auth-contracts.md`, `quickstart.md`, tasks T005-T049.
