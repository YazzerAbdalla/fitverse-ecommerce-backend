# Architecture — Overview

This document describes the **actual** system as implemented in the repository.
For the narrative design rationale (especially inventory/reservation/order), see
[`docs/plan.md`](../plan.md).

## Style

A **modular monolith**: one NestJS 11 process, one PostgreSQL database, with
strict module boundaries. Redis and RabbitMQ are infrastructure, not a source of
truth.

## Layers

```text
Client (REST / GraphQL)
        │
        ▼
NestJS app (src/main.ts)
  • Global ValidationPipe (whitelist + forbidNonWhitelisted + transform)
  • Global AllExceptionsFilter (REST + GraphQL)
  • Swagger at /api (bearer auth)
  • CORS enabled
  • RMQ microservice connected (NOTIFICATION_SERVICE)
        │
        ▼
Modules (src/modules/*)
  • Controllers / Resolvers  → thin
  • Services                 → business logic + DB access
  • Entities / DTOs / Inputs → types + validation
        │
        ▼
PostgreSQL 17  (authoritative)
Redis 8       (cache only)
RabbitMQ 4    (async notifications)
```

## Bootstrap

- `src/main.ts` creates the app, wires global pipe/filter, connects the RMQ
  microservice, mounts Swagger, enables CORS, and listens on `PORT` (3000).
- `src/app.module.ts` imports `ConfigModule` (global), `TypeOrmModule`
  (async, reuses `data-source.ts` `AppDataSource`), `CacheModule` (Redis via
  keyv), `ClientsModule` (RMQ), `GraphQLModule` (Apollo, `src/schema.gql`), then
  the feature modules.
- `src/data-source.ts` is the TypeORM `DataSource` (PostgreSQL, `synchronize:
  true` for dev, `migrations: ['src/migration/**/*.ts']` — none exist yet).

## Module responsibilities (current state)

| Module | API | Responsibility | State |
| --- | --- | --- | --- |
| `auth` | REST | JWT login/register, `Auth`/`CurrentUser` decorators, `JwtGuard`, `RolesGuard` | Implemented |
| `users` | — | `User` entity, `UserRoles`, email lookup | Implemented |
| `products` | **GraphQL** | CRUD + pagination, list caching, pessimistic-lock `updateMany` | Implemented |
| `cart` | REST | Per-user cart + items (eager product), stock checks | Implemented |
| `order` | REST | Order endpoints (currently **stubs**) | Placeholder |
| `inventory` | — | `InventoryService` stock dec/inc on `EntityManager` | Partial |

See [`modules.md`](./modules.md) for detail and [`data-flow.md`](./data-flow.md)
for request/transaction flows.
