# Data Model: Reconcile + Baseline (S1)

**Date**: 2026-10-06 | **Spec**: [spec.md](./spec.md) | **Research**: [research.md](./research.md)

S1 makes **zero schema changes** — no migrations, no new tables, no altered columns. This file documents the existing shapes S1 reads and the one configuration shape S1 introduces.

## 1. `outbox_event` (read + delete only)

Existing table, owned by the Outbox module. S1 touches it only through the retention `DELETE`.

| Aspect | Current state | S1 use |
|---|---|---|
| Terminal statuses | `SENT` (legacy pre-rename value), `SENT_TO_MQ`, `CONSUMED`, `DELIVERED`, `FAILED` | Explicit `IN` list in the fixed predicate (clarify Q1) |
| Non-terminal statuses | `PENDING`, `PROCESSING` | Never matched, regardless of age (FR-001) |
| Success-leg age | `sentAt` (set at broker acceptance, retained through `CONSUMED`/`DELIVERED`) | `COALESCE(sentAt, createdAt) < NOW() - retention` |
| Failure-leg age | `createdAt` (`sentAt` may be null) | `createdAt < NOW() - retention` |
| Retention input | `OUTBOX_RETENTION_DAYS`, default `30`, clamped `1..365` | Unchanged, including clamp + warn behavior |

Validation rules enforced by the regression test (not new constraints): old-terminal deleted with count reported; fresh-terminal preserved; old non-terminal preserved; empty table → `0`, no error.

## 2. CORS origin allow-list (new configuration shape, no entity)

| Field | Source | Rule |
|---|---|---|
| Default entry | `FRONTEND_URL` (existing, `.env.example:34`) | Included when non-empty |
| Extension list | `CORS_ORIGINS` (new, optional, comma-separated) | Trimmed, empties dropped, appended to the default |
| Empty/unset | Neither value present | Production: fail closed (no credentialed origins) + boot warn; development: warn-and-continue |

No persistence: the list is resolved once at boot from `ConfigService`. No validation endpoint; origin-less requests bypass the list (FR-006).

## 3. Secret patterns (scan table, no entity)

| Pattern | Family | Must-pass counterexamples |
|---|---|---|
| `re_[A-Za-z0-9_]{20,}` | Resend / SMTP credential | `re_xxxxxxxxxxxxxxxxxxxxxxxxxx` (`.env.example:73`), empty value |
| `GOCSPX-` | Google OAuth client secret | empty value (`.env.example:32`) |

Table lives in `scripts/scan-secrets` and is extendable; placeholders must never match.

## 4. Characterization pins (test-only artifacts)

No production shape. Pins assert current outcomes for: dual authentication paths × revoked session (P0-2), concurrent validate-plus-reset window (P0-3), revoked-user realtime connection (P0-4), and hot-flow baselines (P0-5). New files live beside existing suites (`src/modules/auth/test/`, `src/modules/outbox/test/`, `test/`); missing-only per R4.
