# Implementation Plan: Cache Constraints Indexes

**Branch**: `020-cache-constraints-indexes` | **Date**: 2026-10-09 | **Spec**: [spec.md](./spec.md)
**Input**: Feature specification from `/specs/020-cache-constraints-indexes/spec.md`

Closes `docs/plan.md` Phase 9 + Phase 13 demo scope (combined ~0.5 day). Hardens the existing cache-aside in `ProductsService` (selective invalidation, deterministic order, pinned TTLs, never-authoritative proof) and adds audit-first DB backstops (missing `CHECK`s, ≤3 justified indexes with `EXPLAIN`). Key redesign + singleflight deferred post-demo (clarified 2026-10-09).

## Summary

Product catalog reads stay cache-aside but invalidation becomes namespace-safe (no `clear()` on any path), list queries gain deterministic ordering, TTL units are pinned to ms with documented defaults, and a test matrix proves the cache never drives availability/order decisions under warm/cold/down states. In parallel, a data audit precedes one additive migration carrying the missing `CHECK` backstops (known: `Product.price >= 0`) and at most 3 query-proven indexes. No public API, event, queue, or response-shape change.

## Technical Context

**Language/Version**: TypeScript 5.x on Node 20+, NestJS 11
**Primary Dependencies**: `@nestjs/cache-manager` + `@keyv/redis` (ioredis), TypeORM 0.3.x, `pg`, Jest + ts-jest + supertest
**Storage**: PostgreSQL 17 (authoritative) + Redis 8 (read cache only, shared store with `rl:*`, `expiration:*`, `notification:*`, cooldown keys)
**Testing**: Jest unit (mocked `CACHE_MANAGER` — largely exists in `products.service.spec.ts`) + integration on real PG + real Redis (`docker-compose up -d`) + `EXPLAIN` plan assertions
**Target Platform**: Linux server / Docker Compose local dev
**Project Type**: web-service (NestJS modular monolith)
**Performance Goals**: Repeat list reads served from cache; invalidation cost O(product keys), never O(store); hot paths index-backed per `EXPLAIN`
**Constraints**: No public API / event / queue / response-shape change (spec FR-011); no `clear()` on any path; fail-open on cache failure preserved; `synchronize:false` — DDL only via new migration; singleflight + key redesign out of scope
**Scale/Scope**: Demo close-out ~0.5 day. Touch surface: `src/modules/products/products.service.ts` (+ spec), `src/modules/products/entities/product.entity.ts` (+ audit-found entities), one new migration `1755900000013-*`, integration specs, `docs/plan.md` Phase 9/13 checkboxes

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-check after Phase 1 design.*

| Principle | Verdict | Reason |
|-----------|---------|--------|
| I. PG source of truth | PASS | Cache stays read-only; FR-007 proof matrix (warm/cold/down identical order outcomes); invalidation post-commit only, never inside tx |
| II. Modular monolith | PASS | No new modules; changes confined to `products` (+ additive DDL) |
| III. Inventory/reservation domains | PASS | No lifecycle/state change; `available` stays derived, never stored |
| IV. DB concurrency | PASS | No lock-path change; added `ORDER BY` is read-ordering only, lock order untouched |
| V. Module boundaries | PASS | No cross-module repository access; dashboard read path untouched |
| VI. SDD | PASS | spec + clarify completed 2026-10-09 before planning |
| VII. DB-backed tests | PASS | Real-PG constraint + `EXPLAIN` suites and real-Redis invalidation suites are plan deliverables |
| VIII. No invented APIs | PASS | FR-011; migration additive (`CHECK` + ≤3 indexes), no new routes/fields |
| IX. Documentation | PASS | `docs/plan.md` Phase 9/13 checkboxes + decision note updated on landing |

No violations. Complexity Tracking: none.

## Project Structure

### Documentation (this feature)

```text
specs/020-cache-constraints-indexes/
├── plan.md              # This file (/speckit.plan command output)
├── research.md          # Phase 0 output (/speckit.plan command)
├── data-model.md        # Phase 1 output (/speckit.plan command)
├── quickstart.md        # Phase 1 output (/speckit.plan command)
├── contracts/           # Phase 1 output (/speckit.plan command)
│   ├── cache-invalidation.md
│   └── constraints-indexes.md
└── tasks.md             # Phase 2 output (/speckit.tasks command - NOT created by /speckit.plan)
```

### Source Code (repository root)

```text
src/
├── modules/
│   ├── products/
│   │   ├── products.service.ts        # selective invalidation, ORDER BY, TTL pin
│   │   ├── products.service.spec.ts   # extend unit matrix (existing T009/T024/T028-T031 base)
│   │   ├── entities/product.entity.ts # +@Check price>=0 (+ audit findings)
│   │   └── test/products-cache.integration.spec.ts  # NEW real-Redis suite
│   └── <audit-found modules>/         # entity CHECK/index additions only, no logic change
├── migration/
│   └── 1755900000013-CacheConstraintsCloseout.ts  # NEW additive DDL
└── test/ (repo-level e2e helpers as needed)
```

**Structure Decision**: Single-project NestJS modular monolith layout; no new top-level dirs except `contracts/` under the spec dir.

## Design

### D1. Cache hardening (`products.service.ts`)

1. **Delete both `clear()` paths**: `invalidateAllLists` fallback (`products.service.ts:197-201`) and `resetAll` fallback (`:607-614`). Replacement: if `store.keys` is unavailable, fall back to a **version stamp** (`products:list-version` counter `INCR`; list keys embed version, old versions go stale on TTL) — never a flush. Research D1 records the stamp design.
2. **Deterministic order**: `findAndCount` gains `order: { created_at: 'ASC', id: 'ASC' }` so pages are stable across miss/hit (research D4; contract note on page-content stability).
3. **TTL pin**: document ms unit + defaults (list 60_000, single 300_000) in code comment + contract; keep existing `parseTtlMs` warn-on-fallback (research D3).
4. **Keys**: keep `products:list:{page}:{limit}` + `product:{id}` — complete for current params (`findAll` takes only page/limit). FR-004 enforced by a unit test asserting every `findAll` param participates in the key, so future filter/sort additions fail the test until the key extends (research D2).

### D2. Constraints + indexes (audit-first per 2026-10-09 clarification)

1. **Audit step (before migration)**: query live/dev data for violations of each candidate check (`price < 0`, `total < 0`, `amount < 0`, `stock/reserved/quantity` already covered) and run `EXPLAIN` on hot paths (expiry scan, order-by-user, inventory-by-product, order-items-by-order, order-by-createdAt range). Findings recorded in `data-model.md` §Audit.
2. **Known DDL**: `Product.price >= 0` `@Check` (missing today — `product.entity.ts:37-39` bare column). Further `CHECK`s only where audit proves a gap.
3. **Indexes**: ≤3, each with query-pattern evidence + `EXPLAIN` using it. Prime candidates: `Order(createdAt)` (revenue date-range), plus whatever the audit proves missing — no speculative adds.
4. **Migration** `1755900000013-*`: `IF NOT EXISTS` / name-guarded adds (pattern of `0006`), `down` drops added constraints/indexes only. Never edits a committed migration.

### D3. Test matrix

- **Unit (extend `products.service.spec.ts`)**: key-completeness test, selective-`del` on all six mutation paths, `clear()` never called on any path (assert `clear` mock absent/never), deterministic-order passthrough, TTL warn fallback, fail-open get/set/del rejections.
- **Integration NEW `products-cache.integration.spec.ts` (real Redis)**: seed `rl:*` + `expiration:*` + `notification:*` + cooldown keys → run every invalidation path → assert non-product namespaces intact; miss→hit→mutate→miss sequence live.
- **Integration PG**: direct invalid writes rejected (`price -1`, `stock -1`, `reserved > stock`, `quantity 0`); `EXPLAIN` asserts index usage for hot paths; concurrent checkout last-unit single-winner re-proof (constitution IV) untouched-behavior guard.
- **Never-authoritative proof**: checkout outcome identical with cache warm / cold / Redis down (fail-open), asserting no `CACHE_MANAGER` read in availability path.

### D4. Risks

- `ORDER BY` changes page contents vs today (unordered) — accepted, pinned by test; no contract version bump (ordering was never specified).
- Version-stamp fallback adds one `GET` per list read — negligible, documented.
- New `CHECK` fails migration if dirty data exists — mitigated by audit-first gate (blocking precondition for the migration task).

## Re-checked Constitution Check (post-design)

Design introduces no new violations: no API/event/queue change, no lock-path change, no cross-module access, tests DB-backed, docs updated. Gate stands PASS.
