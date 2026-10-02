---
name: clean-architecture
description: Use when designing, reviewing, refactoring, or extending TypeScript/NestJS code. Enforces SOLID, DRY, clean code, layering, request-flow DB read optimization, structured logging, JSDoc file headers, calculation comments, and Swagger documentation, while preserving behavior.
---

# SOLID, DRY & Clean Architecture Skill

## Purpose

Use this skill when designing, reviewing, refactoring, or extending TypeScript/NestJS code.

The goal is to produce code that is:

* maintainable
* testable
* understandable
* loosely coupled
* cohesive
* extensible
* explicit about responsibilities
* documented where it matters (headers, APIs, calculations)
* observable (logs before every process and DB operation)
* resistant to accidental behavior changes

This skill is especially important when refactoring an existing codebase.

---

# Core Principle

**Prefer simple, explicit architecture over clever abstraction.**

Do not refactor code merely to make it look "clean." Every abstraction must have a concrete reason.

Prefer:

```text
clear responsibility
+
explicit dependency
+
small interface
+
predictable behavior
```

over:

```text
deep abstraction
+
unnecessary patterns
+
generic framework
+
premature extensibility
```

---

# 0. Refactoring Workflow and Ground Rules

These rules apply whenever this skill is used on an existing codebase.

1. **Behavior preservation.** Do not change public HTTP/RPC contracts, DB schema, event names/payloads, env var names, or queue names without explicit approval. If a bug fix changes behavior, report it separately from the refactor.
2. **Audit before editing.** For a project-wide refactor, first produce a read-only audit (see section 36) and wait for approval before changing code.
3. **Tests first.** Run the existing suite and record the baseline. Add characterization tests for untested code before refactoring it. All tests must pass after every step.
4. **Small, reviewable steps.** One concern per commit. Never mix a refactor with a feature.
5. **One module (or one request flow) at a time.** Stop and ask if a change would alter behavior, DB schema, or a public contract.
6. **No production code written for tests.** Remove `typeof x.method === 'function'` guards, mock-compatibility fallbacks, and `NODE_ENV === 'test'` branches inside services. Fix the tests (proper mocks or DI overrides) instead.
7. **Correctness over fewer queries and fewer lines.** Never remove a DB read merely to reduce query count if it validates current authoritative state, enforces security, or maintains transactional correctness.
8. **Test-shaped fallbacks can be correctness bugs.** A `catch` that falls back to an unguarded write bypasses ownership/lease checks. Report these as bugs, not style.

---

# 1. SOLID

## S: Single Responsibility Principle

A class, function, or module should have **one primary reason to change**.

A responsibility is a cohesive business or technical concern.

### Identify SRP violations

Flag classes that combine unrelated concerns such as:

```text
lifecycle / scheduling
+
configuration parsing
+
database access
+
business rules
+
HTTP handling
+
message publishing
+
retry/backoff policy
+
logging
```

Example of a problematic service:

```ts
class OrderService {
  constructor(
    private readonly dataSource: DataSource,
    private readonly rabbit: ClientProxy,
    private readonly config: ConfigService,
  ) {}

  async createOrder() {
    // validation
    // DB queries
    // transaction
    // RabbitMQ publishing
    // retry logic
    // email
  }
}
```

Prefer separating responsibilities:

```text
OrderService
    ↓
OrderStore

OrderService
    ↓
OrderEventPublisher

OrderService
    ↓
OrderConfig

OrderEventPublisher
    ↓
RetryPolicy
```

### Do not split blindly

Do NOT create a class simply because a method is long.

Split when the extracted responsibility:

* has its own reason to change
* can be independently tested
* represents a meaningful domain/infrastructure concern
* has multiple consumers
* isolates an external dependency

Avoid:

```text
OrderValidationHelper
OrderCreationHelper
OrderMappingHelper
OrderDataHelper
```

when these only move code around without improving responsibility boundaries.

### Header test for SRP

The one-sentence "Responsibility" line in a file header (section 10) is an SRP check. If it needs "and" to describe two jobs, the file likely violates SRP.

---

## O: Open/Closed Principle

Code should be open to extension without modifying stable orchestration logic.

Look for hard-coded branching such as:

```ts
if (provider === 'rabbitmq') {
  ...
} else if (provider === 'kafka') {
  ...
} else if (provider === 'sqs') {
  ...
}
```

when multiple real implementations are required.

Prefer:

```ts
interface EventTransport {
  publish(eventType: string, payload: unknown): Promise<void>;
}
```

with implementations `RabbitMqTransport`, `KafkaTransport`, `SqsTransport`, injected via a DI token.

Typical OCP candidates: transport, backoff/retry strategy, pricing/rules.

### Do not over-apply OCP

Do not introduce strategies, factories, or interfaces for behavior that has only one implementation and no realistic extension boundary. The existence of an `if` is not automatically an OCP violation.

---

## L: Liskov Substitution Principle

Implementations must honor the contract of their abstraction.

Flag implementations that:

* throw "not supported" for required interface methods
* return incompatible values
* weaken validation unexpectedly
* change error semantics
* require callers to check concrete implementation types

Bad:

```ts
interface PaymentProvider {
  refund(paymentId: string): Promise<void>;
}

class CashPaymentProvider implements PaymentProvider {
  refund(): Promise<void> {
    throw new Error('Refund not supported');
  }
}
```

Prefer smaller interfaces, or a domain model that accurately represents capabilities.

---

## I: Interface Segregation Principle

Interfaces should expose only what consumers actually need.

Avoid:

```ts
interface UserRepository {
  create()
  update()
  delete()
  find()
  findAll()
  resetPassword()
  sendEmail()
  generateToken()
}
```

when consumers only need:

```ts
interface UserReader {
  findById(id: string): Promise<User>;
}

interface UserWriter {
  update(...): Promise<void>;
}
```

Use small interfaces when they represent meaningful dependency boundaries. Do not fragment interfaces solely to satisfy a rule. Apply the same thinking to fat DTOs.

---

## D: Dependency Inversion Principle

High-level business logic should not depend directly on infrastructure details.

Avoid:

```ts
class AuthService {
  constructor(private readonly dataSource: DataSource) {}
}
```

when the service only needs a repository capability.

Prefer:

```ts
class AuthService {
  constructor(
    @Inject(USER_STORE)
    private readonly userStore: UserStore,
  ) {}
}
```

Infrastructure implements the abstraction.

Common abstractions:

```text
Repository / Store
EventTransport
Clock
IdGenerator
EmailProvider
Cache
PaymentProvider
FileStorage
```

Use DI tokens (`Symbol` or string constants exported from one place).

Do not instantiate collaborators inside business services:

```ts
new SomeService()
new Date()
randomUUID()
process.env.X
```

when those dependencies affect business behavior or test determinism.

---

# 2. DRY

## Rule of Three

Do not abstract the first occurrence.

```text
1 occurrence  → leave it
2 occurrences → investigate
3 occurrences → consider abstraction
```

**Exception for correctness-critical logic.** When two copies of a security, ownership, lease, or transaction-sensitive clause exist (for example, the same token-guarded `UPDATE ... WHERE id AND status AND token`), extract at two. Divergence between copies creates bugs, not just clutter.

Duplication is judged by **reason for change**, not textual similarity. Two similar functions may legitimately remain separate if they represent different domain concepts.

## Types of duplication to look for

**Business logic:** same calculation, state transition, validation, authorization rule.

**Infrastructure logic:** same retry logic, error mapping, query conditions, transaction pattern, configuration parsing (parse, NaN-check, clamp, default).

**Data transformation:** same DTO mapping, response construction, event payload construction, repeated inline return-type literals (name them).

**Logging:** same message formats repeated by hand (use a convention or tiny helper).

## Avoid False DRY

Do not create abstractions like:

```ts
executeOperation()
processData()
handleRequest()
commonHelper()
baseService()
```

unless they represent a real shared responsibility.

Prefer `claimExpiredReservations()` over `executeOperation()`, and `markReservationExpired()` over `updateStatus()`.

Domain intent is more important than maximum code reuse.

---

# 3. Clean Code

## Functions

Prefer small functions, one level of abstraction, early returns, clear names, minimal parameters, minimal side effects.

Avoid deep nesting (more than 3 levels), large switch statements, boolean flag arguments, hidden mutations, and multiple unrelated responsibilities.

Target ~30 lines or less, as a review signal, not a mathematical rule. A cohesive 45-line function can be better than five meaningless helpers.

## Naming

Names explain intent.

Avoid: `e`, `x`, `data`, `obj`, `res`, `req`, `qb`, `obs`, `lim`, `tmp`.

Prefer: `user`, `order`, `queryBuilder`, `paginationLimit`, `reservation`, `authenticatedUser`.

Booleans read as predicates: `isExpired`, `hasPermission`, `canRefresh`, `shouldRetry`, `isAuthorized`.

Functions describe actions: `claimBatch()`, `markAsSent()`, `rotateRefreshToken()`, `validateOwnership()`.

Do not shadow variables (for example an inner `const qb` hiding an outer `qb`).

## Side effects

Avoid hidden side effects.

Bad:

```ts
items.map(item => {
  this.total += item.price;
  return item;
});
```

Prefer:

```ts
const total = items.reduce((sum, item) => sum + item.price, 0);
```

Do not use `map`/`filter` for side effects, including mutating entities inside `.map`.

## Closure mutation

Avoid mutating variables declared outside callbacks.

Bad:

```ts
let result;

await this.dataSource.transaction(async manager => {
  result = await operation(manager);
});

return result;
```

Prefer:

```ts
return this.dataSource.transaction(async manager => {
  return operation(manager);
});
```

## Dead code

Remove unreachable branches and stale fallbacks. A condition that is always true (for example `typeof lastValueFrom === 'function'`) makes its `else` branch dead.

## Magic values

Avoid `if (attempts > 5)` when `5` has business meaning.

```ts
const MAX_RETRY_ATTEMPTS = 5; // named and documented
```

Prefer typed config when appropriate: `config.retryMaxAttempts`. Every meaningful constant communicates its purpose.

## Types

Avoid `any`; prefer `unknown` and narrow safely (`catch (error: unknown)`).

Avoid duplicated inline object types when the shape is reused:

```ts
Promise<{ id: string; status: string }>   // avoid when reused
Promise<OrderStatusResult>                // prefer
```

Use interfaces, type aliases, enums, and unions for meaningful domain concepts. Shared shapes (for example `AuthenticatedUser`, `PublishBatchResult`) live in `types/` or alongside their module, not redefined inline. Use `strict: true`.

## Nullability

Do not use `value!` without a strong invariant. Prefer an explicit check and throw, or type narrowing. Do not use `@ts-ignore`.

---

# 4. Calculations and Comments

## Calculations (required)

Every calculation, formula, threshold, clamp, or unit conversion gets a comment above it stating:

1. what is computed
2. the formula
3. the units
4. why

```ts
// Backoff in ms = min(retryMaxMs, retryBaseMs * 2^(attempts - 1)).
// attempts is 1-indexed; doubling spreads retries so a failing broker isn't hammered.
const backoffMs = Math.min(
  this.config.retryMaxMs,
  this.config.retryBaseMs * Math.pow(2, attempts - 1),
);

// Lease is configured in ms but the SQL interval uses seconds; round UP so the lease is never shorter than configured.
const leaseSeconds = Math.ceil(this.config.leaseMs / 1000);
```

Apply to: percentages, pagination offsets, date arithmetic, retries, TTL, timeout conversion, monetary math, rounding, thresholds, clamps (`Math.min`/`Math.max`), and any magic constant (move to a named, documented constant).

## Other comments

Outside calculations, comments explain **why**, not what obvious code does.

Bad:

```ts
// Increment attempts
attempts++;
```

Good:

```ts
// Increment before computing backoff because RetryPolicy expects 1-indexed attempts.
attempts++;
```

Delete stale or misleading comments. Comments (and JSDoc return descriptions) must always match actual behavior and types.

---

# 5. NestJS Layering

```text
Controller
    ↓
Use Case / Service
    ↓
Repository / Store
    ↓
Entity
```

### Controller

Responsible for HTTP/RPC transport, validation, parameter extraction, response mapping. No business rules, no repositories, no raw queries.

Avoid:

```ts
@Post()
async create(@Body() dto: CreateOrderDto) {
  const user = await this.dataSource.query(...);
  if (...) { ... }
  await this.repository.save(...);
  return ...;
}
```

### Service / Use Case

Responsible for business rules, orchestration, domain decisions, transaction coordination. No infrastructure-specific query construction.

### Repository / Store

Responsible for database queries, persistence mechanics, query builders, projections, locking.

Prefer intent-based methods (`claimBatch()`, `findActiveReservation()`, `markExpired()`, `releaseInventory()`) over exposing SQL mechanics. Services must not build query-builder chains:

```ts
// avoid inside business services
this.repository
  .createQueryBuilder('reservation')
  .where(...)
  .setLock(...)

// prefer
await this.reservationStore.findForUpdate(reservationId);
```

## Cross-module boundaries

Modules communicate through public contracts. Do not deep-import another module's internals:

```ts
import { InternalInventoryRepository } from '../inventory/internal/...'; // avoid
```

If a module needs something from another: identify the capability, expose a public provider/interface, inject it through the module boundary.

## Dependency direction

Dependencies point toward stable business concepts:

```text
OrderService → OrderEventPublisher (abstraction) → RabbitMqEventPublisher (infrastructure)
```

not `Business Logic → RabbitMQ → TypeORM → framework details`.

---

# 6. Dependency Injection, Time, Randomness, Configuration

## Dependency injection

Use NestJS DI consistently. Avoid `new EmailProvider()` inside a service.

```ts
constructor(
  @Inject(EMAIL_PROVIDER)
  private readonly emailProvider: EmailProvider,
) {}
```

Use interfaces for meaningful infrastructure boundaries.

Use `@Optional()` only when absence is a truly supported mode. Handle it in module wiring (provide a no-op or disabled implementation), not with scattered `if (!this.client)` checks in services. Constructors with more than ~5 dependencies get reviewed for SRP.

## Time and randomness

Do not use `new Date()` or `randomUUID()` directly in business logic when deterministic tests or controlled time are needed. Inject `Clock` and `IdGenerator`:

```ts
interface Clock {
  now(): Date;
}
```

## Configuration

Never scatter `process.env.X` through services.

```text
environment → validated configuration → typed config → service
```

Configuration is validated, typed, parsed **once at startup**, and centralized (`registerAs` plus a Joi/zod/class-validator schema). Clamping and defaults live in the schema, not in getters re-parsed on every access. Fail fast on invalid or missing required configuration in production. No direct `process.env` outside the config layer.

---

# 7. Errors

Never silently swallow errors.

Bad:

```ts
try { await operation(); } catch {}
```

Catch only when the code can actually recover, transform the error, add meaningful context, clean up, or intentionally translate it. Otherwise let it propagate.

A catch must never silently switch to a weaker code path (for example, falling back to an unguarded write).

Use domain-specific errors. Map them to HTTP/RPC errors in one place (exception filter or interceptor) at the boundary. Log with context (ids, event type, attempt).

---

# 8. Persistence, Transactions, Concurrency

## Persistence

* Stores own all queries; methods express intent.
* Use DB time (`NOW()`) consistently for lease and eligibility logic. Do not mix app clocks and DB clocks (for example writing `processingStartedAt` with `new Date()` while comparing against `NOW()`).
* Ownership/lease-guarded updates return a boolean (`affected > 0`). **Never** fall back to an unguarded write.

## Transaction boundaries

Inside a DB transaction: DB reads, DB writes, locking, state transitions.

Avoid inside a transaction: HTTP calls, RabbitMQ publish, email, external APIs, long CPU work.

```text
transaction → persist state/event → commit → publish/process asynchronously
```

Keep transactions short.

## Concurrency

When refactoring concurrent code, preserve locks, ownership checks, leases, optimistic/pessimistic concurrency, atomic updates, idempotency, and transaction boundaries.

Never replace:

```sql
UPDATE ... WHERE id = ? AND lease_token = ?
```

with:

```sql
UPDATE ... WHERE id = ?
```

merely because it is simpler.

## Messaging and background jobs

Separate business orchestration, transport, retry policy, serialization, and persistence.

```text
Publisher → Transport interface → RabbitMQ implementation
```

* Transport interface: `publish(eventType, payload): Promise<void>`.
* Retry/backoff behind a `RetryPolicy` with pure functions, independently testable.
* Schedulers use a re-entrancy guard (or chained `setTimeout`, since `setInterval` with async work can overlap), `unref()` on timers, and **graceful shutdown** (await the in-flight run in `onModuleDestroy`).
* Consider whether lease duration can be exceeded by sequential processing of a large claimed batch; document or mitigate (lease renewal, bounded concurrency, smaller batches).
* Consumers are idempotent; document at-least-once delivery assumptions.
* `SENT_TO_MQ`-style statuses mean "accepted by transport", not "processed by consumer". Document that.

---

# 9. Request Flow and Database Read Optimization

Treat each incoming request as **one execution flow**, not as independent layers that each fetch the same data again.

## Request context

* Load user/auth data **once** and expose it via the authenticated request object (a guard attaches `request.user`, read through a `@CurrentUser()` decorator) or an equivalent request-scoped mechanism.
* Prefer the authenticated request object or `AsyncLocalStorage` (for example `nestjs-cls`) over `Scope.REQUEST` providers. Request-scoped providers make every dependent provider request-scoped and add per-request instantiation cost.
* Downstream layers reuse this data and do not re-query it.

## Data owner

* Exactly one layer is the authoritative loader of user data for a flow (normally the auth guard or strategy). Document it in that file's header (`Data owner:` line).
* Flag any flow where middleware, guard, controller, service, or downstream services each call `findUser()` (or equivalent) for the same request.

## Pass data, don't re-read it

If a downstream operation needs only data already loaded in this request (`user`, `userId`, roles, email, tenant), pass it as a parameter. Service signatures accept the minimal data they need (a small `AuthenticatedUser` type), rather than just an id that forces a re-fetch when the caller already holds the data.

## Fetch only what is needed

Use `select`/projections so each query returns only the fields the flow uses. Do not load full entities for a few fields. Review `eager: true` relations and unnecessary `relations: [...]`.

## Caching

* Do not add caching by default. Use Redis/cache only for data requested repeatedly across different requests where staleness is acceptable.
* The database remains the source of truth for security-critical or transactional state (permissions, token validity, revocation, balances, reservation state). Never authorize from a stale cache.
* Any cache must document its key, TTL, invalidation trigger, and why staleness is safe.

## Think in DB round trips

For every audited flow, list each DB read/write in order with the file/layer performing it and why it exists. Compute total round trips per request. Classify each:

* **required**: authoritative state, security, or transactional correctness
* **redundant**: data already loaded in this request
* **mergeable**: combinable into one query or a join

## Read budget

For high-traffic or sensitive flows (login, authentication, refresh-token rotation, email/OTP verification, and any the owner names), set an explicit target number of DB operations per request. Document it next to the flow (a comment in the use-case) and in the audit. No layer adds a query to a budgeted flow without updating the budget and justifying it. Add a regression test or query-count assertion per budgeted flow.

## Do not optimize by guessing

Identify duplicate queries first using the `debug` logs required in section 11, TypeORM query logging, tracing, query metrics, or profiling. Include evidence (log excerpt or query count). Refactor based on actual request flow and database behavior.

## Before removing any query, ask

```text
Is this data already available in this request?
Is the existing value authoritative?
Is this query enforcing authorization?
Is this query checking current state?
Is it inside a transaction?
Does removing it introduce a race condition?
```

Only remove a query when it is genuinely redundant.

## Goal

The final architecture makes obvious **where** data is loaded, **who owns** it, **who may reuse** it, and **why** each DB round trip exists.

---

# 10. Documentation: File Headers and Method JSDoc

## File header (required on every file)

Every `.ts` file starts with a JSDoc block stating its single responsibility and where it is used:

```ts
/**
 * This service is responsible for relaying outbox events to RabbitMQ.
 * It only orchestrates: claim -> publish -> record outcome.
 *
 * Responsibility (SRP): outbox relay orchestration, nothing else.
 * Used by: OutboxScheduler (polling), OutboxModule (provider).
 * Depends on: OutboxStore, OutboxTransport, RetryPolicy, OutboxConfig.
 */
```

Rules:

* Use real JSDoc `/** ... */` (not `/* ... **/`) so editors and TypeDoc pick it up.
* Describe the file type accurately: "This controller / service / repository / DTO / guard / entity / enum is responsible for ...".
* The "Responsibility" line is one sentence. Needing "and" for two jobs signals an SRP violation: split the file.
* "Used by" is verified by searching actual imports/injections, never guessed. Update it whenever usages change.
* Auth guards, strategies, and other data loaders add a `Data owner:` line naming what they load once per request and who reuses it.
* RPC/event consumers document event name, payload type, and idempotency in the header.
* Applies to controllers, services, repositories, entities, DTOs, enums, guards, interceptors, filters, modules, and config files. Skip only generated files. Tiny files (enums, DTOs) keep the header to 2-3 lines.

## Method documentation

Every public method has JSDoc with a description, `@param`, `@returns`, and `@throws` where applicable. Return descriptions must match the actual return type.

---

# 11. Logging

Use the NestJS `Logger` scoped to the class (`new Logger(ClassName.name)`). Never `console.log`.

## Log before every process and every DB read/write

So a failure can be located from logs alone and duplicate reads can be spotted:

* Before each DB read/write: `debug` with the operation and key identifiers (ids, counts, status filters).
* Before each external call (broker, HTTP, queue): `debug` with target and identifier.
* Before each significant process step (claim, publish, retry decision, state transition): `debug` with inputs.

## Log outcomes after

* `log`: success and one summary per batch
* `warn`: retries and recoverable issues
* `error`: failures, with stack

## Format

```text
<module> <action> <key=value pairs>
outbox claim start limit=100
outbox markSent start id=42 attempts=1
```

Include a request/correlation id where one exists.

## Safety and volume

* Never log passwords, tokens, secrets, PII, or full sensitive payloads. Log ids and metadata only. Truncate long error messages.
* Repeated warnings (for example missing config/transport) are logged once, then at `debug`.
* Hot paths (pollers, batch loops) log `debug` per item plus one `log` summary per batch, so production stays readable at `log` level.

---

# 12. Swagger / OpenAPI (required for every HTTP API)

Use `@nestjs/swagger`.

* **Controllers:** `@ApiTags`, `@ApiBearerAuth` (if guarded).
* **Endpoints:** `@ApiOperation({ summary, description })`, `@ApiParam` / `@ApiQuery` for params, `@ApiBody`, and a response decorator for **every** status the endpoint can return (`@ApiOkResponse`, `@ApiCreatedResponse`, `@ApiBadRequestResponse`, `@ApiUnauthorizedResponse`, `@ApiForbiddenResponse`, `@ApiNotFoundResponse`, `@ApiConflictResponse`, ...), each with a `type`.
* **DTOs (request and response):** every property has `@ApiProperty` / `@ApiPropertyOptional` with `description`, `example`, `type`, `enum` (with `enumName`), and `minimum`/`maximum`/`minLength`/`maxLength` matching the `class-validator` rules. Use separate response DTOs; never return entities directly.
* Use the `@nestjs/swagger` CLI plugin if configured, but still add explicit `description` and `example`.
* Paginated endpoints document `page`, `limit`, sorting, and a shared generic paginated response type.
* Document the error response shape once (`ErrorResponseDto`) and reuse it.
* Swagger setup lives in `main.ts` (title, version, description, bearer auth); the spec must load without errors.

```ts
/**
 * This controller is responsible for exposing reservation HTTP endpoints.
 * It validates input and delegates to ReservationService; no business logic.
 *
 * Used by: ReservationModule (route registration).
 */
@ApiTags('reservations')
@ApiBearerAuth()
@Controller('reservations')
export class ReservationController {
  @Post()
  @ApiOperation({ summary: 'Create a reservation', description: 'Reserves a slot for 15 minutes.' })
  @ApiCreatedResponse({ type: ReservationResponseDto })
  @ApiBadRequestResponse({ type: ErrorResponseDto })
  @ApiConflictResponse({ description: 'Slot already reserved', type: ErrorResponseDto })
  create(
    @CurrentUser() user: AuthenticatedUser, // loaded once by the auth guard, never re-queried
    @Body() dto: CreateReservationDto,
  ): Promise<ReservationResponseDto> { ... }
}
```

---

# 13. Tests

Tests verify behavior and contracts, not implementation details.

* Mock interfaces: Store, Transport, Clock, IdGenerator, EmailProvider.
* Do not mock TypeORM internals, NestJS internals, or framework implementation details.
* Tests remain valid when internals change.
* Add characterization tests before refactoring untested code.
* Add query-count assertions for budgeted flows.
* Pin concurrency behavior (token mismatch skips the write, lease reclaim) where it exists.

---

# 14. Abstraction Decision Checklist

Before creating a new abstraction, ask:

```text
1. What problem does this abstraction solve?
2. Does it isolate a real dependency?
3. Does it represent a meaningful responsibility?
4. Are there multiple implementations or consumers?
5. Does it improve testability?
6. Does it reduce coupling?
7. Will the abstraction remain understandable?
8. Is this solving today's problem rather than an imaginary future?
```

If the answers are mostly "no", do not create it.

---

# 15. Refactoring Safety

Before refactoring existing behavior:

1. Understand current behavior.
2. Identify public contracts.
3. Identify side effects.
4. Identify database invariants.
5. Identify transaction boundaries.
6. Identify events/messages.
7. Identify security checks.
8. Add characterization tests where necessary.
9. Refactor.
10. Run lint, `tsc --noEmit`, and the relevant tests.

Never assume that code which looks redundant is unnecessary.

---

# 16. Refactoring Priority

```text
1. Correctness
2. Security
3. Concurrency
4. Transaction integrity
5. Architectural coupling
6. Testability
7. Duplication
8. Maintainability
9. Documentation, naming, style
```

Do not spend significant effort on cosmetic cleanup while correctness problems remain.

---

# 17. Audit Phase (project-wide refactors)

Produce a read-only `REFACTOR_AUDIT.md` before editing code, then wait for approval. It contains:

* module/dependency map (flag circular dependencies)
* findings table: `file | principle violated | severity | proposed fix | risk`
* **correctness bugs** listed separately from style issues (unguarded writes, swallowed errors, race conditions, clock mixing)
* duplicated logic clusters
* per file: missing header JSDoc, missing method docs, DB/external calls without a preceding log, uncommented calculations, endpoints/DTOs missing Swagger decorators
* **request flow map** per important endpoint: `step | file/layer | operation | table | fields used | reason | required/redundant/mergeable`, with total DB round trips
* duplicate-read findings with evidence (log excerpts or query counts)
* proposed read budgets for sensitive flows
* proposed work order, highest value and lowest risk first

---

# 18. Refactoring Output

When this skill is used during a refactor, report:

```text
Change:
Why:
SOLID principle:
DRY issue:
Architectural impact:
Risk:
Behavior preserved:
Tests added/updated:
Dependencies changed:
Database behavior:
Documentation/logging added:
Remaining concerns:
```

For database-related refactors also report:

```text
DB reads before:
DB reads after:
Round trips before -> after (per flow):
Queries removed:
Why each removed query was redundant:
Queries intentionally retained:
Why each retained query is required:
```

Deliverables for a project-wide refactor:

1. `REFACTOR_AUDIT.md`, then wait for approval.
2. Small commits with clear messages (`refactor(outbox): extract OutboxStore`, `perf(auth): load user once per request`).
3. `REFACTOR_SUMMARY.md`: what changed, new abstractions and where they live, DB round trips before/after per flow, behavior-affecting fixes (listed separately), remaining tech debt.

---

# 19. Definition of Done (per module / flow)

* No function over ~30 lines or nesting deeper than 3 (as a review signal).
* No class with more than one reason to change.
* No `any`, no `process.env` outside config, no test-specific branches in production code.
* No duplicated blocks of 5+ similar lines that change for the same reason.
* Public behavior unchanged; tests green; lint and `tsc --noEmit` clean; coverage not reduced.
* Unit tests mock interfaces, not framework internals.
* Every file has the JSDoc header (responsibility, "Used by"), verified against real imports.
* Every public method has JSDoc (`@param`, `@returns`, `@throws`).
* Every DB read/write, external call, and process step is preceded by a `debug` log; outcomes are logged at the right level.
* No secrets, tokens, or PII in logs.
* Every calculation has a comment with formula, units, and reason.
* Every endpoint has Swagger decorators for all success and error statuses; every DTO property has `@ApiProperty` with description and example; the API docs load without errors.
* Each audited flow has one documented data owner, no redundant reads of the same entity within a request, projections on every read, a documented read budget, and a test guarding it.
* Every remaining DB round trip in a budgeted flow is justified.
* No cache introduced without documented key, TTL, invalidation, and why staleness is safe.

---

# 20. Reference Examples

## Outbox

`OutboxPublisher` becomes an orchestrator only:

* `OutboxConfig`: typed, validated once.
* `OutboxStore`: `claimBatch`, `markSent`, `markFailed` (token-guarded, returns boolean).
* `OutboxTransport`: interface with a RabbitMQ implementation.
* `RetryPolicy`: `decide(attempts)` returns `{ status, nextRetryAt }`.
* `OutboxScheduler`: interval with re-entrancy guard and graceful shutdown.
* `OutboxPublisher.publishBatch()`: claims, publishes each event, records the outcome. Nothing else.

## Authenticated request

* Before: `JwtGuard` loads the user, `AuthController` calls `findUser()`, `AuthService` calls `findUser()` again (3 reads of the same row).
* After: the guard loads the user once with a projection (`id`, `email`, `roles`, `tokenVersion`) and attaches it to `request.user`; the controller passes `AuthenticatedUser` to the service; the service performs only the reads/writes it truly needs (for example the refresh-token row inside the rotation transaction). The read budget is documented in the use-case.

---

# Final Rule

**Do not optimize for fewer lines of code.**

Optimize for:

```text
clear responsibility
+
correct behavior
+
low coupling
+
high cohesion
+
testability
+
explicit dependencies
+
observable, documented boundaries
```

A slightly longer implementation with clear boundaries is preferable to a shorter implementation with hidden coupling.

When uncertain between two designs, prefer the one that makes:

* ownership obvious
* dependencies explicit
* business rules visible
* infrastructure replaceable
* tests simple
* failure modes understandable
* every DB round trip justifiable

without introducing unnecessary abstraction.