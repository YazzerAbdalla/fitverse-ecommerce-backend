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
* resistant to accidental behavior changes

This skill is especially important when performing refactors on an existing codebase.

---

# Core Principle

**Prefer simple, explicit architecture over clever abstraction.**

Do not refactor code merely to make it look "clean."

Every abstraction must have a concrete reason.

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

# 1. SOLID

## S — Single Responsibility Principle

A class, function, or module should have **one primary reason to change**.

A responsibility is a cohesive business or technical concern.

### Identify SRP violations

Flag classes that combine unrelated concerns such as:

```text
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
retry logic
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

when these abstractions only move code around without improving responsibility boundaries.

---

# 2. Open/Closed Principle

Code should be open to extension without requiring modification of stable orchestration logic.

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
  publish(event: DomainEvent): Promise<void>;
}
```

with implementations:

```text
RabbitMqTransport
KafkaTransport
SqsTransport
```

and inject the appropriate implementation.

### Do not over-apply OCP

Do not introduce strategies/factories/interfaces for a behavior that has only one implementation and no realistic extension boundary.

The existence of an `if` statement is not automatically an OCP violation.

---

# 3. Liskov Substitution Principle

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

Prefer:

```text
smaller interfaces
```

or a domain model that accurately represents capabilities.

---

# 4. Interface Segregation Principle

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
```

and:

```ts
interface UserWriter {
  update(...): Promise<void>;
}
```

Use small interfaces when they represent meaningful dependency boundaries.

Do not split interfaces into meaningless fragments solely to satisfy a rule.

---

# 5. Dependency Inversion Principle

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

Use DI tokens.

Do not instantiate collaborators inside business services:

```ts
new SomeService()
new Date()
randomUUID()
```

when those dependencies affect business behavior or test determinism.

---

# 6. DRY

## Rule of Three

Do not abstract the first occurrence.

Generally:

```text
1 occurrence → leave it
2 occurrences → investigate
3 occurrences → consider abstraction
```

But duplication should be judged by **reason for change**, not textual similarity.

Two similar functions may legitimately remain separate if they represent different domain concepts.

---

# 7. Types of Duplication

Look for repeated:

### Business logic

```text
same calculation
same state transition
same validation
same authorization rule
```

### Infrastructure logic

```text
same retry logic
same error mapping
same query conditions
same transaction pattern
same configuration parsing
```

### Data transformation

```text
same DTO mapping
same response construction
same event payload construction
```

### Configuration

```text
same environment parsing
same defaulting
same clamping
same validation
```

---

# 8. Avoid False DRY

Do not create abstractions like:

```ts
executeOperation()
processData()
handleRequest()
commonHelper()
baseService()
```

unless they represent a real shared responsibility.

Avoid generic abstractions that hide important business meaning.

Prefer:

```ts
claimExpiredReservations()
```

over:

```ts
executeOperation()
```

Prefer:

```ts
markReservationExpired()
```

over:

```ts
updateStatus()
```

Domain intent is more important than maximum code reuse.

---

# 9. Clean Code

## Functions

Prefer:

* small functions
* one level of abstraction
* early returns
* clear names
* minimal parameters
* minimal side effects

Avoid:

* deep nesting
* large switch statements
* boolean flag arguments
* hidden mutations
* multiple unrelated responsibilities

Target:

```text
~30 lines or less
```

but treat this as a review signal, not a mathematical rule.

A 45-line cohesive function can be better than five meaningless helper functions.

---

# 10. Naming

Names should explain intent.

Avoid:

```ts
e
x
data
obj
res
req
qb
obs
lim
tmp
```

Prefer:

```ts
user
order
queryBuilder
paginationLimit
reservation
authenticatedUser
```

Boolean values should read as predicates:

```ts
isExpired
hasPermission
canRefresh
shouldRetry
isAuthorized
```

Functions should describe actions:

```ts
claimBatch()
markAsSent()
rotateRefreshToken()
validateOwnership()
```

---

# 11. NestJS Layering

Prefer:

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

Responsible for:

* HTTP/RPC transport
* validation
* parameter extraction
* response mapping

Controllers should not contain business rules.

Avoid:

```ts
@Post()
async create(@Body() dto: CreateOrderDto) {
  const user = await this.dataSource.query(...);

  if (...) {
    ...
  }

  await this.repository.save(...);

  return ...;
}
```

---

### Service / Use Case

Responsible for:

* business rules
* orchestration
* domain decisions
* transaction coordination

It should not contain infrastructure-specific query construction.

---

### Repository / Store

Responsible for:

* database queries
* persistence mechanics
* query builders
* projections
* locking
* persistence-specific operations

Prefer intent-based methods:

```ts
claimBatch()
findActiveReservation()
markExpired()
releaseInventory()
```

instead of exposing SQL mechanics to business services.

---

# 12. Cross-Module Boundaries

Modules should communicate through public contracts.

Prefer:

```text
OrdersModule
    ↓
InventoryService public API
```

Avoid:

```ts
import { InternalInventoryRepository }
  from '../inventory/internal/...';
```

Do not deep-import another module's internals.

If a module needs something from another module:

1. identify the required capability
2. expose a public provider/interface
3. inject it through the module boundary

---

# 13. Dependency Direction

Prefer dependencies pointing toward stable business concepts.

Avoid:

```text
Business Logic
    ↓
RabbitMQ
    ↓
TypeORM
    ↓
Framework details
```

Prefer:

```text
Business Logic
    ↓
Abstraction
    ↓
Infrastructure implementation
```

Example:

```text
OrderService
    ↓
OrderEventPublisher
    ↓
RabbitMqEventPublisher
```

---

# 14. Repository Boundaries

Do not allow services to build database queries directly.

Avoid:

```ts
this.repository
  .createQueryBuilder('reservation')
  .where(...)
  .andWhere(...)
  .leftJoin(...)
  .setLock(...)
```

inside business services.

Move persistence mechanics into a repository/store.

The service should express intent:

```ts
await this.reservationStore.findForUpdate(reservationId);
```

---

# 15. Dependency Injection

Use NestJS DI consistently.

Avoid:

```ts
const provider = new EmailProvider();
```

inside a service.

Prefer:

```ts
constructor(
  @Inject(EMAIL_PROVIDER)
  private readonly emailProvider: EmailProvider,
) {}
```

Use interfaces for meaningful infrastructure boundaries.

---

# 16. Time and Randomness

Do not directly use:

```ts
new Date()
randomUUID()
```

inside business logic when deterministic testing or controlled time is required.

Prefer:

```ts
Clock
IdGenerator
```

Example:

```ts
interface Clock {
  now(): Date;
}
```

This allows deterministic tests.

---

# 17. Configuration

Never scatter:

```ts
process.env.SOME_VALUE
```

throughout services.

Prefer:

```text
environment
    ↓
validated configuration
    ↓
typed config
    ↓
service
```

Configuration should be:

* validated
* typed
* parsed once
* centralized

Do not repeatedly parse environment variables inside methods.

---

# 18. Error Handling

Never silently swallow errors.

Bad:

```ts
try {
  await operation();
} catch {}
```

Catch only when the code can actually:

* recover
* transform the error
* add meaningful context
* perform cleanup
* intentionally translate the error

Otherwise allow the error to propagate.

Use domain-specific errors where appropriate.

Map domain errors to transport-specific errors at the boundary.

---

# 19. Side Effects

Avoid hidden side effects.

Bad:

```ts
items.map(item => {
  this.total += item.price;
  return item;
});
```

Use explicit iteration or a reduction:

```ts
const total = items.reduce(
  (sum, item) => sum + item.price,
  0,
);
```

Do not use `map`/`filter` for side effects.

---

# 20. Closure Mutation

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

This makes control flow explicit and easier to reason about.

---

# 21. Magic Values

Avoid:

```ts
if (attempts > 5)
```

when `5` has business meaning.

Prefer:

```ts
const MAX_RETRY_ATTEMPTS = 5;
```

Even better when configuration is appropriate:

```ts
config.retryMaxAttempts
```

Every meaningful constant should communicate its purpose.

---

# 22. Calculations

Every non-trivial calculation should explain:

1. what is calculated
2. formula
3. units
4. reason

Example:

```ts
// Backoff in milliseconds = base delay × 2^(attempt - 1).
// attempt is 1-indexed; exponential growth prevents hammering a failing dependency.
const delayMs = baseDelayMs * Math.pow(2, attempt - 1);
```

Apply this to:

* percentages
* pagination
* date arithmetic
* retries
* TTL
* timeout conversion
* monetary calculations
* rounding
* thresholds
* clamps

---

# 23. Comments

Comments should explain **why**, not what obvious code does.

Bad:

```ts
// Increment attempts
attempts++;
```

Good:

```ts
// Increment the attempt count before calculating backoff because RetryPolicy uses 1-indexed attempts.
attempts++;
```

Delete stale comments.

Comments must always match actual behavior.

---

# 24. Types

Avoid:

```ts
any
```

Prefer:

```ts
unknown
```

then narrow safely.

Avoid duplicated inline object types:

```ts
Promise<{
  id: string;
  status: string;
}>
```

when the shape has meaningful reuse.

Prefer:

```ts
Promise<OrderStatusResult>
```

Use:

* interfaces
* type aliases
* enums
* unions

when they represent meaningful domain concepts.

---

# 25. Nullability

Do not use:

```ts
value!
```

without a strong invariant proving the value cannot be null.

Prefer:

```ts
if (!value) {
  throw new ...
}
```

or narrow through types.

Do not use non-null assertions merely to silence TypeScript.

---

# 26. Tests

Tests should verify behavior and contracts, not implementation details.

Prefer mocking:

```text
Store
Transport
Clock
IdGenerator
EmailProvider
```

rather than mocking:

```text
TypeORM internals
NestJS internals
framework implementation details
```

Tests should remain valid when internal implementation changes.

---

# 27. Refactoring Safety

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
10. Run the relevant tests.

Never assume that code which looks redundant is actually unnecessary.

---

# 28. Database Read Discipline

Treat a request as one complete execution flow.

If authentication already loaded:

```ts
request.user
```

do not immediately query the same user again.

Before removing a query ask:

```text
Is this data already available?
Is the existing value authoritative?
Is this query enforcing authorization?
Is this query checking current state?
Is it inside a transaction?
Does removing it introduce a race condition?
```

Only remove a query when it is genuinely redundant.

---

# 29. Transaction Boundaries

Keep transactions focused.

Inside a DB transaction:

```text
DB reads
DB writes
locking
state transitions
```

Avoid:

```text
HTTP calls
RabbitMQ publish
email
external APIs
long CPU work
```

inside the transaction.

Use patterns such as:

```text
transaction
    ↓
persist state/event
    ↓
commit
    ↓
publish/process asynchronously
```

when appropriate.

---

# 30. Concurrency

When refactoring concurrent code, preserve:

* locks
* ownership checks
* leases
* optimistic/pessimistic concurrency
* atomic updates
* idempotency
* transaction boundaries

Never replace:

```sql
UPDATE ...
WHERE id = ?
AND lease_token = ?
```

with:

```sql
UPDATE ...
WHERE id = ?
```

merely because the second query is simpler.

---

# 31. Messaging

Separate:

```text
business orchestration
transport
retry policy
serialization
persistence
```

Example:

```text
Publisher
    ↓
Transport interface
    ↓
RabbitMQ implementation
```

Retry policy should be independently testable.

Consumers should be idempotent.

Document at-least-once delivery assumptions.

---

# 32. Logging

Use NestJS `Logger`.

Never use:

```ts
console.log()
```

Log meaningful events around:

* DB operations
* external calls
* state transitions
* retries
* failures

Never log:

* passwords
* tokens
* secrets
* PII
* complete sensitive payloads

Logs should provide enough context to debug failures without exposing sensitive data.

---

# 33. Abstraction Decision Checklist

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

If the answer is mostly "no", do not create it.

---

# 34. Refactoring Priority

When multiple issues exist, prioritize:

```text
1. Correctness
2. Security
3. Concurrency
4. Transaction integrity
5. Architectural coupling
6. Testability
7. Duplication
8. Maintainability
9. Naming/style
```

Do not spend significant effort on cosmetic cleanup while correctness problems remain.

---

# 35. Refactoring Output

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
Remaining concerns:
```

For database-related refactors also report:

```text
DB reads before:
DB reads after:
Queries removed:
Why each removed query was redundant:
Queries intentionally retained:
Why each retained query is required:
```

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
maintainable boundaries
```

A slightly longer implementation with clear boundaries is preferable to a shorter implementation with hidden coupling.

When uncertain between two designs, prefer the one that makes:

* ownership obvious
* dependencies explicit
* business rules visible
* infrastructure replaceable
* tests simple
* failure modes understandable

without introducing unnecessary abstraction.
