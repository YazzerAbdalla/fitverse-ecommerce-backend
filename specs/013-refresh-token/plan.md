# Implementation Plan: Refresh Token Rotation — Phase 17

**Branch**: `013-refresh-token` | **Date**: 2026-09-23 | **Spec**: [spec.md](./spec.md)
**Input**: Feature specification from `/specs/013-refresh-token/spec.md` (Phase 17 — opaque `RefreshToken` `crypto.randomBytes(32)`+`sha256`, `POST /auth/login`+`GET /auth/google/callback` issue `{accessToken 15m, refreshToken 64hex 7d}`+`HttpOnly` cookie, `POST /auth/refresh` `FOR UPDATE` single-use rotation + theft revoke-all, `POST /auth/logout` idempotent `200`, `POST /auth/logout-all` `JwtGuard tokenVersion++`+bulk revoke, cap 5 LRU, dual `10/h IP`+`5/h hash` rate-limit fail-open, `7d` purge)

## Summary

Extend `POST /auth/login` (and `GET /auth/google/callback`) to also issue an opaque refresh token (`64` hex `crypto.randomBytes(32)`, persisted as `sha256` `RefreshToken` `expiresAt=now+7d` `revokedAt NULL` + `Set-Cookie: refresh_token` `HttpOnly` `Secure` `SameSite=Strict` `Path=/auth`) and add `POST /auth/refresh` (public, body `refreshToken` OR `Cookie` fallback, `FOR UPDATE` lookup `revokedAt IS NULL && expiresAt > NOW()` → `UPDATE old.revokedAt=NOW()` + `INSERT new` + `sign {sub,email,fullName,role,tokenVersion}` inside `DataSource.transaction`), `POST /auth/logout` (public, idempotent `200`), `POST /auth/logout-all` (`JwtGuard`, `tokenVersion++` + `UPDATE revokedAt=NOW() WHERE userId AND revokedAt IS NULL` atomic). Preserve Phase 16 `tokenVersion` nuke (`reset-password` already `++`), add cap 5 active LRU eviction, dual rate-limit buckets `10/h IP` + `5/h tokenHash 6-prefix` via `CACHE_MANAGER` `rl:*` fail-open outermost before `JwtGuard`, `7d` purge `DELETE WHERE revokedAt/expir expires < NOW()-7d`, `X-Email-Unverified` warn header when `emailVerified=false`. No `RefreshToken` in Redis/RabbitMQ truth — PG `FOR UPDATE` single-winner prevents double-issue under `Promise.all`. 8 SCs with real PG `--runInBand` proofs (`stock`/`reservedAmount` zero mutation from auth, reuse `401`+theft revoke-all).

## Technical Context

**Language/Version**: TypeScript 5.7.3 / Node 20, NestJS 11  
**Primary Dependencies**: `@nestjs/typeorm` 11 + `typeorm` 1.1 + `pg` 8.22, `@nestjs/jwt` 11 + `JwtService.signAsync` (`JWT_SECRET`, `JWT_EXPIRES_IN=15m`), `passport-jwt` + `passport-local` + `passport-google-oauth20` (`GoogleStrategy`), `bcrypt` 10, `class-validator`/`class-transformer` (`ValidationPipe` `whitelist/forbidNonWhitelisted`), `@nestjs/cache-manager` + `@keyv/redis` + `ioredis` 5.11 (shared `REDIS_URL` for `RateLimitGuard` `rl:*` `INCR+EXPIRE` fail-open, no new client), `@nestjs/config` `ConfigService` (`REFRESH_TOKEN_TTL=7d`, `REFRESH_TOKEN_COOKIE_NAME=refresh_token`, `REFRESH_TOKEN_COOKIE_SECURE`, `REFRESH_RL_*`), `cookie-parser` 1.4.6 (new — for `req.cookies` fallback `req.headers.cookie`), `crypto` (`randomBytes`, `createHash sha256`, `timingSafeEqual`), Jest `ts-jest` + `supertest`. No new payment/email deps.  
**Storage**: PostgreSQL 17 via TypeORM (`synchronize:false`, new migration `17xxxxxxxxxx-CreateRefreshToken` — `RefreshToken` `id uuid PK`, `userId FK CASCADE @Index`, `tokenHash varchar(255) @Index`, `expiresAt timestamptz CHECK>createdAt`, `revokedAt nullable`, `createdAt`/`updatedAt`, indexes `userId`/`tokenHash`/`expiresAt`/`userId,expiresAt`, partial unique `UQ_refresh_token_hash_active UNIQUE(tokenHash) WHERE revokedAt IS NULL` optional; `User.tokenVersion int default 0` + `passwordChangedAt` already from Phase 16 `1755900000000-AuthUpgradesUserAndResetToken`, no `User` schema change); Redis 8 ephemeral for `rl:POST /auth/refresh:ip:*` `10/3600` + `rl:POST /auth/refresh:hash:<6prefix>` `5/3600` + `rl:POST /auth/logout:ip:*` `20/3600` + `rl:POST /auth/logout-all:user:*` `10/3600` (+ optional `idempotency:duplicate:skipped:refresh` `INCR EX 86400` per theft). RabbitMQ 4 not used this phase (no new queue).  
**Testing**: Jest unit (mock `DataSource`/`EntityManager` `getRepository` spies + `CacheManager` mock `get/set/del` `FLUSHDB` + `JwtService` mock + `ConfigService`) + integration real PG `FOR UPDATE` deterministic lock ordering + real Redis `FLUSHDB` (`--runInBand`, `EXPLAIN`) + E2E `supertest` `register→login {accessToken,refreshToken} 64hex → GET /order 200 → POST /auth/refresh rotation → reuse 401 theft→revoke-all → logout idempotent 200 → logout-all tokenVersion 1→ refresh 401 → GET /order 401`). `npm run test`, `npm run build`, `npm run lint`, `npm run test:e2e`.  
**Target Platform**: Linux server (NestJS HTTP via `docker-compose.yml`: postgres 17, redis 8, rabbitmq 4) — same as Phases 1-12, no frontend.  
**Project Type**: Modular monolithic backend — REST `auth` domain only; refresh is auth-scoped hardening inside `DataSource.transaction` guards, orthogonal to `inventory`/`reservation`/`order` (those `CHECK`s/`FOR UPDATE` untouched, auth touches zero `stock`/`reservedAmount`).  
**Performance Goals**: `POST /auth/login` (bcrypt `10` + `INSERT RefreshToken` + `sign`) p95 <300ms; `POST /auth/refresh` (`FOR UPDATE` + `sha256` + `UPDATE old` + `INSERT new` + `sign`) p95 <50ms (no Redis inside transaction); concurrent `refresh` same hash `Promise.all` single-winner p95 <80ms; `POST /auth/logout` `UPDATE WHERE tokenHash AND revokedAt IS NULL` p95 <10ms; `POST /auth/logout-all` (`FOR UPDATE User` + `UPDATE RefreshToken` bulk) p95 <20ms; `429` path `0` `DataSource.transaction` calls; `SET NX`/`INCR` rate-limit p95 <2ms (fail-open on `ECONNREFUSED`).  
**Constraints**: `synchronize:false` (migration only); PG authoritative (constitution I) — `RefreshToken` rows are truth, Redis `rl:*` is limiter cache only `FLUSHDB` retains PG rows; `RateLimitGuard` outermost `@UseGuards(RateLimitGuard)` before `JwtGuard`/`ValidationPipe` so `429` holds no `FOR UPDATE` lock; `cookie-parser` `app.use(cookieParser())` in `main.ts` before `ValidationPipe`; `HttpOnly` `Secure` `SameSite=Strict` `Path=/auth` `Max-Age=604800`; `ValidationPipe` `whitelist/forbidNonWhitelisted` rejects unknown fields before `200` idempotent; `AllExceptionsFilter` serializes `401/429/400` `{statusCode,message,timestamp}` + forwards `Retry-After`/`X-RateLimit-*`; `Logger` only (no `console.log`); `ConfigService` for all TTLs/secrets; `FOR UPDATE` single-winner deterministic (no `SKIP LOCKED` needed for refresh).  
**Scale/Scope**: Touches `src/modules/auth/auth.service.ts` (extend `login` + new `refresh`/`logout`/`logoutAll` + `handleGoogleLogin` refresh issuance), `auth.controller.ts` (3 new routes + updated `googleCallback`), `entities/refresh-token.entity.ts` **new**, `dto/refresh-token.dto.ts` **new**, `strategies/jwt.strategy.ts` (already `tokenVersion` check, verify), `guards/rate-limit.guard.ts` (add 3 keys with dual bucket for refresh), `users/entity/user.entity.ts` (read-only `tokenVersion`, no schema change), `src/migration/17xxxxxxxxxx-CreateRefreshToken.ts` **new**, `src/app.module.ts`/`main.ts` (cookieParser), `src/modules/auth/auth.module.ts` (providers `JwtModule`/`TypeOrmModule.forFeature`), `.env/.env.example` (4 new vars); 0 inventory/reservation/order semantic changes (only `SELECT count(*) FROM refresh_token` proofs).

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-check after Phase 1 design.*

| Principle | Status | Evidence |
|-----------|--------|----------|
| **I. PostgreSQL is source of truth** | ✅ PASS | `RefreshToken` persisted in PG (`tokenHash=sha256`, `expiresAt`, `revokedAt`) is authoritative; Redis holds only `rl:*` rate-limit counters `FLUSHDB` loses limiter but PG rows remain valid; `POST /auth/refresh` does `SELECT ... FOR UPDATE where tokenHash=:hash` inside `DataSource.transaction` and verifies `revokedAt IS NULL && expiresAt > NOW()` against PG, never against cache; RabbitMQ not used this phase. |
| **II. Modular monolith — no premature microservices** | ✅ PASS | Single Nest process augmentation inside `AuthModule`; no new service/process; `RefreshToken` lives in `auth` domain, `UsersService` still owns `User` CRUD via `DataSource.getRepository(User)` not `@InjectRepository(User)` cross-boundary (same pattern as Phase 16 `PasswordResetToken` in `auth`); single `DataSource`/`CACHE_MANAGER`/`CookieParser` reuse per `AppModule`. |
| **III. Inventory/Reservation separate domains, explicit lifecycle** | ✅ PASS | No domain change: `Product` no `stock`, `Inventory available=stock-reservedAmount` derived `CHECK`, `Reservation RESERVED→EXPIRED/COMPLETED/CANCELLED` one-way still enforced; auth refresh touches zero `stock`/`reservedAmount` (`UPDATE inventory` `0` in SC-008); `checkout` cart-only remains, `OrderCompletion` `COMPLETED→COMPLETED 200` unchanged. |
| **IV. Concurrency safety at DB level (no overselling)** | ✅ PASS | Refresh rotation uses `FOR UPDATE` on `RefreshToken` row (`SELECT WHERE tokenHash=:hash FOR UPDATE` inside `dataSource.transaction`) to serialize `Promise.all([refresh,refresh])` single-winner → one `200` + rotation, one `401` theft revoke-all, no double `INSERT`; cap 5 LRU `SELECT ... FOR UPDATE` on oldest before eviction; `logout` vs `refresh` race `FOR UPDATE` vs `UPDATE WHERE revokedAt IS NULL` single-winner; no `stock` mutation so oversell impossible. |
| **V. Module boundaries, service-only collaboration** | ✅ PASS | `AuthService` owns `RefreshToken` business API (`login` extension, `refresh`, `logout`, `logoutAll` + `handleGoogleLogin` refresh); `UsersService` owns `User` CRUD; no other module `@InjectRepository(RefreshToken)`; `AuthController` thin (`@Body`/`@Req` → `authService.*`), `RateLimitGuard` exported from `AuthModule` already and reused; `OutboxModule`/`InventoryModule` untouched. |
| **VI. Spec-driven development** | ✅ PASS | Spec `spec.md` + 10 clarifications (5 kickoff `docs/plan.md` §17 + 5 session 2026-09-23 Google refresh A, cap 5 LRU C, dual IP+hash B, 7d purge B, emailVerified allow+warn C) done before plan; no future phase (Email 18/Payment 19) implemented; Phase 17 is auth-only orthogonal to Phases 7-13 per plan §17 rationale. |
| **VII. Tests mandatory, DB-backed for consistency** | ✅ PASS | Integration real PG `FOR UPDATE` + real Redis `FLUSHDB` `--runInBand` + `EXPLAIN` for `tokenHash` lookup + concurrent `refresh` reuse 401 theft; unit mocks `DataSource` `CACHE_MANAGER` `INCR` + `JwtService` `sign` + `ConfigService` `parseTtlMs`; E2E `supertest` `register→login→refresh→reuse 401→logout 200→logout-all tokenVersion 1→GET /order 401`; DB for consistency not mocked. |
| **VIII. No invented APIs/payments/business rules** | ✅ PASS | Routes are spec-driven only: `POST /auth/refresh` (FR-003), `POST /auth/logout` (FR-004) `200` idempotent anti-enum, `POST /auth/logout-all` `@Auth` (FR-005); `Set-Cookie: refresh_token` + dual body/cookie per FR-008; cap 5 LRU + 7d purge per clarifications Q2/Q4; `X-Email-Unverified` per Q5 C; no `Payment`/`EmailVerificationToken`; theft revoke-all per FR-003 Q theft. |
| **IX. Documentation is part of work** | ✅ PASS | This plan + `research.md` (D1-D8), `data-model.md` (RefreshToken entity + constraints + LRU + lifecycle), `contracts/auth-refresh-contracts.md` (3 endpoints + cookie+body envelope + rate-limit headers), `quickstart.md` (`.env` 4 vars, `docker-compose`, `npm run build`, manual login→refresh→reuse→logout→logout-all, `psql` SELECT, `FLUSHDB` 429), `AGENTS.md` marker updated to this plan, `docs/architecture/auth-refresh.md` + `docs/decisions/ADR-refresh-token.md`. |

**Gate result**: **PASS** — no violations. Post-design re-check below remains **PASS** (refresh is PG `FOR UPDATE` + `sha256` hash auth hardening, not a new distributed truth).

## Project Structure

### Documentation (this feature)

```text
specs/013-refresh-token/
├── plan.md              # This file (/speckit.plan command output)
├── research.md          # Phase 0 output — decisions D1-D8 (opaque vs JWT, rotation vs reuse, dual transport, theft detection, JwtTokenVersion reuse, cap 5 LRU, dual rate-limit, 7d purge)
├── data-model.md        # Phase 1 output — RefreshToken entity (tokenHash, expiresAt CHECK, revokedAt, indexes, UQ partial, cap 5 LRU), User tokenVersion (no schema change), lifecycle Login→Refresh→Logout→LogoutAll
├── quickstart.md        # Phase 1 output — setup .env REFRESH_* 4 vars, cookie-parser, docker-compose, npm run build/migration:run, manual login→refresh→reuse 401 theft→logout 200→logout-all tokenVersion++ proofs, psql SELECT, 429, tests
├── contracts/
│   └── auth-refresh-contracts.md # Phase 1 output — POST /auth/login extended, POST /auth/refresh (body|cookie, FOR UPDATE, 200+Set-Cookie vs 401 theft), POST /auth/logout 200 idempotent, POST /auth/logout-all JwtGuard 200 tokenVersion++ + bulk revoke, rate-limit headers
├── checklists/
│   └── requirements.md  # Spec quality checklist (16/16 pass)
└── tasks.md             # Phase 2 output (/speckit.tasks — NOT created by /speckit.plan)
```

### Source Code (repository root)

```text
src/
├── modules/
│   ├── auth/
│   │   ├── entities/
│   │   │   ├── password-reset-token.entity.ts # existing — reference (sha256, FOR UPDATE pattern)
│   │   │   ├── otp-verification.entity.ts     # existing
│   │   │   └── refresh-token.entity.ts        # NEW — RefreshToken {id,userId,tokenHash,expiresAt,revokedAt,createdAt,updatedAt} + @Check expiresAt>createdAt + indexes + partial UQ
│   │   ├── dto/
│   │   │   ├── user-register.dto.ts           # existing
│   │   │   ├── login.dto.ts                   # existing (unchanged)
│   │   │   └── refresh-token.dto.ts           # NEW — RefreshTokenDto {refreshToken?: string @IsString @Length(64,64) @Matches(/^[0-9a-f]{64}$/) @IsOptional()} + LogoutDto same
│   │   ├── guards/
│   │   │   ├── jwt-auth.guard.ts              # existing — already checks tokenVersion === user.tokenVersion else 401
│   │   │   ├── rate-limit.guard.ts            # MODIFY — add DEFAULT_LIMITS keys: 'POST /auth/refresh' {max 10 window 3600 ip+hash 5}, 'POST /auth/logout' 20/ip, 'POST /auth/logout-all' 10/user (+ Gql hash prefix handling) + dual bucket check for refresh (INCR two keys)
│   │   │   └── local-auth.guard.ts / google-auth.guard.ts # existing
│   │   ├── strategies/
│   │   │   ├── jwt.strategy.ts                # VERIFY — validate(payload) loads User, if payload.tokenVersion !== user.tokenVersion throw 401 (already Phase 16)
│   │   │   └── google.strategy.ts             # existing
│   │   ├── decorators/
│   │   │   └── current-user.decorator.ts     # existing
│   │   ├── auth.service.ts                    # MODIFY — extend login(user) to create RefreshToken (cap 5 LRU + sha256 + 7d + Set-Cookie helper), new refresh(dtoRaw, cookieRaw): Promise<{accessToken,refreshToken}> { dataSource.transaction FOR UPDATE + theft revoke-all + cap + sign + Logger prefix }, logout(refreshToken|cookie): Promise<void> { UPDATE revokedAt idempotent }, logoutAll(userId): Promise<void> { SELECT User FOR UPDATE + tokenVersion++ + bulk revokedAt }, handleGoogleLogin(profile): add refresh issuance same as login
│   │   ├── auth.controller.ts                 # MODIFY — POST /auth/login already uses RateLimitGuard(LocalAuthGuard) → return {accessToken, refreshToken} + @Res cookie; new POST /auth/refresh @UseGuards(RateLimitGuard) public { dto.refreshToken ?? req.cookies[cookieName] } → authService.refresh + res.cookie + X-Email-Unverified header; POST /auth/logout public similar; POST /auth/logout-all @Auth() @UseGuards(RateLimitGuard,JwtGuard) → authService.logoutAll(currentUser.sub) + Swagger 401/429
│   │   └── auth.module.ts                     # MODIFY — imports: TypeOrmModule.forFeature([User, RefreshToken, PasswordResetToken]), JwtModule, CacheModule, ConfigModule; providers: AuthService, JwtStrategy, RateLimitGuard, Logger; controllers: [AuthController]; exports: [AuthService, RateLimitGuard]
│   ├── users/
│   │   └── entity/user.entity.ts              # VERIFY/UNCHANGED — tokenVersion int default 0 (Phase 16), no schema change; read via DataSource.getRepository(User) in auth.service
│   └── inventory/ reservation/ order/ cart/ products # UNCHANGED — zero mutation by auth (SC-008 proof)
│   ├── app.module.ts                          # VERIFY — already imports AuthModule + CacheModule global + TypeOrmModule global DataSource + BullModule shared REDIS_URL; may need to ensure TypeOrmModule.forFeature includes RefreshToken via AuthModule import
│   ├── main.ts                                # MODIFY — import cookieParser from 'cookie-parser'; app.use(cookieParser()); before app.useGlobalPipes(ValidationPipe)
│   ├── migration/
│   │   └── 17xxxxxxxxxx-CreateRefreshToken.ts # NEW — CREATE TABLE "RefreshToken" (id uuid, userId uuid FK CASCADE, tokenHash varchar 255, expiresAt timestamptz, revokedAt timestamptz, createdAt, updatedAt) + CHECK expiresAt > createdAt + indexes + partial UQ + FK
│   ├── .env / .env.example                    # MODIFY — add REFRESH_TOKEN_TTL=7d, REFRESH_TOKEN_COOKIE_NAME=refresh_token, REFRESH_TOKEN_COOKIE_SECURE=true, REFRESH_RL_MAX=10 REFRESH_RL_WINDOW_MS=3600000 LOGOUT_RL_MAX=20 LOGOUT_ALL_RL_MAX=10
│   └── docs/architecture/
│       └── auth-refresh.md / ADR-refresh-token.md # NEW/MODIFY — opaque sha256 + FOR UPDATE + theft revoke-all + cap 5 + dual rate-limit + 7d purge + X-Email-Unverified
```

**Structure Decision**: Single project (Option 1) — auth-scoped extension inside existing `src/modules/auth` with PG `RefreshToken` `FOR UPDATE` rotation + `sha256` hash + `tokenVersion` reuse + `cookie-parser` + `RateLimitGuard` dual buckets + 7d purge; no new top-level app, `synchronize:false`, single `DataSource`/`CACHE_MANAGER` reuse per `AGENTS.md` module boundaries.

## Complexity Tracking

> Fill ONLY if Constitution Check has violations that must be justified

| Violation | Why Needed | Simpler Alternative Rejected Because |
|-----------|------------|-------------------------------------|
| — | — | — |

*No violations — all gates PASS. Refresh token is additive `if !found || revokedAt || expiresAt<=now → 401` before `INSERT` + `FOR UPDATE` theft guard, not a new store for business truth.*

---

## Phase 0: Research (completed → research.md)

All `NEEDS CLARIFICATION` resolved (0 in Technical Context; 10 clarifications in spec §Clarifications: opaque A, dual A, theft A, logout 200 A, logout-all Both A, Google A, cap 5 C, dual hash B, 7d purge B, emailVerified C). Key decisions: D1 opaque crypto+sha256 vs JWT jti, D2 single-use rotation vs sliding reuse, D3 dual body+cookie vs Bearer header, D4 theft 401+revoke-all vs 401-only, D5 tokenVersion reuse vs per-token version column, D6 cap 5 LRU vs unbounded, D7 dual IP+hash rate-limit vs IP-only, D8 7d purge vs 30d. See `research.md` D1-D8 for rationale and alternatives.

## Phase 1: Design (completed)

- **Data model** → [data-model.md](./data-model.md): `RefreshToken` PG `tokenHash` `sha256` `CHECK expiresAt>createdAt` `revokedAt` `createdAt` `UQ partial` + indexes `(userId,tokenHash,expiresAt)` + cap 5 LRU, `User.tokenVersion` reuse (no schema change), lifecycle `Login(handleGoogleLogin)→Refresh FOR UPDATE theft→Logout 200→LogoutAll tokenVersion++`.
- **Contracts** → [contracts/auth-refresh-contracts.md](./contracts/auth-refresh-contracts.md): `POST /auth/login` extended `{accessToken,refreshToken}+Set-Cookie`, `POST /auth/refresh` (body|cookie, `FOR UPDATE`, `200{accessToken,refreshToken}+Set-Cookie` vs `401`+theft revoke-all + `X-Email-Unverified`), `POST /auth/logout` `200` idempotent, `POST /auth/logout-all` `JwtGuard` `200 tokenVersion++` + bulk revoke, `429` `Retry-After`/`X-RateLimit-*` dual buckets.
- **Quickstart** → [quickstart.md](./quickstart.md): `.env REFRESH_*` 4 vars + `cookie-parser`, `docker-compose up -d`, `npm run build`, `npm run migration:run`, manual `POST /auth/login → POST /auth/refresh → reuse 401 theft → POST /auth/logout 200 → POST /auth/logout-all`, `psql SELECT tokenHash,expiresAt,revokedAt FROM refresh_token`, `FLUSHDB` `429` `FOR UPDATE` `SET NX` `INCR` tests.
- **Agent context** → `AGENTS.md` marker `<!-- SPECKIT START -->` … `<!-- SPECKIT END -->` updated to point to this plan (`specs/013-refresh-token/plan.md`).

### Agent context update

`AGENTS.md` marker updated via script `update-agent-context.ps1` to this plan. Verify with `grep -n SPECKIT AGENTS.md`.

## Re-evaluated Constitution Check (post-design)

No new code or decisions in Phase 1 violate principles. Post-design gate remains **PASS** on all nine principles (same table as above). Refresh rotation strengthens Principle IV (PG `FOR UPDATE` single-winner no double-issue) without making Redis authoritative; `cookie-parser` is transport only; `X-Email-Unverified` is advisory not gate.

## Next Steps (Phase 2 — not in this command)

`/speckit.tasks` will break Phase 17 into ordered tasks (e.g.: 1) add `RefreshToken` entity + migration `17xxxxxxxxxx-CreateRefreshToken` + `CHECK`/`UQ`/`FK`; 2) add `RefreshTokenDto` + `cookie-parser` `main.ts`; 3) extend `RateLimitGuard` 3 keys + dual IP+hash for refresh + `ConfigService` overrides; 4) extend `AuthService.login` + `handleGoogleLogin` to create `RefreshToken` cap5 LRU `sha256` `7d` + return `{accessToken,refreshToken}`; 5) add `AuthService.refresh` `FOR UPDATE` theft revoke-all + cap + sign + `X-Email-Unverified`; 6) add `logout`/`logoutAll` `FOR UPDATE` `tokenVersion++` + bulk revoke; 7) wire `AuthController` 3 routes + `res.cookie` `HttpOnly/Secure/SameSite/Path/Max-Age` + Swagger `401/429`; 8) concurrency `Promise.all([refresh,refresh])` `200+401` theft + `login×6` cap LRU + `7d` purge job + `X-Email-Unverified` integration real PG `FLUSHDB` + `parseTtlMs d` + `synchronize:false`; 9) E2E `supertest` `register→login→GET /order 200→refresh 200→reuse 401→logout 200→logout-all 200→GET /order 401→login new tokenVersion 1`; 10) `quickstart` + `.env.example` + `docs/auth-refresh.md`/`ADR-refresh-token.md` + `npm run lint/build/test -- --runInBand/test:e2e`).
