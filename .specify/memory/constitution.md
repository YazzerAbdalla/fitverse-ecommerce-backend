<!--
SYNC IMPACT REPORT (constitution v0.0.0 -> v1.0.0)
- Version change: 0.0.0 (placeholder template) -> 1.0.0 (initial authored constitution)
- Bump rationale: MAJOR — first real constitution replacing the unfilled template.
- Modified principles: none (all new).
- Added sections:
  - Core Principles I-IX (PostgreSQL source of truth; Modular monolith; Inventory/Reservation separate domains; DB-level concurrency/no overselling; Module boundaries; Spec-driven development; Mandatory DB-backed tests; No invented APIs/payments; Documentation as work).
  - Additional Constraints (tech stack, validation, errors, async events, idempotency, rate limiting, migrations).
  - Development Workflow (phased manual-development rule, milestone order, verification gates).
  - Governance (compliance, amendment, versioning, runtime guidance location).
- Removed sections: none (template placeholders removed).
- Templates requiring updates:
  - .specify/templates/plan-template.md: already has a "Constitution Check" section (line 30) that will now resolve against this file. No change required. ✅
  - .specify/templates/spec-template.md: generic; no constitution-specific sections to update. ✅
  - .specify/templates/tasks-template.md: generic; no change required. ✅
  - .opencode/command/speckit.constitution.md and other speckit commands: no agent-specific (CLAUDE-only) references found. ✅
- Follow-up TODOs: none. Ratification date set to creation date (2026-08-21) since no prior adoption record exists.
-->

# Mini E-Commerce Backend Constitution

## Core Principles

### I. PostgreSQL Is the Source of Truth (NON-NEGOTIABLE)
PostgreSQL is authoritative for all transactional business state: users, products,
cart, inventory, reservations, and orders. Redis, RabbitMQ, and BullMQ are
infrastructure and MUST NOT become the authoritative store for inventory,
reservations, orders, payments, or any transactional business state.
- Caching (Redis) is permitted for reads only; cached values MUST NOT feed
  reservation, order, or availability decisions.
- The authoritative availability path is always: PostgreSQL transaction ->
  Inventory row -> Reservation.
- Rationale: a cache/broker as source of truth enables phantom inventory, lost
  updates, and inconsistent orders under concurrency.

### II. Modular Monolith — No Premature Microservices
The application remains a single deployable NestJS process with strict module
boundaries. Modules MUST NOT be split into microservices unless a demonstrated,
documented requirement appears. Cross-module collaboration MUST go through
exported services — a module MUST NOT `@InjectRepository` another module's entity.
Rationale: keeps transactional consistency simple and avoids a distributed system
before it is needed.

### III. Inventory and Reservation Are Separate Domains With Explicit Lifecycles
- Product does NOT own inventory state. Inventory is its own entity with
  `stock`, `reserved_amount`, and `available = stock - reserved_amount`. The
  `available` value MUST NOT be stored as an independently mutable column.
- Reservation is its own domain. States are `RESERVED`, `COMPLETED`, `EXPIRED`,
  `CANCELLED`. Only these states exist; no unnecessary states.
- Transition rules are explicit and invalid transitions (e.g. `COMPLETED ->
  EXPIRED`, `EXPIRED -> COMPLETED`, `CANCELLED -> COMPLETED`) MUST be rejected.
- Inventory effects are fixed per transition:
  - Create (RESERVED): `reserved_amount += quantity`.
  - Complete (COMPLETED): `stock -= quantity; reserved_amount -= quantity`.
  - Cancel/Expire (CANCELLED/EXPIRED): `reserved_amount -= quantity` (stock unchanged).
- The cart MUST NOT mutate inventory. Inventory lifecycle belongs to the
  inventory/reservation/order workflow only.

### IV. Concurrency Safety at the Database Level (No Overselling) (NON-NEGOTIABLE)
Reservation creation MUST execute atomically:
`BEGIN -> lock inventory rows (FOR UPDATE / pessimistic_write) -> check
available >= requested_quantity -> increase reserved_amount -> create Reservation
+ ReservationItems -> COMMIT`, with `ROLLBACK` on any failure.
- Acquire multiple locks in a deterministic order to avoid deadlocks; keep
  transactions short; avoid unnecessary locking.
- Availability is computed from the locked row (`available = stock -
  reserved_amount`); never from a cache.
- Concurrency tests MUST guarantee that when the last unit is contested, exactly
  one request succeeds and the other receives a conflict — never both succeed.

### V. Module Boundaries and Service-Only Collaboration
Modules expose business operations via a service and MUST export any service
another module needs. Controllers (REST) and Resolvers (GraphQL) are thin:
parse input, call a service, return its result — no business logic, no direct DB
access. A module MUST NOT reach into another module's repository.

### VI. Spec-Driven Development (NON-NEGOTIABLE)
Every significant feature follows:
Requirement -> Specification -> Clarification -> Design -> Implementation Plan ->
Implementation -> Tests -> Verification. Open business questions (reservation
timing, rate-limiting strategy, Order state machine, payment behavior, cache
invalidation) MUST be resolved in the specification before coding. Do NOT
implement assumptions silently, and do NOT implement future phases prematurely
(e.g. no Order Completion while Reservation Creation is still untested).

### VII. Tests Are Mandatory and DB-Backed for Consistency
- Unit tests cover services and DTO validation.
- Integration tests run against a REAL PostgreSQL for transactions, row locking,
  constraints, and repository behavior. The DB MUST NOT be mocked when testing
  consistency, locking, or concurrency.
- Concurrency tests MUST explicitly verify "two users reserve the last available
  unit -> only one succeeds."
- E2E tests cover the full flow: register -> login -> browse -> add to cart ->
  checkout -> reservation -> order -> completion.
- External infrastructure (Redis, RabbitMQ) and other modules' services MAY be
  mocked; the database for consistency MUST NOT be.
- Tests are written progressively, not deferred to the end.

### VIII. Do Not Invent APIs, Payments, or Business Rules
No invented routes, database fields, or endpoints without justification tied to the
spec. No payment-provider integration unless specified; payment state is defined
separately when payment requirements exist, and payment-failure/success behavior
is specified. Quantities and prices arriving from clients are untrusted and MUST
be re-validated in the service.

### IX. Documentation Is Part of the Work
Maintain `AGENTS.md` (root rules) and `docs/` (architecture, database, api,
decisions/ADRs). Reference `docs/plan.md` for narrative rationale; do NOT
duplicate it. Each architectural decision is recorded as an ADR in
`docs/decisions/`; open questions are recorded and surfaced, not silently "fixed."
Update documentation when an architecture decision is made.

## Additional Constraints

- **Tech stack:** NestJS 11, TypeScript, PostgreSQL 17 + TypeORM, Redis 8
  (cache only), RabbitMQ 4 (async, post-commit), JWT (Passport + bcrypt + roles),
  Jest. Follow existing module structure under `src/modules/<name>/`.
- **Validation:** global `ValidationPipe` with `whitelist`,
  `forbidNonWhitelisted`, and `transform`. Every DTO field is declared; unknown
  fields are rejected.
- **Errors:** throw Nest HTTP exceptions; the global `AllExceptionsFilter`
  serializes both REST and GraphQL. Do not return plain objects for expected errors.
- **Async events:** RabbitMQ/BullMQ events are published ONLY after the DB
  transaction commits; async failures MUST NOT roll back an already-committed
  business transaction.
- **Idempotency:** reservation-expiration cleanup and notification jobs MUST be
  idempotent — reprocessing an already-EXPIRED reservation MUST NOT subtract
  inventory a second time.
- **Rate limiting (when added):** MUST never compromise transactional inventory
  correctness; use Redis only for shared limiter state, not for inventory truth.
- **Migrations:** `synchronize: true` is a dev shortcut. Before production, disable
  `synchronize` and introduce real migrations; never edit a committed migration —
  add a new one.

## Development Workflow

Follow the Manual Development Rule for every phase:
1. Read existing code. 2. Identify affected modules. 3. Write/confirm the
specification. 4. Clarify unresolved business decisions. 5. Design DB changes.
6. Design service boundaries. 7. Implement the smallest increment. 8. Write tests.
9. Run existing tests. 10. Verify database behavior. 11. Update documentation.
12. Mark the phase complete.

Work in milestone order: Inventory -> Reservation -> Transaction-Safe Reservation
-> Reservation Lifecycle -> Expiration Cleanup -> Order Integration -> Order
Completion -> Order Cancellation -> Redis/Cache -> Rate Limiting -> Async
Events -> Idempotency/Reliability -> Testing -> Documentation. The current target
is **Phase 1 — Inventory Foundation**.

Before declaring work done, verify with: `npm run lint`, `npm run build`,
`npm run test`, `npm run test:e2e`.

## Governance

This constitution supersedes ad-hoc practice. All PRs and reviews MUST verify
compliance with its principles; complexity MUST be justified and new dependencies
introduced only with reason. Amendments require a documented change, rationale,
and migration plan, and the constitution file is bumped by semantic versioning
(MAJOR: incompatible principle removal/redefinition; MINOR: new/expanded
principle; PATCH: clarifications/wording). Runtime development guidance lives in
`AGENTS.md` and `docs/decisions/`; this constitution is the higher-order source
and the plan-template "Constitution Check" MUST resolve against it.

**Version**: 1.0.0 | **Ratified**: 2026-08-21 | **Last Amended**: 2026-08-21
