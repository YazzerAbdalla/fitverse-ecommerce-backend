# Checklist: Auth & State-Machine Requirements Quality

**Feature**: 002-reservation-domain (Phase 2)
**Purpose**: Unit tests for the *requirements* (written in English) covering authentication, ownership authorization, and the reservation state machine. Validates requirement completeness, clarity, consistency, and edge-case coverage — NOT implementation/QA.
**Created**: 2026-08-22
**Depth**: Standard | **Audience**: Author

---

## Requirement Completeness

- [ ] CHK001 - Are authentication requirements (JWT via @Auth) specified for every endpoint, including `expire`? [Completeness, Spec FR-008]
- [ ] CHK002 - Are the four reservation states (RESERVED, COMPLETED, EXPIRED, CANCELLED) defined as a requirement? [Completeness, Spec FR-004]
- [ ] CHK003 - Are the allowed state transitions (RESERVED → COMPLETED|EXPIRED|CANCELLED) defined as a requirement? [Completeness, Spec FR-005]
- [ ] CHK004 - Is the principle that inventory is NOT mutated in Phase 2 stated to prevent scope creep? [Coverage, Spec FR-010]

## Requirement Clarity

- [ ] CHK005 - Is the owner-or-admin authorization rule unambiguously defined (reservation.userId === requesterId OR role = ADMIN; otherwise 403)? [Clarity, Spec FR-008]
- [ ] CHK006 - Are the exact HTTP status codes for auth failures specified (401 unauthenticated, 403 forbidden, 404 unknown id)? [Clarity, Spec FR-008]
- [ ] CHK007 - Is the `ADMIN` role requirement for `expire` stated clearly (admin-only, not public)? [Clarity, contracts/reservation-api.md §6]

## Requirement Consistency

- [ ] CHK008 - Is the `ADMIN` role requirement for `expire` consistent across spec FR-008, plan §5, and contracts §6? [Consistency, Spec FR-008 / plan.md §5 / contracts §6]
- [ ] CHK009 - Are `orderId` linking rules on COMPLETE consistent between Phase 2 (nullable, 404 if supplied-missing) and the Phase 6 "strict FK" note? [Consistency, Spec FR-006 / A3 / research.md §3]
- [ ] CHK010 - Does the spec's `@Auth(UserRoles.ADMIN)` phrasing align with the actual enum value `UserRoles.Admin` used by the codebase? [Conflict, Spec FR-008 vs users/enum/roles.ts]

## Acceptance Criteria Quality

- [ ] CHK011 - Are acceptance criteria for unauthorized/forbidden access measurable (401/403 returned)? [Acceptance Criteria, Spec US2]
- [ ] CHK012 - Are acceptance criteria for invalid state transitions measurable (409 on COMPLETED→CANCELLED etc.)? [Acceptance Criteria, Spec US3 / SC-003]

## Scenario Coverage

- [ ] CHK013 - Are requirements defined for ALL disallowed transition pairs (COMPLETED→*, EXPIRED→*, CANCELLED→*)? [Coverage, Spec FR-005]
- [ ] CHK014 - Are requirements defined for a non-owner, non-admin user attempting read/mutation (403)? [Coverage, Spec US2]
- [ ] CHK015 - Are requirements defined for an unauthenticated caller on each endpoint (401)? [Coverage, Spec FR-008]

## Edge Case Coverage

- [ ] CHK016 - Does the spec define behavior for `COMPLETED → CANCELLED`, `EXPIRED → *`, and `CANCELLED → *` transitions (all rejected)? [Edge Case, Spec FR-005]
- [ ] CHK017 - Is the behavior when `orderId` is supplied but references a non-existent Order defined (404)? [Edge Case, Spec A3]
- [ ] CHK018 - Is the behavior when `orderId` is omitted defined (stays NULL until Phase 6)? [Edge Case, Spec FR-006]

## Non-Functional Requirements

- [ ] CHK019 - Are concurrency/atomicity requirements explicitly deferred to Phase 3 (not silently assumed satisfied in Phase 2)? [Gap, Spec FR-010 / constitution IV]
- [ ] CHK020 - Are idempotency requirements for future expiration cleanup noted as a later-phase concern? [Non-Functional, constitution Additional Constraints]

## Dependencies & Assumptions

- [ ] CHK021 - Is the assumption that existing auth infrastructure (JwtGuard, RolesGuard, User.role column) is reused (no new auth mechanism) validated/documented? [Assumption, Spec A1]
- [ ] CHK022 - Is the assumption that `User.role` defaults to `User` (non-admin) and ADMIN is required for `expire` documented? [Assumption, users/entity/user.entity.ts]

## Ambiguities & Conflicts

- [ ] CHK023 - Is there any conflict between the spec's statement that Phase 2 "MUST NOT implement locking" and constitution IV's atomicity MUST, and is the reconciliation (milestone order) recorded? [Conflict, Spec FR-010 vs constitution IV / plan.md §11]
