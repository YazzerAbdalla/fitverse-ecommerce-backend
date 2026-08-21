# Architecture Decision Records

Decision logs for this repository. Each ADR records a choice that has been
**made and is reflected in the code or the agreed design**. Things that are
**not yet decided** are listed under [Open Questions](#open-questions) — do not
pretend a decision exists where none has been made.

Format: `NNNN-short-title.md` with `Status: Accepted | Proposed | Intended`.
"Intended" = designed in `docs/plan.md` but not yet implemented in code.

## Index

| ADR | Title | Status |
| --- | --- | --- |
| [0001](./0001-modular-monolith-nestjs.md) | NestJS modular monolith | Accepted |
| [0002](./0002-postgres-typeorm.md) | PostgreSQL + TypeORM | Accepted |
| [0003](./0003-redis-cache-only.md) | Redis as cache only (not authoritative) | Accepted |
| [0004](./0004-rabbitmq-async.md) | RabbitMQ for async notifications | Accepted |
| [0005](./0005-jwt-auth.md) | JWT auth (Passport + bcrypt + roles) | Accepted |
| [0006](./0006-graphql-products.md) | GraphQL for products, REST elsewhere | Accepted |
| [0007](./0007-inventory-reservation.md) | Inventory/reservation intended model | Intended |

## Open Questions (undecided — decide in a spec, not in code)

- **Rate limiting strategy** — Redis is available but no limiter is implemented;
  decision needed (per-route? distributed?). See `docs/plan.md` §22.
- **Reservation timing** — reserve at cart-add vs only at checkout. Not decided.
- **Reservation duration (TTL)** — not set.
- **`OrderStatus` enum** — current `{ SUCCESS, FAILD, PENDING }` has a typo
  (`FAILD`) and does not match the reservation/order state machine. Needs a spec
  and rename.
- **`InventoryService.checkAvailability`** — current implementation has inverted
  logic (throws when stock *is* sufficient). Bug to fix when implementing
  inventory.
- **Product cache invalidation** — list cache (`products:list:*`) is never
  invalidated on mutations; decide invalidation strategy.
- **Migrations vs `synchronize`** — `synchronize: true` is a dev shortcut; must
  move to real migrations before production.
- **`auth.service.ts` leftover `console.log`** — remove; use `Logger`.
- **Favorites module** — listed in `docs/plan.md` but not implemented; decide
  scope.
