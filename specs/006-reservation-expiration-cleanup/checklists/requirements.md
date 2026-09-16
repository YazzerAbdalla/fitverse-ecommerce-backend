# Specification Quality Checklist: Reservation Expiration Cleanup

**Purpose**: Validate specification completeness and quality before proceeding to planning
**Created**: 2026-09-16
**Feature**: [spec.md](../spec.md)

## Content Quality

- [x] No implementation details (languages, frameworks, APIs) — spec mentions `FOR UPDATE`/`EntityManager`/`@Cron`/BullMQ only as constrained by `docs/plan.md` §§5.2-5.4 and constitution IV/V; core narrative is user/operator-facing (expired reservations eventually release inventory). Where infra names appear they are gated as design-for-plan choices, not fixed implementation.
- [x] Focused on user value and business needs — P1 is abandoned-hold leak; P1 single-winner protects inventory correctness; P2 batch/observability protects operator/availability.
- [x] Written for non-technical stakeholders — Overview describes shopper hold + time passes + worker releases without assuming code knowledge; acceptance scenarios are `Given/When/Then` business-visible.
- [x] All mandatory sections completed — Overview(1), User Scenarios(2), Requirements(3 incl. Key Entities), Success Criteria(4), Assumptions(5), Dependencies(6), Out of Scope(7), Clarifications(8), Acceptance Scenarios(9).

## Requirement Completeness

- [x] No [NEEDS CLARIFICATION] markers remain — 3 clarification Q&As resolved inline (enforces `expiresAt <= NOW()` for worker only, infra deferred to plan D1, idempotent skip), 0 outstanding markers.
- [x] Requirements are testable and unambiguous — FR-001 scan predicate (`WHERE status='RESERVED' AND expiresAt <= NOW()` + composite index), FR-003 step-by-step transaction (lock Reservation → verify RESERVED → lock sorted Inventories → `reserved-=qty` → `EXPIRED`), FR-006 single-winner via `FOR UPDATE`, FR-007 batch paging with `limit` + continue-on-failure, FR-010 explicit DB-backed test list.
- [x] Success criteria are measurable — SC-001/SC-002 direct row assertions, SC-004 single-winner `200` vs `409` + inventory mutated once, SC-005 no double-release, SC-007 25 expired paged via `batchSize 10`, SC-008 `EXPLAIN` shows `Index Scan` on `IX_reservation_status_expiresAt`.
- [x] Success criteria are technology-agnostic (no implementation details) — criteria assert DB-visible state (`status=EXPIRED`, `reservedAmount`, `available`) and concurrent outcomes (`one 200 one 409`), not language/framework internals; index check is a DB observability assertion, not a code API.
- [x] All acceptance scenarios are defined — 4 scenarios P1 US1, 4 scenarios P1 US2, 4 scenarios P2 US3, plus 11 numbered acceptance scenarios (§9) covering auto-release, immunity, atomic multi-item, races, idempotency, batch paging, schedule observability, manual override.
- [x] Edge cases are identified — 11 explicit edges (0 rows, boundary `== NOW()`, already terminal, 0 items, `reserved<qty`, crash mid-batch, two replicas, tick overlap, manual vs worker predicate split, read-during-write, `reserved<=stock` after release).
- [x] Scope is clearly bounded — Out of Scope (§7) explicitly excludes Order integration (Phases 6-8), Redis caching (Phase 9), rate limiting (10), async events (11), idempotency framework (12), broad index sweep (13), auth upgrades (16), new states/columns.
- [x] Dependencies and assumptions identified — Assumptions A1-A10 (PostgreSQL authority, существующие entities/indexes, TTL, transaction boundary, `NOW()` server time, error mapping, `synchronize:false` + real DB, no new states, ConfigService, pessimistic locking); Dependencies list Phases 1-4 + `DataSource`/`ValidationPipe`/`AllExceptionsFilter` + scheduling infra choice.

## Feature Readiness

- [x] All functional requirements have clear acceptance criteria — FR-001↔US1-Sc1/SC-002, FR-003↔SC-001/SC-003/SC-005, FR-006↔US2/SC-004/SC-006, FR-007↔SC-007, FR-010↔Testing section.
- [x] User scenarios cover primary flows — US1 auto-release (happy + immunity + multi-item), US2 races (worker vs complete/cancel/worker), US3 batch/schedule/observability; each independently testable via `processExpiredBatch` or timed tick.
- [x] Feature meets measurable outcomes defined in Success Criteria — SC-001 through SC-008 each tie to a concrete integration/concurrency/`EXPLAIN` test on real PostgreSQL.
- [x] No implementation details leak into specification — all mentions of `FOR UPDATE`, `EntityManager`, composite index, `@Cron`/BullMQ are tied to `docs/plan.md` mandated mechanisms and presented as constraints to be decided in plan (`research.md`), not as code structure; alternative (e.g., which scheduler) is explicitly left to design.

## Notes

- Items marked incomplete require spec updates before `/speckit.clarify` or `/speckit.plan`. Current status: all pass. No iterations required.
- Validation: reads `docs/plan.md` §§5.1-5.4 + Phase 4 final lifecycle (`RESERVED→COMPLETED` `stock-=qty` etc., idempotent `COMPLETED→COMPLETED` `200`) + `docs/architecture/inventory-reservation.md` + constitution I/III/IV/VII. Cross-checked against `src/modules/reservation/reservation.service.ts` transaction pattern (Phase 4 `FOR UPDATE` Reservation-first + sorted Inventories) to ensure FR-003 consistency.
- Irrelevant for this phase: email/WhatsApp OTP, Google OAuth, payment provider — correctly excluded per Out of Scope.
