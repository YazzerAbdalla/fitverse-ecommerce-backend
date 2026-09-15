# Implementation Plan: Auth Upgrades — Forgot Password, Recovery Token, WhatsApp OTP, Google OAuth (Phase 16)

**Branch**: `005-auth-upgrades` | **Date**: 2026-09-15 | **Spec**: [spec.md](./spec.md)
**Input**: Feature specification from `/specs/005-auth-upgrades/spec.md` (Phase 16 — `docs/plan.md` §§16.0-16.8 + clarifications Session 2026-09-15 — 5 Q&A)

## Summary

Extend the existing `auth`/`users` modules so users can recover a forgotten password via an opaque, single-use, hashed recovery token (anti-enumeration, 15m TTL, `FOR UPDATE` single-winner), log in passwordlessly via WhatsApp OTP (6-digit `crypto.randomInt`, sha256, Redis TTL 5m + PostgreSQL `OtpVerification` fallback, `WhatsAppProvider` abstraction — V1 `login` + `verify_phone` only, registration still password-required, email OTP deferred), and sign in with Google OAuth (`passport-google-oauth20`, auto-link verified email per Q1, JSON `200 {accessToken}` per Q5, `password` nullable, partial uniques). Invalidate prior JWTs on reset via `passwordChangedAt` (`iat < passwordChangedAt` rejection) per Q3; rate-limit all new auth endpoints via Redis fail-open; emit notifications only after DB commit; respect modular-monolith boundaries and global `ValidationPipe`/`AllExceptionsFilter` invariants.

## Technical Context

**Language/Version**: TypeScript 5.x / Node 20, NestJS 11  
**Primary Dependencies**: `@nestjs/common` 11.1.28, `@nestjs/typeorm` 11 + `typeorm` 1.1, `pg` 8.22, `class-validator`/`class-transformer`, `@nestjs/jwt` + `passport` + `passport-local` (existing) + `passport-jwt` + `passport-google-oauth20` + `@types/passport-google-oauth20`, `bcrypt` 5.x, `Jest`+`ts-jest`+`supertest`  
**Storage**: PostgreSQL 17 via TypeORM (authoritative; `synchronize:false`; migrations); Redis 8 via `@nestjs/cache-manager` + `@keyv/redis` (ioredis) — **not authoritative for password reset** but **TTL authority for OTP** (with PG fallback per Q4 degraded mode; document ADR exception); `O(TT)` for recovery token vs ephemeral OTP split  
**Testing**: Jest unit (`*.spec.ts` mocked repos/`DataSource`/`Cache`/`WhatsAppProvider`/`GoogleStrategy`), integration + concurrency against **real PostgreSQL** (docker, `--runInBand`, `FOR UPDATE` single-winner), Redis TTL integration (real or mocked), E2E via `test/jest-e2e.json` + `supertest` (forgot→reset→login, otp/request→verify→JWT, google callback→JWT→protected); `npm run test`, `npm run test:e2e`, `npm run build`, `npm run lint`  
**Target Platform**: Linux server (NestJS HTTP API via `docker-compose.yml`: postgres, redis, rabbitmq) — no frontend in V1  
**Project Type**: Modular monolithic backend — REST `auth` (existing `/register`,`/login`) + new auth routes; GraphQL `products` unchanged  
**Performance Goals**: `POST /auth/forgot-password` and `POST /auth/otp/request` remain bounded by single `dataSource.transaction` + hybrid publish (RabbitMQ `auth.password_reset_requested` + BullMQ `authOtpSend` per B1/C2) + full rate-limit headers `Retry-After` + `X-RateLimit-*`; Redis `INCR/SET NX EX` for rate limit and OTP cooldown O(1); JWT verify `O(1)` with `tokenVersion` equality check per F2 choice C (stateless, no `passwordChangedAt` fetch); `FOR UPDATE` on `PasswordResetToken` only  
**Constraints**: `synchronize:false`; `JWT_SECRET`/`JWT_EXPIRES_IN` via `ConfigService` (never hardcoded); global `ValidationPipe` whitelist/forbidNonWhitelisted/transform; `AllExceptionsFilter` serializes `400/401/429/409` with full headers `Retry-After` + `X-RateLimit-*` per B1 and metric `auth_rate_limit_fallback_total`; `tokenVersion int default 0` (F2 C, stateless JWT `tokenVersion` vs `passwordChangedAt iat` alternative) indexed, increment on `reset-password`; partial unique indexes `WHERE googleId IS NOT NULL` / `WHERE phoneNumber IS NOT NULL`; `CHECK expiresAt > createdAt`, `attempts <= 3` incremented on every verify per B2 choice B via `timingSafeEqual`; anti-enumeration: always `200` for `forgot-password`; single-use `usedAt`  
**Scale/Scope**: Touches `src/modules/auth` (service, controller, dto, strategies/guards, providers) + `src/modules/users/entity/user.entity.ts` + 2 new entities (`PasswordResetToken`, `OtpVerification`) + 2 migrations + `WhatsAppProvider` abstraction; 7 new REST endpoints; no inventory/reservation/order coupling

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-check after Phase 1 design.*

| Principle | Status | Evidence |
|-----------|--------|----------|
| **I. PostgreSQL is source of truth** | ✅ PASS | Password recovery token authoritative path: `dataSource.transaction` → `SELECT PasswordResetToken FOR UPDATE` → `bcrypt` + `tokenVersion` increment per F2 C + `usedAt`; OTP primary Redis but **fallback to PostgreSQL `OtpVerification`** only in degraded mode when Redis down per Q4 — documented ADR exception because OTP is ephemeral (not inventory/order); no Redis decision feeds inventory/order (§III); hybrid publish RabbitMQ+BullMQ per C2 |
| **II. Modular monolith — no premature microservices** | ✅ PASS | Single `AuthModule` + `UsersModule` in place; no new services/processes; cross-cut via exported `AuthService`/`UsersService` only; `WhatsAppProvider` is interface abstraction, not a microservice |
| **III. Inventory/Reservation separate domains** | ✅ PASS | Not touched; auth phase explicitly orthogonal per `plan.md` §16 intro; no inventory mutation |
| **IV. Concurrency safety at DB level** | ✅ PASS | `reset-password` uses `FOR UPDATE` on `PasswordResetToken` row, single-winner per spec FR-004/SC-003; concurrent `forgot-password` invalidates prior tokens inside same tx; OTP `SET NX EX` for cooldown + `attempts` atomic |
| **V. Module boundaries, service-only collaboration** | ✅ PASS | `AuthService` sole owner of auth logic; `UsersService` sole owner of `User` CRUD; `AuthModule` imports `UsersModule`; no `@InjectRepository(User)` outside `UsersService`; controllers thin, services own `DataSource` transactions per AGENTS.md §3 |
| **VI. Spec-driven development** | ✅ PASS | Spec `spec.md` + 5 clarify Q&A (Session 2026-09-15) done before plan (auto-link per Q1, login OTP choice per Q2, JWT revocation per Q3, Redis fallback per Q4, OAuth JSON per Q5); no silent assumption; Phases 5-15 out of scope |
| **VII. Tests mandatory, DB-backed for consistency** | ✅ PASS | Real-PG integration for token single-use concurrency, DB `CHECK`/`UNIQUE` violations, `tokenVersion` revocation + `timingSafeEqual` per B2 + full rate-limit headers per B1; unit mocks for Redis/WhatsApp/Google; E2E 3 flows per SC-008; `AllExceptionsFilter 429` + `grep @InjectRepository(User)` per E1/E2 added to T055 |
| **VIII. No invented APIs/payments/business rules** | ✅ PASS | Only 7 new endpoints from spec: `POST /auth/forgot-password`, `POST /auth/reset-password`, `POST /auth/validate-reset-token`, `POST /auth/otp/request`, `POST /auth/otp/verify`, `GET /auth/google`, `GET /auth/google/callback` + `GET /auth/google/link` (authenticated); no payment; `JWTStrategy` migration replaces manual `JwtGuard` verify only if justified (research D9) |
| **IX. Documentation is part of work** | ✅ PASS | This plan + `research.md`, `data-model.md`, `contracts/`, `quickstart.md` under `specs/005-auth-upgrades/`; `AGENTS.md` marker updated to this plan; `docs/plan.md` §16.8 updated for deferred email OTP |

**Gate result**: **PASS** — no violations. Post-design re-check (after Phase 1) below remains **PASS** (no new gates introduced).

## Project Structure

### Documentation (this feature)

```text
specs/005-auth-upgrades/
├── plan.md              # This file (/speckit.plan output)
├── research.md          # Phase 0 output — decisions D1-D11, risks
├── data-model.md        # Phase 1 output — User alterations + PasswordResetToken + OtpVerification
├── quickstart.md        # Phase 1 output — setup + manual curl + test quickstart
├── contracts/
│   └── auth-contracts.md # Phase 1 output — 7 new REST contracts (forgot/reset/otp/google)
├── checklists/
│   └── requirements.md  # Spec quality checklist (pre-existing, all pass)
└── tasks.md             # Phase 2 output (/speckit.tasks — NOT created by /speckit.plan)
```

### Source Code (repository root)

```text
src/
├── modules/
│   ├── auth/
│   │   ├── auth.module.ts                 # add JwtStrategy, GoogleStrategy, TypeOrmModule.forFeature, WhatsApp provider
│   │   ├── auth.service.ts                # add requestPasswordReset, validateResetToken, resetPassword, requestWhatsAppOtp, verifyWhatsAppOtp, handleGoogleLogin, linkGoogleAccount, passwordChangedAt JWT check
│   │   ├── auth.controller.ts             # add 7 routes (forgot/reset/validate/otp request|verify/google + callback/link)
│   │   ├── dto/
│   │   │   ├── forgot-password.dto.ts         # new: { email }
│   │   │   ├── reset-password.dto.ts          # new: { email, token, newPassword }
│   │   │   ├── validate-reset-token.dto.ts    # new: { email, token }
│   │   │   ├── request-otp.dto.ts            # new: { phoneNumber, purpose? }
│   │   │   └── verify-otp.dto.ts             # new: { phoneNumber, otp, purpose? }
│   │   ├── entities/
│   │   │   ├── password-reset-token.entity.ts # new
│   │   │   └── otp-verification.entity.ts     # new (audit + fallback)
│   │   ├── strategies/
│   │   │   ├── local.strategy.ts          # unchanged (but userValidation now handles null password per Assumptions)
│   │   │   ├── jwt.strategy.ts            # new — Passport JWT, checks passwordChangedAt vs iat
│   │   │   └── google.strategy.ts         # new — Passport Google OAuth2
│   │   ├── guards/
│   │   │   ├── jwt-auth.guard.ts          # new wrapper over AuthGuard('jwt') (optional, replaces manual JwtGuard)
│   │   │   ├── google-auth.guard.ts       # new extends AuthGuard('google')
│   │   │   └── rate-limit.guard.ts        # new or shared guard, Redis-backed, fail-open per FR-014
│   │   ├── providers/
│   │   │   └── whatsapp.provider.ts       # new: interface + Noop/Twilio/Meta implementations
│   │   ├── types.ts                       # extend JwtPayload if needed for googleId?
│   │   └── auth.service.spec.ts           # extend unit tests
│   ├── users/
│   │   ├── entity/user.entity.ts          # ALTER: phoneNumber, phoneVerified, googleId, provider, password nullable, passwordChangedAt, uniques, checks
│   │   ├── users.service.ts               # expose findByGoogleId, updatePassword, setPasswordChangedAt helpers if needed
│   │   └── users.module.ts                # unchanged (already exports UsersService)
│   ├── inventory/ reservation/ products/ cart/ order/ # UNCHANGED — auth phase orthogonal
│   ├── app.module.ts                      # auto
│   ├── data-source.ts                     # migrate list
│   └── migration/                         # 2 new migrations: 17xxxxx-AuthUpgradesUserAndResetToken, 17xxxxx-AddOtpAndGoogleFields
├── config/                                # ConfigService keys: RESET_TOKEN_TTL, OTP_TTL, WHATSAPP_PROVIDER, GOOGLE_*
├── test/
│   └── app.e2e-spec.ts                    # existing hello e2e; new E2E flows in auth e2e spec
└── .env.example / .env                    # add new keys (never commit secrets)
```

**Structure Decision**: Single project (Option 1) — augment existing `src/modules/auth` and `src/modules/users` in place; no new modules beyond `PasswordResetToken`/`OtpVerification` entities and `WhatsAppProvider` abstraction; reuse existing `CacheModule` (Redis) and `RabbitMQ` infra for rate-limit + notifications post-commit; follow `AGENTS.md` backend/module/transaction/error/validation rules.

## Complexity Tracking

> Fill ONLY if Constitution Check has violations that must be justified

| Violation | Why Needed | Simpler Alternative Rejected Because |
|-----------|------------|-------------------------------------|
| OTP Redis-as-primary with PG fallback (Q4) | WhatsApp OTP is ephemeral and Redis TTL is cheapest atomic check; fallback keeps login available when Redis degraded | Strict PostgreSQL-only would require polling TTL and heavier writes; strict Redis-only would return 503 and block login when Redis blips — fallback balances availability and correctness; OTP is explicitly **not** inventory/order so constitution I exception is scoped and ADR-documented |
| `JwtStrategy` Passport migration (optional) | Needed to enforce `passwordChangedAt` revocation (Q3) cleanly inside Passport `validate()` | Manual `JwtGuard` could patch `iat` check inline but duplicates Passport logic; `passport-jwt` is already in stack via `@nestjs/jwt` family, so migration is minimal |

---

## Phase 0: Research (completed → research.md)

All `NEEDS CLARIFICATION` resolved (0 in Technical Context; 5 clarify Q&A now integrated). Key decisions: D1 opaque crypto token vs JWT, D2 sha256 hash storage, D3 single-winner `FOR UPDATE` + deterministic prior-token invalidation, D4 passwordChangedAt JWT revocation vs deny-list, D5 `crypto.randomInt` OTP + sha256 + Redis+PG fallback (Q4), D6 WhatsApp provider abstraction + Noop for test, D7 `passport-google-oauth20` + auto-link verified email (Q1) + `password` nullable, D8 rate-limit Redis `INCR/SET NX EX` fail-open, D9 optional `JwtStrategy` Passport migration, D10 post-commit notification, D11 login OTP choice (Q2) + deferred email OTP. See `research.md` for rationale and alternatives.

## Phase 1: Design (completed)

- **Data model** → [data-model.md](./data-model.md): User alterations (`phoneNumber`, `phoneVerified`, `googleId`, `provider`, `password nullable`, `passwordChangedAt`, partial uniques, CHECK), `PasswordResetToken` (hashed, expiry, usedAt), `OtpVerification` (purpose login|verify_phone, fallback), migrations, validation & state transitions, RBAC/rate-limit notes.
- **Contracts** → [contracts/auth-contracts.md](./contracts/auth-contracts.md): `POST /auth/forgot-password` (anti-enum), `POST /auth/validate-reset-token`, `POST /auth/reset-password` (single-use tx + revocation), `POST /auth/otp/request`, `POST /auth/otp/verify` (V1 login/verify_phone only), `GET /auth/google`, `GET /auth/google/callback` (JSON per Q5), `GET /auth/google/link` (JwtGuard), error mapping `400/401/429/409`, rate-limit table.
- **Quickstart** → [quickstart.md](./quickstart.md): Env + Docker setup, manual curl for each flow (happy, invalid, concurrent token race, OTP cooldown/attempts, Redis-down fallback, JWT revocation, Google mocked), test commands (`--runInBand`), DB constraint verification, Swagger check.

### Agent context update

`AGENTS.md` marker `<!-- SPECKIT START -->` … `<!-- SPECKIT END -->` updated to point to this plan (`specs/005-auth-upgrades/plan.md`) via `setup-plan.ps1` + manual edit. Verify with `grep -n SPECKIT AGENTS.md` or `cat AGENTS.md`.

## Re-evaluated Constitution Check (post-design)

No new code or decisions introduced in Phase 1 that would violate principles. Post-design gate remains **PASS** on all nine principles (same table as above). Q1-Q5 clarifications are consistent with auth orthogonality and do not introduce inventory/order authority or new microservices. Complexity items (OTP fallback, optional JwtStrategy) remain scoped and justified.

## Next Steps (Phase 2 — not in this command)

`/speckit.tasks` will break Phase 16 into ordered tasks (e.g.: 1) failing DTO + User migration tests; 2) PasswordResetToken entity/migration/repo; 3) forgot/reset/validate flows with `FOR UPDATE` + revocation; 4) OTP entity/migration + WhatsAppProvider Noop + request/verify with fallback; 5) GoogleStrategy + handleGoogleLogin (auto-link, JSON) + JwtStrategy migration; 6) rate-limit guard + config + tests; 7) verify `npm run lint/build/test -- --runInBand` + E2E `test/jest-e2e.json` + Swagger/ADRs).
