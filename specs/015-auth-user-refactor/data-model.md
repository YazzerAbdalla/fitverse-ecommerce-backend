# Data Model: Auth + Users Refactor (RP-AUTH)

**Feature**: `specs/015-auth-user-refactor` | **Date**: 2026-10-02

> No schema change in this phase (FR-009, spec Assumptions). No migration is
> emitted. This document maps entity ownership and the behavioral contracts the
> refactor must preserve, so the implementer never guesses at authority.

## Ownership map (plan invariant TI-1 / TI-5)

| Entity (table) | Sole writer after refactor | Readers | Notes |
|---|---|---|---|
| `user` | `UsersService` (extended: create, password/hash, tokenVersion, Google link, verify flags, prefs) | Auth flows via `UsersService`; guards via `UsersService` (unified JwtGuard) | Removes `auth.service.ts:264,432,599` direct `manager.getRepository(User)` bypasses |
| `refresh_token` | `RefreshTokenStore` (tx-scoped manager in, never commits) | `refresh`/`logout`/`logoutAll` orchestration | `FOR UPDATE` on acquire; cap-5 LRU eviction; single-use + theft bulk-nuke preserved |
| `password_reset_token` | `PasswordResetTokenStore` | `validateResetToken` (read-only pre-check) / `resetPassword` (authority, `FOR UPDATE`) | 15m TTL; priors invalidated on new request; single-use consume |
| `email_verification_token` | `VerificationTokenStore` | `verifyEmail` / `resendVerification` (60s cooldown `SET NX`, fail-open) | 24h TTL; single-use consume; anti-enum neutral responses |
| `otp_verification` (audit) | `OtpStore` (Redis primary for TTL; PG audit fallback per ADR-0011) | OTP 501 paths only | No behavior change; sharing the store only |
| Outbox/event rows for auth events | Existing outbox path (untouched) | `AuthEventPublisher` emits after commit | Payloads/queue names unchanged (TI-4) |

## Entity behavioral contracts (preserved)

- **User account**: `{ id, email, firstName, lastName, role, password(hash), phoneNumber?,
  phoneVerified, googleId?, provider, tokenVersion, passwordChangedAt?, emailVerified,
  marketingOptIn, emailOptIn }`. Writes: create (register/Google-create),
  password+`tokenVersion++` (reset), Google link, `emailVerified=true` (verify),
  `tokenVersion++` + revocation (logout-all). `updatePassword` keeps its exact
  current semantics including the dead-param quirk (research D5) — `[R]`.
- **Refresh session**: `{ id, userId FK CASCADE, tokenHash sha256, expiresAt +7d,
  revokedAt?, createdAt }`. Lifecycle: issue (cap-5 evict oldest) → rotate
  (old revoked + new issued, one tx) → reuse ⇒ 401 + revoke-all + warn(prefix).
- **Password-reset token**: `{ userId, tokenHash, expiresAt +15m, usedAt? }`.
  New request invalidates priors; consume is single-use; validate is advisory.
- **Email-verification token**: `{ userId, tokenHash, expiresAt +24h, usedAt? }`.
  Resend invalidates priors + 60s cooldown + dual rate buckets; anti-enum 200.
- **Authenticated principal** (non-persisted): `{ sub, email, fullName, role,
  tokenVersion }` payload shape — frozen (research D1). Internal `request.user`
  stays this shape; `.id`-reliant handlers switch to `sub` (same value).

## State transitions (authority points, all single-winner under `FOR UPDATE`)

```text
refresh:    VALID --rotate--> REVOKED(old)+VALID(new) | reuse of REVOKED --> 401 + revoke-all
reset:      ACTIVE --consume--> USED + password changed + tokenVersion++
verify:     ACTIVE --consume--> USED + emailVerified=true
logout:     ACTIVE --revoke--> REVOKED (idempotent 200 when already revoked)
logout-all: * --tokenVersion++ + bulk revoke--> all sessions dead
```

## Validation rules (service-enforced, unchanged)

- DTOs unchanged (global `ValidationPipe` whitelist/forbid/transform); all 10 auth
  DTO files frozen. `RefreshTokenDto` 64-hex; E.164 phone; password Min 8 Max 72,
  `!== email`; resend/register anti-enum neutral messages.
