# Implementation Plan: Reconcile + Baseline (S1)

**Branch**: `016-baseline` | **Date**: 2026-10-06 | **Spec**: [spec.md](./spec.md)
**Input**: Feature specification from `/specs/016-baseline/spec.md`

## Summary

S1 stabilizes the refactor foundation: reconcile merged work (RP-AUTH + token-fold) against the plan, fix the outbox retention predicate as an isolated commit, close CORS credential reflection with a config-driven allow-list, rotate/strip leaked secrets with a two-layer gate, and pin all auth edge behavior plus hot-flow baselines with tests — the latter two with zero production change. See [research.md](./research.md) for the five resolved decisions.

## Technical Context

**Language/Version**: TypeScript (NestJS 11, existing — no change)
**Primary Dependencies**: TypeORM (PostgreSQL 17), `@nestjs/config`, Jest + supertest; no new dependencies (R5)
**Storage**: PostgreSQL 17 via existing `DataSource` (`synchronize: false` verified); Redis/RabbitMQ only as test-environment services, never asserted as truth
**Testing**: Jest unit (`*.spec.ts` beside code) + integration (real PostgreSQL, `--runInBand --forceExit`) + e2e (`test/jest-e2e.json`); new retention matrix in `src/modules/outbox/test/`, CORS matrix at HTTP level
**Target Platform**: Linux containers / local Docker Compose (postgres 5432, redis 6379, rabbitmq 5672); Node server on `PORT` (3000)
**Project Type**: Backend web-service (NestJS modular monolith) — ops + test + two surgical fixes
**Performance Goals**: Retention `DELETE` stays a single statement using existing indexes; no new per-request work except static CORS array lookup
**Constraints**: Two approved behavior deltas only (P0-1 `[B]`, P0-7 `[S]`); everything else must be byte-identical behavior (R); `synchronize` stays `false`; no migrations
**Scale/Scope**: 5 user stories, 11 FRs, 5 SCs; ~0.5–1 day solo; closes only when infra-backed suites run green (no close on skips)

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-check after Phase 1 design.*

| Principle | Status | Evidence |
|---|---|---|
| I. PG source of truth | ✅ Pass | Retention fix keeps PG authoritative; Redis/RMQ untouched by S1 |
| II. Modular monolith | ✅ Pass | Changes stay inside owning modules (outbox service, `main.ts` boot, scripts); no cross-module repo access |
| III. Inventory/reservation lifecycles | ✅ Pass (untouched) | S1 adds only pins for reservation completion idempotency; no lifecycle change |
| IV. DB-level concurrency | ✅ Pass | Retention is a single `DELETE` (no lock ordering implications); race pins use real-PG `Promise.all` single-winner |
| V. Module boundaries | ✅ Pass | Outbox/CORS/scripts each owned by their layer; no new cross-module imports |
| VI. Spec-driven | ✅ Pass | Spec → clarify (3/3) → this plan; reconcile checklist enforces order |
| VII. DB-backed tests | ✅ Pass | Retention matrix + race pins require real PostgreSQL; skips block S1 close |
| VIII. No invented APIs/rules | ✅ Pass | No new routes/fields/events; `CORS_ORIGINS` is config, not API; terminal set comes from the existing enum |
| IX. Docs as work | ✅ Pass | Contracts + quickstart in-spec; plan checkboxes ticked with evidence at close |
| Migrations (never edit committed) | ✅ Pass | Zero migrations in S1 |

Post-design re-check: no new gates introduced by research (R1–R5 confirm zero-schema/zero-dep). No violations → Complexity Tracking stays empty.

## Project Structure

### Documentation (this feature)

```text
specs/016-baseline/
├── plan.md              # This file (/speckit.plan command output)
├── research.md          # Phase 0 output (R1–R5, all clarifications resolved)
├── data-model.md        # Phase 1 output (zero-schema-change record)
├── quickstart.md        # Phase 1 output (S1 verification runbook)
├── contracts/           # Phase 1 output
│   ├── retention-cleanup.md   # P0-1 corrected predicate + 9-row matrix
│   └── cors-allowlist.md      # P0-7 allow-list behavior + 4-row matrix
└── tasks.md             # Phase 2 output (/speckit.tasks command - NOT created by /speckit.plan)
```

### Source Code (repository root)

```text
src/
├── main.ts                              # P0-7 CORS allow-list (only prod change #2)
├── modules/
│   ├── outbox/
│   │   ├── outbox-cleanup.service.ts    # P0-1 predicate fix (only prod change #1)
│   │   └── test/
│   │       └── outbox-cleanup.retention.spec.ts   # NEW regression matrix
│   └── auth/test/                       # pins only (jwt-paths, races, resend/verify exist; add WS P0-4 pin + gaps)
scripts/
└── scan-secrets                         # NEW P0-6 pattern gate (pre-commit + CI)
test/                                     # e2e CORS matrix extension
.github/workflows/secret-scan.yml        # NEW CI step (repo has no workflows yet)
.env.example                              # CORS_ORIGINS documented placeholder
```

**Structure Decision**: Single-project default. All paths are real and verified (enum, suites, and example-env lines read during research). Production diff is exactly two files (`outbox-cleanup.service.ts`, `main.ts`) plus config/docs/scripts/tests.

## Complexity Tracking

> **Fill ONLY if Constitution Check has violations that must be justified**

None — no violations.
