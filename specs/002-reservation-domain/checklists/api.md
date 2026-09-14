# Checklist: API & Contract Requirements Quality

**Feature**: 002-reservation-domain (Phase 2)
**Purpose**: Unit tests for the *requirements* (written in English) of the Reservation REST API — validate completeness, clarity, consistency, measurability, and edge-case coverage. NOT an implementation/QA test.
**Created**: 2026-08-22
**Depth**: Standard | **Audience**: Author

---

## Requirement Completeness

- [ ] CHK001 - Are all required REST endpoints defined (POST /reservations, GET /reservations/:id, GET /reservations, PATCH /:id/complete, PATCH /:id/cancel, PATCH /:id/expire)? [Completeness, Spec FR-007]
- [ ] CHK002 - Is the CreateReservationDto request schema fully specified (fields, optionality, types, nesting)? [Completeness, Spec FR-006]
- [ ] CHK003 - Are error response formats specified for every failure mode (400/401/403/404/409)? [Completeness, contracts/reservation-api.md §1]
- [ ] CHK004 - Is the success response shape (ReservationResponse: id, userId, orderId, status, expiresAt, items) specified with all fields? [Completeness, data-model.md §DTO]
- [ ] CHK005 - Are pagination requirements (page/limit, defaults, max, meta shape) defined for listing? [Completeness, Spec A6]

## Requirement Clarity

- [ ] CHK006 - Is `expiresAt` optionality and default (now+15m) stated unambiguously in API terms, distinguishing "omitted" vs "supplied-but-past"? [Clarity, Spec FR-006 / research.md §1]
- [ ] CHK007 - Are validation rules for `quantity` (integer >= 1) and `items` (min 1) explicitly stated as API requirements? [Clarity, Spec FR-006]
- [ ] CHK008 - Is the `expire` endpoint's intended audience (admin/internal, not public) defined clearly as a requirement? [Clarity, contracts/reservation-api.md §6]
- [ ] CHK009 - Is the term "future timestamp" for `expiresAt` quantified (strictly > now) so it is not ambiguous? [Clarity, research.md §1 / data-model.md]

## Requirement Consistency

- [ ] CHK010 - Are duplicate `inventoryId` rejection rules consistent across spec edge case, research §4, and contracts (service 400 vs DB-unique 409)? [Consistency, Spec edge case / research.md §4]
- [ ] CHK011 - Are pagination requirements consistent between Spec A6 (`{page, limit}` → `{data, meta}`) and contracts §3? [Consistency, Spec A6 / contracts §3]
- [ ] CHK012 - Are the service method signatures requiring `EntityManager` documented as a requirement (FR-010) rather than hidden implementation detail? [Traceability, Spec FR-010]

## Acceptance Criteria Quality

- [ ] CHK013 - Are acceptance criteria for "create reservation" measurable (persisted RESERVED + correct items + FKs)? [Acceptance Criteria, Spec US1]
- [ ] CHK014 - Are the manual API verification steps in quickstart.md traceable to explicit acceptance scenarios in spec.md §9.3? [Acceptance Criteria, quickstart.md]

## Scenario Coverage

- [ ] CHK015 - Are ownership-scoping requirements for GET / (self-only, admin filter by userId) clearly specified? [Coverage, Spec US4 / contracts §3]
- [ ] CHK016 - Are requirements defined for the zero-item creation case (rejected)? [Coverage, Spec edge case]
- [ ] CHK017 - Are requirements defined for an unknown `orderId` on create/complete (404)? [Coverage, Spec FR-006 / A3]

## Edge Case Coverage

- [ ] CHK018 - Are edge cases for past `expiresAt`, zero/negative quantity, unknown inventory, and unknown orderId all defined as requirements? [Edge Case, Spec edge cases]
- [ ] CHK019 - Is the behavior when the same `inventoryId` appears twice in one request specified (reject, no merge)? [Edge Case, Spec edge case]

## Non-Functional Requirements

- [ ] CHK020 - Are rate-limiting, caching, and async-event requirements explicitly excluded for Phase 2 (or noted as Gap)? [Gap, Non-Functional, Spec FR-010]
- [ ] CHK021 - Are DB-backed integration testing requirements (real PostgreSQL, not mocked) stated for the API contracts? [Non-Functional, Spec FR-011]

## Dependencies & Assumptions

- [ ] CHK022 - Is the assumption that the global ValidationPipe (whitelist + forbidNonWhitelisted) enforces unknown-field rejection documented? [Assumption, Spec A1 / AGENTS.md]
- [ ] CHK023 - Is a requirement ID / acceptance-criteria ID scheme established to enable traceability from tasks to spec? [Traceability, Spec §2]

## Ambiguities & Conflicts

- [ ] CHK024 - Does any requirement use snake_case (`expires_at`) that conflicts with the camelCase column convention used elsewhere in the spec? [Conflict, Spec prose vs AGENTS.md DB rules]
