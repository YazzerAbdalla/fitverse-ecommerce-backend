# Feature Specification: Cache Constraints Indexes

**Feature Branch**: `020-cache-constraints-indexes`
**Created**: 2026-10-09
**Status**: Draft
**Input**: User description: "create spec for the remaining tasks in Phase 9 (Redis/Caching) + Phase 13 (Database Constraints & Indexes) together"

Closes the demo close-out scope for `docs/plan.md` Phase 9 + Phase 13 (combined 0.5 day): product-list invalidation + miss/hit/invalidation tests + never-authoritative proof + 2–3 missing indexes + EXPLAIN. Key redesign / singleflight are post-demo unless cheap. Source evidence: `docs/plan.md` Phase 9 tasks all `[ ]`, Phase 13 `PARTIALLY DONE`; `docs/REFACTOR_PLAN.md` §13 CACHE-1a/1b deltas; `src/modules/products/products.service.ts` (filter-blind keys, `clear()` fallback, no deterministic order, no singleflight, TTL ambiguity).

## Clarifications

### Session 2026-10-09

- Q: Are concurrent cold-cache identical requests coalesced to one source load in this change? → A: No — singleflight deferred; each request may load the source, both succeed.
- Q: How do new data-layer checks land if existing rows violate them? → A: Audit existing data first; add strict checks only where data is clean, clean-then-add otherwise.

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Shopper sees fast, correct product catalog (Priority: P1)

A shopper browsing the product list gets fast repeat reads, and always sees current data after an admin changes a product. Cached reads never decide stock availability.

**Why this priority**: Catalog reads are the highest-traffic path; stale listings or cache-driven stock decisions directly cause overselling or confused shoppers. This is the demo-visible value.

**Independent Test**: Browse list twice (miss then hit), admin edits a product, browse again and confirm the change is visible; availability decisions still come from the transactional store.

**Acceptance Scenarios**:

1. **Given** a populated catalog, **When** the list is requested twice with identical parameters, **Then** the first request loads from the source of truth and the second is served faster with identical content.
2. **Given** a cached list, **When** an admin creates/updates/removes a product, **Then** the next list request reflects the change (no stale entries).
3. **Given** any cached state including an empty cache, **When** availability is checked or checkout runs, **Then** the decision uses live transactional data, never the cache.

---

### User Story 2 - Shared cache never wipes unrelated state (Priority: P1)

An admin bulk edit or product reset invalidates only product-related entries. Rate-limit counters, expiration locks, poison markers, and dedup/cooldown entries survive product invalidation.

**Why this priority**: The `clear()` fallback flushes the shared store and silently disables throttling, expiration single-winner, and idempotency — a correctness incident, not a perf nit.

**Independent Test**: Seed non-product entries, trigger every product-mutation invalidation path, and confirm non-product entries still exist.

**Acceptance Scenarios**:

1. **Given** populated rate-limit / lock / dedup entries, **When** any product mutation invalidates caches, **Then** only product entries are removed and all other namespaces remain intact.
2. **Given** a store that cannot list keys by pattern, **When** invalidation runs, **Then** the operation degrades to version-stamping or per-key deletes, never a full flush.

---

### User Story 3 - Database rejects bad inventory data and serves hot paths via indexes (Priority: P2)

Invalid stock/quantity/price values are rejected at the data layer even if app code has a bug, and the hot read paths (reservation-expiry scan, order reads, inventory lookup) use indexes verifiably.

**Why this priority**: DB backstops are the last defense against overselling and data corruption; indexes keep expiry/checkout/order reads fast as data grows.

**Independent Test**: Attempt invalid writes directly and confirm rejection; run query-plan inspection on hot paths and confirm index usage.

**Acceptance Scenarios**:

1. **Given** any writer, **When** it attempts negative stock, reserved exceeding stock, non-positive quantity, or negative price/total, **Then** the write is rejected with a conflict/validation outcome and no partial state persists.
2. **Given** seeded reservations/orders/inventory, **When** the expiry scan, order-by-user listing, and inventory-by-product lookup run, **Then** each uses its supporting index (verified by plan inspection, not by timing).
3. **Given** the current schema, **When** the index audit runs, **Then** at most 2–3 targeted indexes are added for proven query patterns and no speculative index is added.

---

### Edge Cases

- What happens when the cache store is unavailable (reads still succeed from source of truth, writes still invalidate best-effort, no 500)?
- What happens when two identical list requests arrive concurrently on a cold cache (no coalescing: both succeed, each may load the source; deferred per 2026-10-09 clarification)?
- What happens when invalidation itself fails (mutation still commits; failure is logged, next TTL expiry heals)?
- What happens when a filter/sort parameter is added to listing later (old cached entries must not be served for new parameter combinations)?
- What happens when an index is added concurrently on a large table (migration must not block writes beyond the agreed maintenance approach)?

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: Product listing reads MUST use a read-through cache (miss loads source of truth, hit serves cached envelope) with documented key shape and TTL.
- **FR-002**: Every product mutation (single create, bulk create, single update, bulk update, single remove, full reset) MUST invalidate affected product cache entries after the data commit, never inside the transactional write.
- **FR-003**: Invalidation MUST be selective (per-key deletes and/or version stamp); a full-store flush MUST NOT exist on any product path, including fallbacks.
- **FR-004**: Cache keys MUST fully represent the request parameters that affect results (pagination today; any future filter/sort must extend the key, never reuse a narrower key).
- **FR-005**: Listed results MUST have a deterministic order so paginated pages are stable across cache miss/hit.
- **FR-006**: Time-to-live values MUST have one pinned unit and one documented default per entry kind, validated at startup with a warning on invalid values.
- **FR-007**: The system MUST prove cache is never authoritative: availability, reservation, order, and payment decisions read live transactional data even when cache is warm, cold, or down.
- **FR-008**: The data layer MUST reject `stock < 0`, `reservedAmount < 0`, `reservedAmount > stock`, `quantity <= 0`, and negative price/total values, independent of app-level validation.
- **FR-009**: The data layer MUST enforce one inventory record per product and one line per (reservation, inventory) and per (order, product) pair.
- **FR-010**: Hot access paths (reservation-expiry scan by status+expiry, reservation/order lookup by owner, inventory lookup by product, order-items by order) MUST have supporting indexes; at most 2–3 new indexes MAY be added, each justified by an observed query pattern and verified by plan inspection.
- **FR-011**: Existing behaviors (response shapes, status codes, error contracts, event payloads) MUST NOT change; only cache freshness and data-backstop strictness change.

### Key Entities *(include if feature involves data)*

- **Product listing cache entry**: Paginated catalog view keyed by full request parameters with TTL; invalidated on any catalog mutation; never consulted for availability.
- **Inventory record**: Per-product stock state (`stock`, `reservedAmount`, derived `available = stock − reservedAmount`) with range and cross-field backstops.
- **Reservation / Order graph**: Lifecycle state with indexed lookup paths (status+expiry scan, owner listings) for expiry, checkout, and reads.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: Repeat identical list requests return identical content with the second served from cache, and post-mutation reads reflect the change within one request (verified by miss/hit/invalidation tests).
- **SC-002**: Zero non-product entries are lost during any product-mutation invalidation (rate-limit, lock, poison, dedup namespaces intact).
- **SC-003**: 100% of invalid write attempts (negative stock/price, over-reserved, non-positive quantity) are rejected at the data layer with no partial persistence.
- **SC-004**: 100% of audited hot paths (expiry scan + inventory/order lookups) show index usage on plan inspection; no more than 3 new indexes added.
- **SC-005**: Shoppers can complete browse → cart → checkout with the cache warm, cold, and unavailable, with identical order outcomes in all three modes.

## Assumptions

- Existing cache-aside implementation in `products.service.ts` is the starting point; this spec hardens it rather than replacing it.
- Combined demo scope is ~0.5 day: invalidation fix + miss/hit/invalidation tests + never-authoritative proof + 2–3 indexes + EXPLAIN; key redesign and request coalescing (singleflight) are deferred post-demo (decided 2026-10-09).
- New data-layer checks are audit-first: existing rows are audited before adding each check; strict checks land where data is clean, cleanup precedes the check otherwise (decided 2026-10-09).
- Cache-key shape change (if any) stays backward compatible within the demo (additive/versioned keys); no public API contract change.
- TTL unit is pinned to milliseconds to match the existing configuration surface; changing to seconds would be a separate breaking-config decision.
- Index additions are limited to proven hot paths; speculative indexes (e.g., boolean-flag scans, future metric columns) are out of scope.
- Full-store flush removal uses selective deletes with a version-stamp fallback where key listing is unavailable.
