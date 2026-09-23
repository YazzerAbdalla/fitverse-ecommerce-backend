# Specification Quality Checklist: Asynchronous Events / Notifications — Transactional Outbox

**Purpose**: Validate specification completeness and quality before proceeding to planning (Outbox refactor)
**Created**: 2026-09-23
**Feature**: [spec.md](../spec.md)

## Content Quality

- [x] No implementation details (languages, frameworks, APIs) — spec references NestJS/RabbitMQ/BullMQ/PostgreSQL only because they are existing chosen infra per `AppModule` and `docs/plan.md` §11; success criteria are observable behaviors (atomic outbox insert, publisher claim, at-least-once) not code structure.
- [x] Focused on user value and business needs — stories are shopper checkout durability, operator verifiability, at-least-once audit, not framework internals.
- [x] Written for non-technical stakeholders — overview diagram `Business Transaction → Outbox → Publisher → RabbitMQ`, goal states durability without broker.
- [x] All mandatory sections completed — Overview, User Scenarios (5 stories + edge cases), Requirements (FR-001..016), Key Entities, Success Criteria (SC-001..008), Assumptions, Dependencies, Out of Scope, Clarifications, Acceptance Scenarios.

## Requirement Completeness

- [x] No [NEEDS CLARIFICATION] markers remain — 11 clarifications resolved (5 kickoff + 5 prior + 1 outbox refactor) documented in §8.
- [x] Requirements are testable and unambiguous — each FR has measurable payload pattern, manager usage, `FOR UPDATE SKIP LOCKED`, `attempts/nextRetryAt` formula, `maxAttempts 5`, batch `100`, lease `30s`.
- [x] Success criteria are measurable — SC-001..008 each predicate on `SELECT outbox_event` counts, `attempts` increment, `SKIP LOCKED` disjoint, `SENT/FAILED` statuses, `nextRetryAt` exponential.
- [x] Success criteria are technology-agnostic — criteria describe outcomes (201 even when broker down, no double decrement, lease reclaim) while mentioning RabbitMQ/BullMQ/PostgreSQL only as already-fixed infra.
- [x] All acceptance scenarios are defined — 8 acceptance scenarios for planning (§9) plus 3+ per user story (Story1:3, Story2:3, Story3:3, Story4:2, Story5:2) = 13+ total, each Given/When/Then.
- [x] Edge cases are identified — 10 edge cases (RABBITMQ_URL empty, publisher crash lease, concurrent SKIP LOCKED, 400/409/429 zero rows, already-terminal no event, PII, correlationId, FAILED retained, SKIP LOCKED PostgreSQL 17, persisted payload).
- [x] Scope is clearly bounded — Out of Scope (§7) explicitly excludes cleanup timer beyond retention, CQRS, Email/Payment providers, worker mutation, dedup storage, RMQ exchange redesign, business semantic changes.
- [x] Dependencies and assumptions identified — §5 A1..A10 and §6 list Phases 0–10, DataSource+OutboxModule, AppModule infra, global pipes/filters, OutboxService/Publisher separation, env `OUTBOX_*`.

## Feature Readiness

- [x] All functional requirements have clear acceptance criteria — FR-001..016 each traced to SC-001..008 and to User Story independent tests.
- [x] User scenarios cover primary flows — P1 checkout atomic + completion/cancellation + expiration atomics + publisher claim/retry/lease, P2 consumer at-least-once idempotency + operator verifiability; independent tests per story prove MVP slice (Story1 alone is viable: checkout durable without RabbitMQ).
- [x] Feature meets measurable outcomes defined in Success Criteria — SC-001..008 correspond to refined Phase 11 Exit Criteria `If business commits, outbox event exists` + `at-least-once publisher` + `no RMQ inside transaction`.
- [x] No implementation details leak into specification — details limited to already-chosen `NOTIFICATION_SERVICE`/`BullModule` singletons + new `OutboxEvent` entity which is required deliverable; no framework-specific code in SCs except observable spies.

## Notes

- Items marked incomplete require spec updates before `/speckit.clarify` or `/speckit.plan` — all pass; spec ready for `/speckit.plan` (Outbox data-model + publisher contracts).
- Validation iterations: 2 (initial publish-after-commit → refactored to outbox per 2026-09-23 user directive). Spec quality checklist regenerated per template `specs/011-async-events-notifications/checklists/requirements.md`.
- Outbox refactor implications: `EventsService` direct publish removed; new files `src/modules/outbox/outbox.entity.ts`, `outbox.service.ts`, `outbox.publisher.ts`, `outbox.module.ts`, `outbox.publisher.spec.ts` + migration `17559xxxxxx-CreateOutboxEvent`; modified files `order-checkout.service.ts`, `order-completion.service.ts`, `order.service.ts` (cancel), `reservation-expiration.service.ts`, `reservation-expiration.processor.ts` (no emit), `app.module.ts` (OutboxModule import). Database indexes `(status, nextRetryAt, createdAt)` required.
- Next steps: `/speckit.clarify` (optional, outbox Q&A covered) → `/speckit.plan` with `research.md` (SKIP LOCKED lease, envelope vs payload), `data-model.md` (OutboxEvent), `contracts/outbox-contracts.md`, `quickstart.md`.
