# ADR 0016: Cache + Constraints Close-out — Version-Stamp Invalidation, Deterministic Order, Audit-First DDL (Phases 9+13 Demo)

**Date**: 2026-10-09
**Status**: Accepted
**Spec**: `specs/020-cache-constraints-indexes/spec.md` (+ clarify: singleflight deferred, audit-first DDL) | **Plan**: `specs/020-cache-constraints-indexes/plan.md`
**Branch**: `020-cache-constraints-indexes`

## Context

Phase 9 tasks were all open with a filter-blind list key, no deterministic order, ms-vs-s TTL ambiguity, and a `clear()` fallback that flushed the shared Redis (rate-limit, expiry locks, dedup). Phase 13 was design-only with one known missing backstop (`Product.price >= 0`, bare column) and unproven hot-path indexes. Demo budget was 0.5 day combined; key redesign + singleflight were deferred.

## Decision

- **No `clear()` on any product path**: `invalidateAllLists` deletes discoverable keys then bumps `products:cache-version`; list keys are `products:list:v{n}:{page}:{limit}`. When key listing is unavailable the bump is the sole mechanism. `resetAll` follows the same rule (undiscoverable singles heal via TTL). Store access is guard-based (`canListKeysByPattern`, `unknown` + `in`/`typeof` narrowing) — no `as unknown`/`any`, per backend type rules.
- **Deterministic order**: `findAndCount({ order: { created_at: 'ASC', id: 'ASC' } })`; key-completeness test pins every `findAll` input in the key (FR-004 by construction).
- **TTL pin**: milliseconds documented on both getters (list 60_000/min 5_000, single 300_000/min 30_000); existing warn-on-fallback kept.
- **Audit-first DDL** (migration `1755900000013`, additive + idempotent): `CHK_product_price_non_negative` (audit: zero violations across six tables) + `IDX_order_status_createdAt` + `IDX_order_userId_createdAt` (both EXPLAIN-proven gaps; expiry/inventory/cart paths re-proven, no action). Entity and migration share constraint/index names.
- **Proofs**: unit 22 + live real-Redis 4 (miss/hit/mutate, namespace preservation, resetAll, never-authoritative incl. dead-Redis fail-open) + real-PG 4 (23514 rejections, index existence, forced-index EXPLAIN).

## Alternatives Considered

- Separate Redis DB for catalog — rejected (compose/infra change, out of demo scope).
- Hashed full-query keys now — rejected (no filter/sort params exist yet; completeness test forces the key to grow with params).
- TTL seconds — rejected (would rescale all effective TTLs; breaking-config decision).
- Singleflight — deferred per clarification (cross-instance coordination is new infra).
- Unconditional strict DDL — rejected (audit-first; a violating row would fail the migration).

## Consequences

- Catalog stays fresh without endangering shared-store correctness state; availability still reads live rows only.
- `ORDER BY` may reorder pages vs the old unspecified order — pinned by test, no contract bump (ordering was never specified).
- Operational lesson (recorded, not fixed here): shared-DB `dropSchema`/sync suites and stash-verified full-app runs rebuild the `ecommerce` schema and reseed dev data — the new DDL had to be re-applied once after such a run. Sync also did not self-heal the named check, so the migration file (not sync) is the DDL source of truth. Full-run ordering risk from ADR-0014 stands.

## Verification

- `npm run build` clean; touched-scope `eslint` 0 errors (repo has 15 pre-existing errors in auth/notifications/outbox/reservation/users, proven identical on clean tree).
- Focused suites: products/order/inventory/dashboard/cart 24 suites 157 green; new suites 22 + 4 + 4 green live on real PG/Redis.
- Full unit: 456 pass; 25 failures are 2 pre-existing suites (auth baseline-parity login 201-vs-200 staleness, reservation cancel-expiry race), identical on clean tree. E2E: admin-products 4/4 + cors 4/4 green; auth/verify/forgot/payment failures identical on clean tree.
