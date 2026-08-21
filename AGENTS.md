# AGENTS.md — Mini E-Commerce Backend

Instruction file for AI coding agents working in this repository. It is the
**Spec Kit context file** (set during `specify init`) and the single source of
global rules. Specialized, task-specific knowledge lives in [`docs/`](./docs)
and [`skills/`](./skills); do not duplicate that detail here.

> A longer, narrative architecture plan already exists at
> [`docs/plan.md`](./docs/plan.md). It is the design reference for the
> inventory/reservation/order domain. This file is the rules reference; the plan
> is the rationale. When they disagree, raise it as an open question rather than
> silently "fixing" either.

<!-- SPECKIT START -->
For additional context about technologies to be used, project structure,
shell commands, and other important information, read the current plan
at `specs/001-inventory-foundation/plan.md` (Phase 1 — Inventory Foundation).
<!-- SPECKIT END -->

---

## 1. Project Overview

A **modular monolithic e-commerce backend** built with NestJS 11 + TypeScript.
It is a single deployable application with strict module boundaries, designed
so that infrastructure pieces (Redis, RabbitMQ) can later be scaled
independently without becoming a distributed system.

| Concern | Technology |
| --- | --- |
| Runtime / framework | Node.js + NestJS 11 (modular monolith) |
| Language | TypeScript |
| Package manager | npm |
| Database | PostgreSQL 17 |
| ORM | TypeORM (`typeorm` ^1.1) |
| Cache | Redis 8 via `@nestjs/cache-manager` + `@keyv/redis` (ioredis) |
| Message broker | RabbitMQ 4 via `@nestjs/microservices` (RMQ transport) |
| Auth | Passport (local strategy) + JWT (`@nestjs/jwt`), bcrypt |
| API surface | **REST** (auth, cart, order) **and GraphQL** (products, Apollo code-first) |
| Validation | Global `ValidationPipe` (whitelist + forbidNonWhitelisted + transform) |
| Docs | Swagger UI at `/api` (bearer auth) |
| Error handling | Global `AllExceptionsFilter` (handles REST + GraphQL) |
| Tests | Jest (unit + e2e) |
| Containerization | `docker-compose.yml` (postgres, redis, rabbitmq) |
| Lint / format | ESLint (flat config) + Prettier |

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
Modules / Services (auth, users, products, cart, order, inventory)
        │  Cross-module calls go through exported Services, not repositories
        ▼
PostgreSQL  ◄──── source of truth for transactional state
Redis       ◄──── cache only (NOT authoritative for inventory/orders)
RabbitMQ    ◄──── async notifications (published AFTER the DB commit)
```

### Module map (current)

| Module | API | State |
| --- | --- | --- |
| `auth` | REST | JWT login/register, `Auth`/`CurrentUser` decorators, `JwtGuard`, `RolesGuard` |
| `users` | — | User entity, `UserRoles` enum, CRUD-by-email |
| `products` | **GraphQL** | Product entity + resolver; list caching; `updateMany` uses pessimistic locking; **no `stock` field** — inventory owned by Inventory domain |
| `cart` | REST | Per-user cart, cart items (eager product); stock checks via `InventoryService.getInventory` (available = stock - reservedAmount) |
| `order` | REST | **Stub** — controller returns placeholder strings; `CreateOrderDto` empty; not implemented |
| `inventory` | REST | `Inventory` entity (`stock`, `reservedAmount`, `available` derived) with DB constraints (`stock >=0`, `reservedAmount >=0`, `reservedAmount <= stock`, unique `productId`); `InventoryService` business API (`getInventory`, `checkAvailability`, `increaseStock`, `decreaseStock`, `decreaseStockForOrderMany`/`restoreStockForOrderMany` via `EntityManager`, plus `reserve`/`releaseReservation`/`completeSale` stubs); thin REST controller (`GET /inventory/:productId`, `GET .../availability?quantity=`, `POST .../increase`, `POST .../decrease`); `InventorySeeder` (idempotent `onModuleInit`) seeds & auto-creates inventory |

### Boundaries (enforce)

- A module exposes business operations via its **service**. Other modules import
  the service (and the module must `exports: [Service]`) — they must **not**
  `@InjectRepository` of another module's entity.
- `InventoryService` is the only place that should mutate `Inventory.stock`/`reservedAmount` (`available` derived). Product no longer owns stock. `InventoryService` methods `decreaseStockForOrderMany`/`restoreStockForOrderMany` are called with an `EntityManager` passed in by the caller; the caller owns the transaction. See `docs/architecture/inventory-reservation.md`.
- PostgreSQL is authoritative. Redis and RabbitMQ are infrastructure, never a
  source of truth for inventory or orders.

---

## 3. Backend Rules (NestJS)

Follow the existing structure under `src/modules/<name>/`:

- **Module** — `imports` / `providers` / `controllers` / `exports`. Export any
  service another module needs.
- **Controller / Resolver** — thin: parse input, call a service, return its
  result. No business logic, no DB access.
- **Service** — business logic + DB access via repositories or `DataSource`.
  Inject `Logger` (already a pattern) for meaningful logs.
- **Entity** — TypeORM entity (see Database Rules). GraphQL entities also carry
  `@ObjectType()`/`@Field()` decorators (code-first).
- **DTO / Input** — `class-validator` + `class-transformer`. REST uses `*.dto.ts`;
  GraphQL uses `*.input.ts` + `*.args.ts`. Always annotate fields; the global
  pipe strips/forbids unknown properties.
- **Repositories** — `@InjectRepository(Entity)` + `Repository<Entity>`. Use
  `DataSource` (injected) when you need transactions or raw locking.
- **Guards** — `JwtGuard` (auth) + `RolesGuard` (authorization). Apply with the
  `Auth(...roles)` decorator. Do not hand-roll auth in controllers.
- **Interceptors / Filters / Pipes / Middleware** — global ones already exist
  (validation, exceptions). Add new global ones only with a clear reason.
- **Transactions** — wrap multi-step writes in `dataSource.transaction(async manager => …)`
  and do **all** writes through `manager` (repositories obtained via
  `manager.getRepository`). See `products.service.ts:updateMany` for the
  pessimistic-lock pattern.
- **Error handling** — throw Nest HTTP exceptions
  (`BadRequestException`, `NotFoundException`, `ConflictException`,
  `ForbiddenException`, `UnauthorizedException`). The global filter serializes
  them; do not `try/catch` to return plain objects for expected errors.
- **Validation** — rely on DTO decorators + the global pipe. Quantities/prices
  coming from clients are never trusted; re-check invariants in the service.
- **Logging** — use the injected `Logger`, not `console.log`. (A leftover
  `console.log` exists in `auth.service.ts` — remove it when touching that file.)
- **Configuration** — read via `ConfigService` / `process.env`. Never hardcode
  hosts, secrets, or URLs.
- **Database access** — only through repositories / `EntityManager`. No raw SQL
  unless justified; if used, keep it in a repository/service and document why.

---

## 4. Database Rules (PostgreSQL + TypeORM)

- **Naming** — TypeORM defaults: table name = entity class name (e.g. `Product`,
  `User`, `Cart`, `Order`, `OrderItem`). Columns are `camelCase` (mapped to
  `snake_case` only if configured — it is **not** configured here, so columns
  are camelCase in the DB too). Keep this consistent; do not mix.
- **Primary keys** — `@PrimaryGeneratedColumn('uuid')` (UUIDv4) everywhere.
- **Foreign keys** — define via relations (`@ManyToOne`/`@OneToMany`/`@OneToOne`
  with `@JoinColumn` on the owning side). Let TypeORM create the FK columns.
- **Relationships** — add only what is needed for navigation/queries. Don't add
  bidirectional relations just because the ORM supports them.
- **Indexing** — add `@Index()` for real access patterns (e.g. `User.email`,
  `Product.name`). Don't index every column. Candidates for future
  inventory/reservation tables are listed in `docs/plan.md` §26.
- **Constraints** — enforce invariants in the DB, not only in code
  (`@Check`, `@Unique`, `NOT NULL`). Examples: `Inventory` has `@Check('"stock" >= 0')`, `@Check('"reservedAmount" >= 0')`, `@Check('"reservedAmount" <= "stock"')`, `@Unique(['productId'])`; `Product` has `@Unique(['name'])`.
- **Transactions** — mandatory for any write touching multiple related rows
  (reservation + inventory, order + inventory). Use `EntityManager` inside
  `dataSource.transaction`.
- **Concurrency** — prevent overselling with **pessimistic row locking**
  (`lock: { mode: 'pessimistic_write' }`) on the inventory/product row inside the
  transaction, exactly like `products.service.ts:updateMany`.
- **Avoid N+1** — use `relations` in `find*` or `leftJoinAndSelect` for needed
  associations; don't loop-query per item. `CartItem.product` is `eager: true`
  by design.
- **Soft deletion** — not currently used. Don't add it casually; if a feature
  needs it, document the decision in `docs/decisions/`.
- **Migrations** — `data-source.ts` configures `migrations: ['src/migration/**/*.ts']`
  but **none exist yet**; `synchronize: true` is on (dev shortcut). Before
  production, `synchronize` must be turned off and real migrations introduced.
  Treat existing migrations as load-bearing — never edit a committed migration;
  add a new one.

---

## 5. API Rules

REST conventions (auth / cart / order). GraphQL conventions (products) follow
NestJS + Apollo code-first; fields are typed with `@Field()`.

- **REST routes** — noun resources, HTTP verbs: `POST` create, `GET` read,
  `PATCH`/`PUT` update, `DELETE` remove. Current examples: `POST /auth/login`,
  `POST /auth/register`, `GET /cart`, `POST /cart/items`, `GET /order`.
- **Status codes** — `200/201` success, `400` bad input, `401` unauthenticated,
  `403` forbidden, `404` not found, `409` conflict (e.g. insufficient stock /
  duplicate), `422` validation, `500` unexpected.
- **Error body (REST)** — `{ statusCode, message, timestamp }` (from
  `AllExceptionsFilter`). GraphQL errors are surfaced as `GraphQLError` with
  `extensions.code`.
- **Auth** — protected routes use `@Auth(...roles)` (applies `JwtGuard` +
  `RolesGuard`). Current user via `@CurrentUser('prop')` or `@CurrentUser()`.
- **Pagination** — offset-based: `{ page, limit }` → `skip=(page-1)*limit`,
  return `{ data, meta:{ totalItems, itemCount, itemsPerPage, totalPages, currentPage } }`
  (see `products.service.ts:findAll`, `dto/pagination.dto.ts`). Reuse this shape.
- **Filtering / sorting** — not yet implemented on listings; add as DTO fields
  and document the query pattern when you do.
- **Validation** — all bodies go through the global `ValidationPipe`; DTOs must
  declare every accepted field. Unknown fields are rejected.

---

## 6. Testing Rules

- **Unit tests** — `*.spec.ts` next to the code (Jest, `ts-jest`). Mock
  collaborators (repositories, other services) via `Test.createTestingModule`.
  Current specs are mostly smoke tests ("should be defined"); upgrade them as you
  build real logic.
- **Integration tests** — use a **real PostgreSQL** (or test container) for
  transactions, locking, constraints, and repository behavior. Don't assert
  business consistency against mocks.
- **E2E tests** — `test/app.e2e-spec.ts` via `jest --config ./test/jest-e2e.json`
  and `supertest`. Cover full flows (register → add to cart → checkout → order).
- **What to mock** — external infrastructure (Redis, RabbitMQ) and other modules'
  services. **What not to mock** — the DB when you are testing consistency,
  locking, or transactions.
- **Concurrency tests** — explicitly test "two users reserve the last available
  unit simultaneously → only one succeeds" for any inventory/reservation code.
- **Naming** — `describe(Service)`, `it('should <behavior>')`. Match the existing
  style.

Run: `npm run test`, `npm run test:e2e`, `npm run test:cov`.

---

## 7. Git Rules

- **Branch naming** — Spec Kit's git extension uses **sequential numbered
  branches** (`001-feature-name`, …) once enabled; follow that when a spec
  exists. Otherwise `feat/...`, `fix/...`, `chore/...`.
- **Commit conventions** — imperative subject (`add inventory entity`, not
  `added inventory entity`). Keep commits focused; reference the spec/feature id
  when one exists.
- **PR expectations** — describe the change, link the spec, note verification
  run (`lint`/`test`/`build`). Include test coverage for behavior changes.
- **Never commit** — `.env`, secrets, `node_modules`, `dist`, `coverage`,
  `.specify/templates` working drafts (specs live under feature dirs). `.env` is
  already git-ignored; keep it that way.
- **Secrets** — never store secrets in source. They come from `.env` / the
  deployment environment. The committed `.env` contains a dev `JWT_SECRET`; do
  not reuse it anywhere real.

---

## 8. Agent Behavior Rules

**Never**
- invent APIs, routes, or DB fields without justification
- rewrite unrelated code "for style"
- add dependencies unprompted
- bypass a transaction when consistency requires one
- ignore concurrency / overselling risks
- edit committed migrations
- store secrets in source control
- claim tests passed or work is complete without running/verifying

**Always**
- read `AGENTS.md` + relevant `skills/` + existing code before changing anything
- follow the specification (Spec Kit) as the source of truth
- reuse existing abstractions (`Auth`, `InventoryService`, `Logger`, filters)
- prefer small, reviewable changes
- consider failure, concurrency, and DB consistency
- add/update tests for behavior changes
- update `docs/` and `docs/decisions/` when an architecture decision is made
- verify (`lint`, `build`, `test`) before declaring done

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
The detailed SDD playbook is in [`skills/spec-driven-development/SKILL.md`](./skills/spec-driven-development/SKILL.md).

**Process for a new feature (AI agent):**
1. **Understand** — read `AGENTS.md`, the relevant `skills/`, existing code, and
   any related spec.
2. **Clarify** — list ambiguous requirements, missing edge cases, security,
   consistency, and performance concerns. Do not invent business rules.
3. **Specify** — create/update the Spec Kit spec (`/speckit.specify`).
4. **Design** — decide API/DB/architecture changes, transactions, concurrency,
   failure modes, tests (`/speckit.plan`).
5. **Plan** — break into small tasks (`/speckit.tasks`).
6. **Implement** — per the approved plan.
7. **Verify** — `npm run lint`, `npm run build`, `npm run test`, `npm run test:e2e`.
8. **Review** — confirm the implementation matches the spec.

---

## 10. Where to look

- Narrative design + inventory/reservation/order rationale: [`docs/plan.md`](./docs/plan.md)
- Architecture detail: [`docs/architecture/`](./docs/architecture)
- Database detail: [`docs/database/`](./docs/database)
- API conventions: [`docs/api/conventions.md`](./docs/api/conventions.md)
- Decisions (ADRs + open questions): [`docs/decisions/`](./docs/decisions)
- Inventory / reservation intended design: [`docs/architecture/inventory-reservation.md`](./docs/architecture/inventory-reservation.md)
- Task playbooks: [`skills/`](./skills)
