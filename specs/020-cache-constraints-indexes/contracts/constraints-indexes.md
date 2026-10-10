# Contract: Constraints & Indexes Close-out

**Feature**: `020-cache-constraints-indexes` | Migration: `1755900000013-*` (new, additive only)

## New CHECKs

| Table | Constraint | Precondition |
|-------|-----------|--------------|
| `Product` | `"price" >= 0` | audit count of `price < 0` rows = 0, else cleanup first |
| (audit) | further `CHECK`s per `data-model.md` §Audit | same audit-first rule |

## New indexes (≤3, each needs query evidence + EXPLAIN)

| Index | Serving query | Evidence |
|-------|--------------|----------|
| (audit, e.g. `Order(createdAt)`) | revenue/date-range reads | `EXPLAIN` before/after recorded in `data-model.md` |
| (audit) | … | … |

## Rules

1. Additive only: no column drops/renames, no committed-migration edits; `down` drops what `up` added.
2. No speculative indexes; boolean-flag and future-metric columns excluded.
3. Response shapes, status codes, and event payloads unchanged (spec FR-011).
