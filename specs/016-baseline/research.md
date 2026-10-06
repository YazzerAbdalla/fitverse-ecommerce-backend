# Research: Reconcile + Baseline (S1)

**Date**: 2026-10-06 | **Spec**: [spec.md](./spec.md) | **Plan ref**: `docs/REFACTOR_PLAN.md` §14 S1

All three `/speckit.clarify` answers are resolved (terminal set, CORS source, gate placement). No NEEDS CLARIFICATION remains. Each decision below records what was chosen, why, and what was rejected.

## R1 — Retention SQL: explicit terminal list + per-leg timestamps

- **Decision**: Replace the broken predicate with an explicit terminal-status list and per-leg age columns in a single statement:
  - `SENT`, `SENT_TO_MQ`, `CONSUMED`, `DELIVERED` age on `sentAt` (set when the broker accepts; retained through later legs).
  - `FAILED` age on `createdAt` (failures may never have a `sentAt`).
  - Defensive `COALESCE(sentAt, createdAt)` for the four success legs so a hypothetical row missing `sentAt` still expires instead of living forever.
  - Keep the existing clamp (`1..365`, default `30`, warn-once on fallback) and the deleted-count return untouched.
- **Rationale**: The bug has two layers — `$2` used as both status and day-count (deletes nothing today), and even a minimal `SENT`+`FAILED` repair would let `SENT_TO_MQ`/`CONSUMED`/`DELIVERED` rows (the states the system actually writes since Phase 18) accumulate forever. One explicit list fixes both layers at once; per-leg timestamps respect the entity lifecycle (`OutboxStatus` enum documents `SENT` as a legacy pre-rename value, semantically equal to `SENT_TO_MQ` but a distinct stored string — so both literals must appear).
- **Alternatives considered**:
  - Minimal `SENT`+`FAILED` fix — rejected: recreates unbounded growth for the three newer legs.
  - Single `createdAt` age for all statuses — rejected: changes retention semantics for in-flight-then-terminal rows (age should run from broker acceptance, matching the documented `OUTBOX_RETENTION_DAYS` intent and the current `sentAt` arm).
  - Query-builder/`Repository.delete` instead of raw SQL — rejected: the current raw `DELETE` is already isolated, tested-shape-stable, and driver-agnostic enough; keep the diff to the predicate + parameter list (smallest behavior-delta, FR-002 single-purpose commit).

## R2 — CORS: static allow-list from config, credentials only for listed origins

- **Decision**: `app.enableCors({ origin: allowList, credentials: true })` where `allowList = [FRONTEND_URL, ...CORS_ORIGINS.split(',')]` (trimmed, empties dropped). Requests with no `Origin` header bypass the list (non-browser clients). Empty/unset list → allow-list is `[FRONTEND_URL]` if set, else fail closed in production (no credentialed origins) with a boot `Logger.warn`; development keeps a warn-and-continue.
- **Rationale**: Nest's `origin: string[]` form reflects only listed origins while `credentials: true` stays scoped to them — the narrowest change from `origin: true` that closes credentialed CSRF without breaking Postman/curl/Stripe-style origin-less callers. `FRONTEND_URL` already exists (`.env.example:34`) so zero-config deployments keep working.
- **Alternatives considered**:
  - Custom `origin` callback function — rejected: more code for identical semantics; static array is auditable at a glance.
  - `origin: false` + manual header handling — rejected: re-implements framework behavior.
  - New `CORS_ORIGINS`-only list (ignoring `FRONTEND_URL`) — rejected: breaks zero-config dev; the clarify decision (C) keeps both.

## R3 — Secret gate: repo-local pattern scan, pre-commit hook + CI step, no new dependency

- **Decision**: A repo-local scan script (`scripts/scan-secrets`) matching `re_[A-Za-z0-9_]{20,}` and `GOCSPX-` (extendable table), wired as (a) a documented local pre-commit hook and (b) a CI pipeline step (repo has neither `.husky/` nor `.github/workflows/` — both are created here). Placeholders from `.env.example` (`re_xxx…`, empty values) must pass. No gitleaks binary, no husky dependency.
- **Rationale**: `AGENTS.md` forbids unprompted dependencies; a ~30-line pattern script covers the two leaked families with zero install friction on Windows/CI. Gitleaks stays a recommended follow-up (noted, not required) once runner images are confirmed. Pre-commit gives instant feedback; CI enforces when hooks aren't installed — exactly the clarify decision (C).
- **Alternatives considered**:
  - Gitleaks binary in CI + pre-commit — rejected for S1: binary availability on Windows dev machines and runners is unverified; revisit after S1 proves the pattern gate.
  - Husky-managed hooks — rejected: new devDependency for one hook; plain script + `core.hooksPath` docs achieve the same without dependency churn.
  - CI-only — rejected: slow feedback; contradicts clarify answer.

## R4 — Characterization: inventory first, pin-only where suites exist

- **Decision**: The reconcile task inventories existing suites before writing anything new. Already present: `jwt-paths.integration.spec.ts` (P0-2 dual-path pins), `token-races.integration.spec.ts` + `verify`/`resend` suites (P0-3/P0-5 material), `baseline-parity.integration.spec.ts` (P0-5). S1 adds only what is missing: retention regression test (no `outbox-cleanup` spec exists), CORS origin matrix test, WS revoked-user pin (P0-4), and any hot-flow gaps the inventory finds. Zero production-code change for US4/US5.
- **Rationale**: Duplicating existing pins wastes the session and risks contradictory twins. The reconcile checklist (FR-011) is the mechanism that forces the inventory-then-fill order.
- **Alternatives considered**:
  - Rewrite all pins fresh — rejected: churn on green suites, higher rework risk.
  - Skip inventory, only add new — rejected: leaves unknown overlap, violates FR-011.

## R5 — No schema, no dependency, no API changes in S1

- **Decision**: S1 ships zero migrations, zero new dependencies, zero route/event/queue changes. The only wire-visible delta is CORS rejection of unlisted credentialed origins (approved `[S]` B-8) plus the cleanup actually deleting (approved `[B]` P0-1).
- **Rationale**: Keeps S1's blast radius to two reviewed behavior deltas; everything else is tests, scripts, and docs. This is what lets S1 close in under a day.
