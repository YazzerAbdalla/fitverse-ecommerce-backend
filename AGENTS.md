# AGENTS.md — Mini E-Commerce Backend

Instruction file for AI coding agents working in this repository. It is the

**Spec Kit context file** (set during `specify init`) and the single source of

global rules. Specialized, task-specific knowledge lives in [`docs/`](./docs)
and [`skills/`](./skills); do not duplicate that detail here.

> A longer, narrative architecture plan already exists at
> [`docs/plan.md`](./docs/plan.md). It is the design reference for the
> inventory/reservation/order domain. This file is the rules reference; the plan
> is the rationale. When they disagree, raise it as an open question rather
> than silently "fixing" either.

<!-- SPECKIT START -->

For additional context about technologies to be used, project structure,

shell commands, and other important information, read the current plan

at `specs/015-auth-user-refactor/plan.md` (RP-AUTH — Auth + Users Refactor).

<!-- SPECKIT END -->

---

## 1. Project Overview

A **modular monolithic e-commerce backend** built with NestJS 11 + TypeScript.

It is a single deployable application with strict module boundaries, designed

so that infrastructure pieces (Redis, RabbitMQ) can later be scaled

independently without becoming a distributed system.

| Concern             | Technology                                                                 |
| ------------------- | -------------------------------------------------------------------------- |
| Runtime / framework | Node.js + NestJS 11 (modular monolith)                                     |
| Language            | TypeScript                                                                 |
| Package manager     | npm                                                                        |
| Database            | PostgreSQL 17                                                              |
| ORM                 | TypeORM (`typeorm` ^1.1)                                                   |
| Cache               | Redis 8 via `@nestjs/cache-manager` + `@keyv/redis` (ioredis)              |
| Message broker      | RabbitMQ 4 via `@nestjs/microservices` (RMQ transport)                     |
| Auth                | Passport (local strategy) + JWT (`@nestjs/jwt`), bcrypt                    |
| API surface         | **REST** (auth, cart, order) **and GraphQL** (products, Apollo code-first) |
| Validation          | Global `ValidationPipe` (whitelist + forbidNonWhitelisted + transform)     |
| Docs                | Swagger UI at `/api` (bearer auth)                                         |
| Error handling      | Global `AllExceptionsFilter` (handles REST + GraphQL)                      |
| Tests               | Jest (unit + e2e)                                                          |
| Containerization    | `docker-compose.yml` (postgres, redis, rabbitmq)                           |
| Lint / format       | ESLint (flat config) + Prettier                                            |

Infrastructure is started with `docker-compose up -d`. App config is read from

`.env` (git-ignored — see Git Rules).

---

## 2. Architecture

```text
Client / GraphQL client

        │

        ▼

NestJS HTTP API (REST controllers + GraphQL resolvers)

        │  Global: ValidationPipe, AllExceptionsFilter, CORS, Swagger

        ▼

Modules / Services (auth, users, products, cart, order, inventory, reservation)

        │  Cross-module calls go through exported Services, not repositories

        ▼

PostgreSQL  ◄──── source of truth for transactional state
Redis       ◄──── cache only (NOT authoritative for inventory/orders)
RabbitMQ    ◄──── async notifications (published AFTER the DB commit)
```

### Module map (current)

| Module        | API         | State                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |           |         |                                                                                                                                                                                                                                                                                                                                                                                                                                                      |        |                                                           |
| ------------- | ----------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------- | ------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------ | --------------------------------------------------------- |
| `auth`        | REST        | JWT login/register, `Auth`/`CurrentUser` decorators, `JwtGuard`, `RolesGuard`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |           |         |                                                                                                                                                                                                                                                                                                                                                                                                                                                      |        |                                                           |
| `users`       | —           | User entity, `UserRoles` enum, CRUD-by-email                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |           |         |                                                                                                                                                                                                                                                                                                                                                                                                                                                      |        |                                                           |
| `products`    | **GraphQL** | Product entity + resolver; list caching; `updateMany` uses pessimistic locking; **no `stock` field** — inventory owned by Inventory domain                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |           |         |                                                                                                                                                                                                                                                                                                                                                                                                                                                      |        |                                                           |
| `cart`        | REST        | Per-user cart, cart items (eager product); stock checks via `InventoryService.getInventory` (available = stock - reservedAmount)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |           |         |                                                                                                                                                                                                                                                                                                                                                                                                                                                      |        |                                                           |
| `order`       | REST        | **Stub** — controller returns placeholder strings; `CreateOrderDto` empty; not implemented                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |           |         |                                                                                                                                                                                                                                                                                                                                                                                                                                                      |        |                                                           |
| `inventory`   | REST        | `Inventory` entity (`stock`, `reservedAmount`, `available` derived) with DB constraints (`stock >=0`, `reservedAmount >=0`, `reservedAmount <= stock`, unique `productId`); `InventoryService` business API (`getInventory`, `checkAvailability`, `increaseStock`, `decreaseStock`, `decreaseStockForOrderMany`/`restoreStockForOrderMany` via `EntityManager`, plus `reserve`/`releaseReservation`/`completeSale` stubs); thin REST controller (`GET /inventory/:productId`, `GET .../availability?quantity=`, `POST .../increase`, `POST .../decrease`); `InventorySeeder` (idempotent `onModuleInit`) seeds & auto-creates inventory |           |         |                                                                                                                                                                                                                                                                                                                                                                                                                                                      |        |                                                           |
| `reservation` | REST        | `Reservation` + `ReservationItem` entities (`ReservationStatus` enum `RESERVED                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          | COMPLETED | EXPIRED | CANCELLED`, FKs to `User`/`Order`/`Inventory`, `@Index`on`userId`/`status`/`expiresAt`/`status+expiresAt`, `@Unique reservationId+inventoryId`, `@Check quantity>0`, `ORDER SET NULL`, `USER CASCADE`); `ReservationService`(EntityManager write methods`create/complete/cancel/expire`, reads `findById/listByUser`, `validateTransition`, `assertOwner`); `ReservationController` (`POST /reservations`, `GET /:id`, `GET /`, `PATCH /:id/complete | cancel | expire`); `ReservationModule` (`src/modules/reservation`) |

### Boundaries (enforce)

* A module exposes business operations via its **service**. Other modules import
  the service (and the module must `exports: [Service]`) — they must **not**
  `@InjectRepository` of another module's entity.

* `InventoryService` is the only place that should mutate `Inventory.stock`/
  `reservedAmount` (`available` derived). `InventoryService` methods
  `decreaseStockForOrderMany`/`restoreStockForOrderMany` are called with an
  `EntityManager` passed in by the caller; the caller owns the transaction. See
  `docs/architecture/inventory-reservation.md`.

* PostgreSQL is authoritative. Redis and RabbitMQ are infrastructure, never a
  source of truth for inventory or orders.

---

## 3. Backend Rules (NestJS)

Follow the existing structure under `src/modules/<name>/`:

* **Module** — `imports` / `providers` / `controllers` / `exports`. Export any
  service another module needs.

* **Controller / Resolver** — thin: parse input, call a service, return its
  result. No business logic, no DB access.

* **Service** — business logic + DB access via repositories or `DataSource`.
  Inject `Logger` (already a pattern) for meaningful logs.

* **Entity** — TypeORM entity (see Database Rules). GraphQL entities also carry
  `@ObjectType()`/`@Field()` decorators (code-first).

* **DTO / Input** — `class-validator` + `class-transformer`. REST uses `*.dto.ts`;
  GraphQL uses `*.input.ts` + `*.args.ts`. Always annotate fields; the global
  pipe strips/forbids unknown properties.

* **Repositories** — `@InjectRepository(Entity)` + `Repository<Entity>`. Use
  `DataSource` (injected) when you need transactions or raw locking.

* **Guards** — `JwtGuard` (auth) + `RolesGuard` (authorization). Apply with the
  `Auth(...roles)` decorator. Do not hand-roll auth in controllers.

* **Interceptors / Filters / Pipes / Middleware** — global ones already exist
  (validation, exceptions). Add new global ones only with a clear reason.

* **Transactions** — wrap multi-step writes in
  `dataSource.transaction(async manager => …)` and do **all** writes through
  `manager` (repositories obtained via `manager.getRepository`). See
  `products.service.ts:updateMany` for the pessimistic-lock pattern.

* **Error handling** — throw Nest HTTP exceptions
  (`BadRequestException`, `NotFoundException`, `ConflictException`,
  `ForbiddenException`, `UnauthorizedException`). The global filter serializes
  them; do not `try/catch` to return plain objects for expected errors.

* **Validation** — rely on DTO decorators + the global pipe. Quantities/prices
  coming from clients are never trusted; re-check invariants in the service.

* **Logging** — use the injected `Logger`, not `console.log`. (A leftover
  `console.log` exists in `auth.service.ts` — remove it when touching that file.)

* **Configuration** — read via `ConfigService` / `process.env`. Never hardcode
  hosts, secrets, or URLs.

* **Database access** — only through repositories / `EntityManager`. No raw SQL
  unless justified; if used, keep it in a repository/service and document why.

### Code Documentation — JSDoc / Comments (Required)

All new and modified code **must** be documented. This is not optional.

* **Class-level JSDoc (required)** — every `Service`, `Controller`/`Resolver`,
  `Entity`, `Guard`, `Interceptor`, `Filter`, and `Module` gets a
  `/** ... */` block immediately above the class declaration. For services,
  use the form:

```ts
/**
 * This service is responsible for <bounded context / domain>.
 * It handles <key responsibilities> and enforces <invariants>.
 */
@Injectable()
export class InventoryService { ... }
```

Controllers/resolvers/entities follow the same pattern
(e.g. `/** This controller exposes ... */`,
`/** This entity represents ... */`).

* **Method-level JSDoc (required)** — every **public** method (and any
  non-trivial `private`/`protected` method) gets a `/** ... */` block with:
  `@param`, `@returns`, and `@throws` where applicable. Describe *what* the
  method does, not *how* it is implemented. Example:

```ts
/**
 * Reserves inventory for a reservation inside the caller's transaction.
 *
 * @param manager - EntityManager of the enclosing transaction (caller owns commit/rollback).
 * @param productId - Product to reserve.
 * @param quantity - Units to reserve (must be > 0, validated by DTO + service).
 * @returns The updated Inventory row.
 * @throws NotFoundException if inventory row missing, ConflictException if insufficient available stock.
 */
async reserve(
  manager: EntityManager,
  productId: string,
  quantity: number,
): Promise<Inventory> { ... }
```

* **Complex conditions & formulas (required inline comments)** — any
  non-trivial branching, guard, or calculation must have a short `//`
  comment explaining the *intent/business rule*, not just restating the code.
  Examples that require a comment:

  * `if`/`while` with ≥2 predicates, negations, or null/edge-case checks
  * availability / stock arithmetic (`available = stock - reservedAmount`)
  * pagination (`skip = (page - 1) * limit`)
  * expiration/TTL (`expiresAt = now + ttlMs`)
  * pricing/discount/tax formulas
  * optimistic/pessimistic lock predicates

  Example:

```ts
// Available stock excludes already-reserved units to prevent overselling
const available = inventory.stock - inventory.reservedAmount;

if (available < requestedQty) {
  throw new ConflictException('Insufficient stock');
}
```

* **Style** — use `/** ... */` (JSDoc) for class/method docs, `//` for inline
  condition/formula explanations. Keep comments concise and factual — no
  chain-of-thought, no redundant restatement of obvious code, no emojis unless
  requested. Update comments when you change the code they describe.

* **Verification** — code review (`skills/code-review/SKILL.md`) must reject PRs
  missing required JSDoc or unexplained complex logic. Treat missing docs as a
  lint failure.

---

## 4. Database Rules (PostgreSQL + TypeORM)

* **Naming** — TypeORM defaults: table name = entity class name (e.g. `Product`,
  `User`, `Cart`, `Order`, `OrderItem`). Columns are `camelCase` (mapped to
  `snake_case` only if configured — it is **not** configured here, so columns
  are camelCase in the DB too). Keep this consistent; do not mix.

* **Primary keys** — `@PrimaryGeneratedColumn('uuid')` (UUIDv4) everywhere.

* **Foreign keys** — define via relations (`@ManyToOne`/`@OneToMany`/`@OneToOne`
  with `@JoinColumn` on the owning side). Let TypeORM create the FK columns.

* **Relationships** — add only what is needed for navigation/queries. Don't add
  bidirectional relations just because the ORM supports them.

* **Indexing** — add `@Index()` for real access patterns (e.g. `User.email`,
  `Product.name`). Don't index every column. Candidates for future
  inventory/reservation tables are listed in `docs/plan.md` §26.

* **Constraints** — enforce invariants in the DB, not only in code
  (`@Check`, `@Unique`, `NOT NULL`). Examples: `Inventory` has
  `@Check('"stock" >= 0')`, `@Check('"reservedAmount" >= 0')`,
  `@Check('"reservedAmount" <= "stock"')`, `@Unique(['productId'])`;
  `ReservationItem` has `@Check('"quantity" > 0')`,
  `@Unique(['reservationId','inventoryId'])`; `Product` has
  `@Unique(['name'])`; `Reservation` has composite `@Index(['status','expiresAt'])`
  for future expiration cleanup.

* **Transactions** — mandatory for any write touching multiple related rows
  (reservation + inventory, order + inventory). Use `EntityManager` inside
  `dataSource.transaction`.

* **Concurrency** — prevent overselling with **pessimistic row locking**
  (`lock: { mode: 'pessimistic_write' }`) on the inventory/product row inside the
  transaction, exactly like `products.service.ts:updateMany`.

* **Avoid N+1** — use `relations` in `find*` or `leftJoinAndSelect` for needed
  associations; don't loop-query per item. `CartItem.product` is
  `eager: true` by design.

* **Soft deletion** — not currently used. Don't add it casually; if a feature
  needs it, document the decision in `docs/decisions/`.

* **Migrations** — `data-source.ts` configures
  `migrations: ['src/migration/**/*.ts']` but **none exist yet**;
  `synchronize: true` is on (dev shortcut). Before production,
  `synchronize` must be turned off and real migrations introduced.

  Treat existing migrations as load-bearing — never edit a committed migration;
  add a new one.

---

## 5. API Rules

REST conventions (auth / cart / order). GraphQL conventions (products) follow

NestJS + Apollo code-first; fields are typed with `@Field()`.

* **REST routes** — noun resources, HTTP verbs: `POST` create, `GET` read,
  `PATCH`/`PUT` update, `DELETE` remove. Current examples:
  `POST /auth/login`, `POST /auth/register`, `GET /cart`,
  `POST /cart/items`, `GET /order`.

* **Status codes** — `200/201` success, `400` bad input, `401` unauthenticated,
  `403` forbidden, `404` not found, `409` conflict (e.g. insufficient stock /
  duplicate), `422` validation, `500` unexpected.

* **Error body (REST)** — `{ statusCode, message, timestamp }` (from
  `AllExceptionsFilter`). GraphQL errors are surfaced as `GraphQLError` with
  `extensions.code`.

* **Auth** — protected routes use `@Auth(...roles)` (applies `JwtGuard` +
  `RolesGuard`). Current user via `@CurrentUser('prop')` or `@CurrentUser()`.

* **Pagination** — offset-based: `{ page, limit }` →
  `skip=(page-1)*limit`, return
  `{ data, meta:{ totalItems, itemCount, itemsPerPage, totalPages, currentPage } }`
  (see `products.service.ts:findAll`, `dto/pagination.dto.ts`). Reuse this shape.

* **Filtering / sorting** — not yet implemented on listings; add as DTO fields
  and document the query pattern when you do.

* **Validation** — all bodies go through the global `ValidationPipe`; DTOs must
  declare every accepted field. Unknown fields are rejected.

---

## 6. Testing Rules

* **Unit tests** — `*.spec.ts` next to the code (Jest, `ts-jest`). Mock
  collaborators (repositories, other services) via `Test.createTestingModule`.
  Current specs are mostly smoke tests ("should be defined"); upgrade them as
  you build real logic.

* **Integration tests** — use a **real PostgreSQL** (or test container) for
  transactions, locking, constraints, and repository behavior. Don't assert
  business consistency against mocks.

* **E2E tests** — `test/app.e2e-spec.ts` via
  `jest --config ./test/jest-e2e.json` and `supertest`. Cover full flows
  (register → add to cart → checkout → order).

* **What to mock** — external infrastructure (Redis, RabbitMQ) and other
  modules' services. **What not to mock** — the DB when you are testing
  consistency, locking, or transactions.

* **Concurrency tests** — explicitly test "two users reserve the last available
  unit simultaneously → only one succeeds" for any inventory/reservation code.

* **Naming** — `describe(Service)`, `it('should <behavior>')`. Match the existing
  style.

Run: `npm run test`, `npm run test:e2e`, `npm run test:cov`.

---

## 7. Git Rules

* **Branch naming** — Spec Kit's git extension uses **sequential numbered
  branches** (`001-feature-name`, …) once enabled; follow that when a spec
  exists. Otherwise `feat/...`, `fix/...`, `chore/...`.

* **Commit conventions** — imperative subject (`add inventory entity`, not
  `added inventory entity`). Keep commits focused; reference the spec/feature id
  when one exists.

* **PR expectations** — describe the change, link the spec, note verification run
  (`lint`/`test`/`build`). Include test coverage for behavior changes.

* **Never commit** — `.env`, secrets, `node_modules`, `dist`, `coverage`,
  `.specify/templates` working drafts (specs live under feature dirs). `.env` is
  already git-ignored; keep it that way.

* **Secrets** — never store secrets in source. They come from `.env` / the
  deployment environment. The committed `.env` contains a dev `JWT_SECRET`;
  do not reuse it anywhere real.

---

## 8. Agent Behavior Rules

### Never

* invent APIs, routes, or DB fields without justification
* rewrite unrelated code "for style"
* add dependencies unprompted
* bypass a transaction when consistency requires one
* ignore concurrency / overselling risks
* edit committed migrations
* store secrets in source control
* claim tests passed or work is complete without running/verifying
* leave `Service`/`Controller`/`Resolver`/`Entity`/`Guard` classes or public
  methods without JSDoc (`/** ... */`) — see §3 Code Documentation
* leave complex conditions (multi-predicate `if`/`while`, negations,
  edge-case guards) or formulas (stock/availability, pagination, TTL/expiration,
  pricing) without an inline `//` intent comment
* introduce abstractions solely to satisfy SOLID/DRY mechanically; every
  abstraction must have a clear responsibility and a real maintenance benefit
* extract duplicated code solely because it looks similar; first determine
  whether the duplicated logic represents the same business rule and is likely
  to evolve together

### Always

* read `AGENTS.md` + relevant `skills/` + existing code before changing anything
* follow the specification (Spec Kit) as the source of truth
* reuse existing abstractions (`Auth`, `InventoryService`, `Logger`, filters)
* prefer small, reviewable changes
* consider failure, concurrency, and DB consistency
* add/update tests for behavior changes
* update `plan.md` after implementing any phase
* update `docs/` and `docs/decisions/` when an architecture decision is made
* document every new/modified `Service`/`Controller`/`Resolver`/`Entity`/`Guard`
  with class-level `/** This service is responsible for ... */` and every public
  method with `/** ... @param @returns @throws */` JSDoc; add `//` comments for
  all complex conditions and formulas (see §3 Code Documentation)
* verify (`lint`, `build`, `test`) before declaring done

### Clean Architecture / Refactoring Rules

When modifying architecture, responsibilities, dependencies, duplicated logic,
or existing code structure, the agent **must read and apply**:

[`skills/clean-architecture/SKILL.md`](./skills/clean-architecture/SKILL.md)

The skill is the repository-wide reference for:

* SOLID principles
* DRY and duplication analysis
* separation of concerns
* dependency direction
* module boundaries
* high cohesion / low coupling
* explicit dependencies
* dependency inversion
* testability
* repository boundaries
* service responsibilities
* configuration boundaries
* error handling boundaries
* side-effect isolation
* database-access discipline
* transaction boundaries
* concurrency-sensitive refactoring
* messaging/background-job boundaries
* logging boundaries
* clean-code practices

When refactoring:

1. **Understand before extracting.** Read the surrounding request flow,
   dependencies, consumers, tests, and relevant architecture documentation.

2. **Preserve behavior.** Refactoring must not silently change API behavior,
   business rules, persistence semantics, authorization, transactions,
   concurrency guarantees, or error behavior.

3. **One bounded concern at a time.** Prefer a small architectural slice over
   a broad unrelated rewrite. A slice may be one module, several tightly
   coupled modules, one request flow, or one architectural concern.

4. **Responsibility before abstraction.** Identify the actual responsibility
   being separated before introducing an interface, base class, utility,
   helper, strategy, factory, or new service.

5. **Use the Rule of Three.** Do not create abstractions merely because two
   pieces of code look similar. Extract when the logic represents the same
   responsibility/business rule and the abstraction reduces real duplication
   or coupling.

6. **Dependency direction matters.** Dependencies should point toward stable
   business responsibilities and explicit boundaries. Avoid circular module
   dependencies and infrastructure leaking into unrelated business logic.

7. **Protect data ownership.** A module must not bypass another module's public
   service boundary to directly access or mutate its persistence state.

8. **Prefer explicit dependencies.** Dependencies should be visible through
   constructor injection or well-defined interfaces rather than hidden
   globals, mutable shared state, or implicit behavior.

9. **Avoid God services.** If a service owns unrelated responsibilities,
   identify the responsibilities and split them only when the new boundaries
   are meaningful and testable.

10. **Avoid premature optimization.** Do not reduce database queries simply
    because fewer queries look better. First understand the request flow,
    ownership, consistency requirements, and actual duplicate work.

11. **Correctness over query count.** Transactions, locking, invariants,
    authorization, and data consistency take priority over micro-optimizing
    database access.

12. **Refactor with tests.** Existing behavior should be protected by tests
    before or alongside structural changes. Add regression tests for behavior
    that was previously implicit or unprotected.

13. **Do not create architecture for architecture's sake.** Every new layer,
    abstraction, interface, adapter, repository, strategy, or factory must
    solve a concrete problem.

14. **Document architectural decisions.** If a refactor changes ownership,
    module boundaries, persistence boundaries, transaction ownership,
    dependency direction, or another architectural decision, update the
    appropriate `docs/` or `docs/decisions/` documentation.

The clean-architecture skill complements `AGENTS.md`; it does **not** override
the active Spec Kit specification, project constitution, documented
architecture decisions, or explicit domain requirements.

If a clean-code or SOLID recommendation conflicts with an existing documented
architecture decision, **do not silently change the architecture**. Identify
the conflict, inspect the relevant specification/ADR, and raise it for
resolution.

---

## 9. Spec-Driven Development (Spec Kit)

This repository uses **GitHub Spec Kit** (integration: `opencode`). The

specification is the source of truth for feature work.

Commands (opencode slash commands in `.opencode/command/`):

```text
/speckit.constitution   # project constitution (once)

/speckit.specify        # write the specification

/speckit.clarify        # resolve ambiguities / edge cases

/speckit.plan           # technical design

/speckit.checklist      # quality checklist

/speckit.tasks          # task breakdown

/speckit.analyze        # analyze before implementation

/speckit.implement      # implement against the plan

/speckit.converge       # reconcile implementation with spec
```

Full workflow:

```text
Idea / Requirement

   → Specification (/speckit.specify)

   → Clarification (/speckit.clarify)

   → Technical Design (/speckit.plan)

   → Implementation Plan (/speckit.tasks)

   → Task Breakdown

   → Implementation (/speckit.implement)

   → Tests

   → Verification (lint/build/test)

   → Review (/speckit.converge)
```

Spec Kit state lives in `.specify/` (templates, workflows, scripts). Feature

work is tracked by the active feature directory in `.specify/feature.json`.

The detailed SDD playbook is in
[`skills/spec-driven-development/SKILL.md`](./skills/spec-driven-development/SKILL.md).

### Process for a new feature (AI agent)

1. **Understand** — read `AGENTS.md`, the relevant `skills/`, existing code, and
   any related spec.

2. **Clarify** — list ambiguous requirements, missing edge cases, security,
   consistency, and performance concerns. Do not invent business rules.

3. **Specify** — create/update the Spec Kit spec (`/speckit.specify`).

4. **Design** — decide API/DB/architecture changes, transactions, concurrency,
   failure modes, tests (`/speckit.plan`).

5. **Plan** — break into small tasks (`/speckit.tasks`).

6. **Implement** — per the approved plan.

7. **Verify** — `npm run lint`, `npm run build`, `npm run test`,
   `npm run test:e2e`.

8. **Review** — confirm the implementation matches the spec.

### Process for refactoring existing code

Refactoring is treated as an architectural change, not as unrestricted
cleanup.

1. **Understand** — read `AGENTS.md`, relevant skills, the applicable specs,
   architecture documentation, tests, and the existing request flow.

2. **Audit** — identify responsibility violations, unnecessary coupling,
   duplication, unclear boundaries, dependency-direction problems, database
   access issues, and correctness risks.

3. **Plan** — define the bounded refactoring scope, target responsibility
   boundaries, affected modules, dependencies, tests, risks, and verification
   criteria.

4. **Review the plan** — do not begin a broad refactor until the affected
   scope and architectural direction are understood.

5. **Implement incrementally** — make small, behavior-preserving changes and
   keep each architectural concern reviewable.

6. **Verify continuously** — run focused tests during the refactor, then run
   lint, build, unit tests, integration/e2e tests as applicable.

7. **Document** — update relevant `docs/`, ADRs, and the refactoring plan when
   architecture or ownership changes.

8. **Converge** — confirm the resulting implementation still matches the
   specification, project architecture, and intended refactoring goals.

### Refactoring principles

Refactoring work must optimize for:

```text
Clear responsibility
        ↓
Correct boundaries
        ↓
Low coupling + high cohesion
        ↓
Explicit dependencies
        ↓
Testability
        ↓
Correctness + consistency
        ↓
Maintainability
```

Do not treat the following as goals by themselves:

* fewer files
* fewer lines
* fewer classes
* fewer methods
* fewer database queries
* more abstractions
* more interfaces
* more design patterns

A refactor is successful when the resulting architecture makes behavior,
ownership, dependencies, invariants, and failure modes easier to understand
and safely change.

---

## 10. Where to Look

* Narrative design + inventory/reservation/order rationale:
  [`docs/plan.md`](./docs/plan.md)

* Architecture detail:
  [`docs/architecture/`](./docs/architecture)

* Database detail:
  [`docs/database/`](./docs/database)

* API conventions:
  [`docs/api/conventions.md`](./docs/api/conventions.md)

* Decisions (ADRs + open questions):
  [`docs/decisions/`](./docs/decisions)

* Inventory / reservation intended design:
  [`docs/architecture/inventory-reservation.md`](./docs/architecture/inventory-reservation.md)

* Task playbooks:
  [`skills/`](./skills)

* **Clean architecture / SOLID / DRY / refactoring principles:**
  [`skills/clean-architecture/SKILL.md`](./skills/clean-architecture/SKILL.md)

* **Spec-driven development playbook:**
  [`skills/spec-driven-development/SKILL.md`](./skills/spec-driven-development/SKILL.md)

* **Code review rules:**
  [`skills/code-review/SKILL.md`](./skills/code-review/SKILL.md)

---

## Skill Precedence

When multiple sources provide guidance, use this precedence order:

1. **Active Spec Kit specification** — feature-specific requirements
2. **Project constitution** — repository-wide architectural principles
3. **`AGENTS.md`** — global agent behavior and implementation rules
4. **Architecture decisions / ADRs** — documented architectural decisions
5. **`docs/`** — detailed architecture and domain rationale
6. **Relevant `skills/`** — specialized implementation and refactoring guidance
7. **Existing code patterns** — useful evidence, but not automatically correct

If two sources conflict, do not silently choose one. Identify the conflict,
determine whether one source is stale, and raise the issue when the correct
resolution cannot be established from the repository.

---
