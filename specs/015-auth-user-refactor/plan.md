# Implementation Plan: Auth + Users Refactor (RP-AUTH)

**Branch**: `015-auth-user-refactor` | **Date**: 2026-10-02 | **Spec**: `specs/015-auth-user-refactor/spec.md`
**Input**: Feature specification from `/specs/015-auth-user-refactor/spec.md`

## Summary

Behavior-preserving refactor of `src/modules/auth` + `src/modules/users` per
`docs/REFACTOR_PLAN.md` §RP-AUTH: `AuthService` (1267 lines) becomes a thin
orchestrator over intent-based stores (`RefreshTokenStore`, `VerificationTokenStore`,
`PasswordResetTokenStore`, `OtpStore`) with `UsersService` as the sole user-row
writer; controllers go tx/persistence-free; `JwtGuard` becomes the sole JWT path
with the tokenVersion check (S-1); reset becomes the sole token authority (S-2);
the register response drops the leaked password-hash key (D3). Everything else is
byte-identical (routes, bodies, cookies, headers, events, TTLs, fail-open).
RateLimitGuard and the EMAIL_PROVIDER factory are explicitly frozen for later
phases. Full baseline-first verification (contract matrix + real-PG single-winner
races). See `research.md` (D1–D8), `data-model.md`, `contracts/auth-user-parity.md`.

## Technical Context

**Language/Version**: TypeScript 5.x (NestJS 11, existing repo — no change)
**Primary Dependencies**: `@nestjs/jwt` + `passport-jwt` (verify only), `bcrypt`,
  `typeorm` (EntityManager tx), `@nestjs/cache-manager` (Redis cooldown/OTP/counters,
  fail-open), `@nestjs/microservices` `ClientProxy` (post-commit auth events)
**Storage**: PostgreSQL 17 authoritative (`user`, `refresh_token`,
  `password_reset_token`, `email_verification_token`, `otp_verification`); Redis for
  TTL/cooldown/rate state only; **no migration in this phase**
**Testing**: Jest (`*.spec.ts` unit with fakes for Clock/TokenHasher/stores;
  `test/*.integration.spec.ts` on real PG incl. `Promise.all` single-winner races;
  supertest E2E for the contract matrix)
**Target Platform**: Linux server (Docker Compose: postgres/redis/rabbitmq), Node.js
**Project Type**: Backend web-service (REST), modular monolith
**Performance Goals**: No perf target — parity only; added `INSERT`/`SELECT` per flow
  must stay within existing per-request shape (query diffs are signals, PQ-1)
**Constraints**: Zero public API/event/queue/schema delta except the three approved
  `[S]` rows; auth+users files only; no new `any` without justification; JSDoc +
  intent comments per AGENTS.md §3; `synchronize` untouched
**Scale/Scope**: ~2 modules, ~30 service methods → orchestrator + 5 stores + 1 publisher;
  14 REST routes + 1 users route in the parity matrix; 3 approved S-deltas with
  regression tests

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-check after Phase 1 design.*

| Principle | Status | Evidence / Note |
|---|---|---|
| I. PG source of truth | ✅ PASS | Token/user authority stays PG; Redis = TTL/cooldown/rate only, fail-open preserved |
| II. Modular monolith, service-only collaboration | ✅ PASS | Removes `manager.getRepository(User)` bypasses; all user writes via `UsersService`; no new modules |
| III. Inventory/reservation lifecycles | ✅ N/A | Untouched by this phase (FR-009 scope fence) |
| IV. DB-level concurrency | ✅ PASS | `FOR UPDATE` + single-winner races preserved and re-proved (refresh/reset/verify) |
| V. Thin controllers, service-owned logic | ✅ PASS | Controllers tx/persistence-free; HTTP shaping moves fully to controller |
| VI. Spec-driven | ✅ PASS | Spec + 5 clarify answers + 3 S-approvals precede this plan |
| VII. DB-backed tests | ✅ PASS | Real-PG integration + race proofs; fakes only for Clock/Hasher/ports |
| VIII. No invented APIs/payments | ✅ PASS | Routes/DTOs frozen; sole wire delta is the approved D3 key-strip |
| IX. Docs as work | ✅ PASS | research/data-model/contracts/quickstart written; ADR follow-up at implementation |
| Async-after-commit; idempotency; RL-correctness; migrations | ✅ PASS | Publisher after commit; single-use semantics kept; RL frozen + never in-tx; no migration |

Post-design re-check: no new violations introduced (frozen guard/factory callouts in
FR-009 keep RP-CACHE-GUARD/RP-NOTIF ownership intact).

## Project Structure

### Documentation (this feature)

```text
specs/015-auth-user-refactor/
├── plan.md              # This file (/speckit.plan command output)
├── research.md          # Phase 0 output (D1–D8 decisions)
├── data-model.md        # Phase 1 output (ownership map, no schema change)
├── quickstart.md        # Phase 1 output (baseline → slices → gates)
├── contracts/
│   └── auth-user-parity.md  # Phase 1 output (behavioral gate matrix)
└── tasks.md             # Phase 2 output (/speckit.tasks command - NOT created by /speckit.plan)
```

### Source Code (repository root)

```text
src/
├── modules/
│   ├── auth/
│   │   ├── auth.controller.ts      # HTTP shaping only (429/cooldown translation, cookies/headers); console.log → Logger; sub-for-id (S-1 companion)
│   │   ├── auth.service.ts         # thinned to orchestrator (owns tx boundaries, calls stores)
│   │   ├── stores/                 # NEW: refresh-token.store.ts, verification-token.store.ts,
│   │   │                           # password-reset-token.store.ts, otp.store.ts (tx-scoped manager in, never commit)
│   │   ├── auth-event.publisher.ts # NEW: post-commit emit seam (frozen signature for CC-C)
│   │   ├── auth-token.config.ts    # NEW: full typed AuthTokenConfig, parse-once (clarified Q4)
│   │   ├── guards/jwt.guard.ts     # unified path + tokenVersion check (S-1)
│   │   ├── strateges/ → strategies/  # path-hygiene move only (DC-1 evidence via build)
│   │   └── test/                   # baseline matrix + race suites + S-1/S-2/D3 regressions
│   └── users/
│       ├── users.service.ts        # extended write API (same names); owns all user writes
│       └── users.controller.ts     # untouched expected (verify zero-persistence)
└── common/                         # vendored-minimal CC-A ports IF absent (TokenHasher/SecureToken/Clock/parseDurationMs, CC-A-compatible signatures)
```

**Structure Decision**: In-module `stores/` + single-file publisher/config (no new top-level
module — auth stays self-contained per FR-009); shared `src/common/` touched only if the
CC-A ports don't already exist, vendored with identical semantics.

## Design Constraints (HOW — moved here from spec per WHAT/HOW split)

Spec states observable behavior; this section states the structural rules that
implement it (details in `research.md` D1–D8, all preserved verbatim):

- **TX ownership (FR-003)**: use-case service owns `dataSource.transaction`;
  stores receive the tx-scoped `EntityManager` and never commit/rollback/open
  nested transactions (TX-1/TX-2, invariant TI-3).
- **Module boundary (FR-002/FR-004)**: no `manager.getRepository(User)` in auth
  (replace `:264,432,599` via extended `UsersService`); no
  `DataSource`/repository/`EntityManager` in controllers (invariant TI-1).
- **Locking (FR-005)**: `FOR UPDATE` on token/refresh rows where the current
  code locks; single-winner preserved (TI-8).
- **S-1 mechanics**: unified `JwtGuard` = `JwtService.verifyAsync` + Bearer
  extract + `UsersService` lookup + `tokenVersion` (+`passwordChangedAt`/`iat`
  fallback) check, exact strategy messages; `request.user` keeps payload shape;
  `logoutAll`/`googleLink` switch `(user).id` → `sub`; `JwtStrategy`/
  `JwtAuthGuard` retained but off the request path (research D1).
- **S-2 mechanics**: `validateResetToken` stays plain `findOne` (advisory);
  `resetPassword` revalidates under `FOR UPDATE` then consumes atomically
  (research D2).
- **D3 mechanics**: strip only the `password` key from register `data`
  (research D3).
- **HTTP boundary (FR-007)**: `VerificationCooldownError(retryAfterMs)` thrown
  by service, translated by controller to identical 429 + `Retry-After`;
  zero `HttpException` left in service.
- **Purity (FR-010)**: `TokenHasher`/`SecureToken`/`Clock`/`parseDurationMs`
  (CC-A-compatible); triple TTL parse unified with identical outputs.
- **Config (FR-011)**: full typed `AuthTokenConfig` parsed once at startup,
  warn-once fallbacks, identical values, no new hard-fail (OD-1/CF-1).
- **Abstraction gate (FR-010)**: Rule-of-Three (≥3 sites, one reason); no
  generic `Base/Generic/StateMachine/Repository` (MF-1); two-site merges only
  if touched; size is a signal (SG-1); queries are signals (PQ-1); deletions
  need reachability evidence (DC-1).
- **Docs (FR-013)**: JSDoc + `@param/@returns/@throws` per AGENTS.md §3;
  `//` intent comments on complex conditions and calculations.

## Complexity Tracking

> Only items requiring justification beyond the R-baseline (all are approved S-deltas):

| Violation | Why Needed | Simpler Alternative Rejected Because |
|---|---|---|
| S-1: JwtGuard gains DB lookup + tokenVersion check | Closes revocation bypass on the de-facto guard path (approved 2026-10-02) | Keeping dual paths preserves a security hole; entity-shape unification churns all consumers (research D1) |
| S-2: reset revalidates under lock while validate stays unlocked | Closes TOCTOU at the single authority point without adding read-path contention (approved 2026-10-02) | Locking validate adds contention with zero gain once reset is authoritative (research D2) |
| D3: register 201 drops `data.password` key | Baseline proves the bcrypt hash is returned in the body — irreconcilable with the approved no-leak pin (approved shape-keep otherwise) | Byte-identical keep would keep leaking credential material (research D3) |
| 5 stores + publisher + typed config (new units) | Splits the 1267-line god service at tx/persistence/transport seams; each meets Rule-of-Three, no framework abstraction (MF-1) | Leaving the god service keeps HTTP-in-domain, bypasses, and triple-duplicated logic that downstream phases inherit |
