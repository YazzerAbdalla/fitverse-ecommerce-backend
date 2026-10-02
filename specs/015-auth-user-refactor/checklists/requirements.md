# Specification Quality Checklist: Auth + Users Refactor (RP-AUTH)

**Purpose**: Validate specification completeness and quality before proceeding to planning
**Created**: 2026-10-02
**Feature**: `specs/015-auth-user-refactor/spec.md`
**Validation pass**: 2 (post-clarification; all markers resolved 2026-10-02)

## Content Quality

- [ ] No implementation details (languages, frameworks, APIs) — FAIL: intentional deviation. This is a behavior-preserving refactor spec governed by `docs/REFACTOR_PLAN.md`; structural constraints (tx ownership, `FOR UPDATE`, store seams, 429/cookie/header parity) ARE the requirements. Rewording them away would lose the guarantee. Accepted for refactor specs; flagged here for transparency.
- [x] Focused on user value and business needs — PASS: US1 covers external consumers (zero migration); US2–US4 cover maintainers (single ownership, auditable tx, clean seams).
- [ ] Written for non-technical stakeholders — PARTIAL: primary audience is maintainers + security approvers per refactor plan (invariants TI-1/TI-3/TI-8). US1 acceptance scenarios are consumer-readable; structural sections require engineering context by design.
- [x] All mandatory sections completed — PASS: scenarios, requirements (FR-001–FR-014), entities, success criteria, assumptions all present.

## Requirement Completeness

- [x] No [NEEDS CLARIFICATION] markers remain — PASS (iteration 2): Q1 S-1 → unify to JwtGuard + tokenVersion check; Q2 S-2 → validate read-only + authoritative recheck in reset tx; Q3 D3 → keep shape + pin no-password-leak test. FR-014 and Assumptions updated.
- [x] Requirements are testable and unambiguous — PASS: each FR maps to contract-diff, static inspection, fault-injection, or concurrency proof.
- [x] Success criteria are measurable — PASS: SC-001–SC-005 with identical-outcome, single-winner, and gate-green thresholds.
- [x] Success criteria are technology-agnostic (no implementation details) — PASS with refactor exception: SC-004 uses inspection terms because the outcome IS structural; user-visible outcomes (SC-001/SC-002) are technology-agnostic.
- [x] All acceptance scenarios are defined — PASS: 6 (US1) + 2 (US2) + 3 (US3) + 3 (US4) scenarios.
- [x] Edge cases are identified — PASS: races, cap-5 eviction, token-version nuke, cooldown/buckets, anti-enum, Google unverified, OTP-501, password-leak pin, fail-open outages, path hygiene.
- [x] Scope is clearly bounded — PASS: FR-009 limits to auth+users files; assumptions freeze API/events/queues/schema with no migration.
- [x] Dependencies and assumptions identified — PASS: Phase 0 + CC-A/CC-B consumed (assumptions), order/reservation/outbox explicitly out of scope.

## Feature Readiness

- [x] All functional requirements have clear acceptance criteria — PASS via US scenarios + SC matrix.
- [x] User scenarios cover primary flows — PASS: P1 consumer parity, P1 ownership, P2 transactions, P3 seams.
- [x] Feature meets measurable outcomes defined in Success Criteria — PASS.
- [ ] No implementation details leak into specification — FAIL: same accepted refactor deviation as above.

## Notes

- Remaining failures are structural, not gaps: they reflect that a refactor spec must name the seams it preserves (per `docs/REFACTOR_PLAN.md` §§4, 10). Do not "fix" by deleting them; proceed to `/speckit.clarify` for Q1–Q3, then `/speckit.plan`.
- After user answers Q1–Q3, replace the 3 [NEEDS CLARIFICATION] markers in FR-014 and re-run this checklist (iteration 2).
