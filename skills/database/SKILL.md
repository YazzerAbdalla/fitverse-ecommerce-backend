---
name: database
description: TypeORM/PostgreSQL conventions for this repo — entities, relations, indexes, transactions, concurrency, migrations. Use when designing or changing the data model.
---

# Database (TypeORM + PostgreSQL)

Read [`docs/database/overview.md`](../../docs/database/overview.md) and
[`relationships.md`](../../docs/database/relationships.md) for the current model.

## Conventions

- **PK:** `@PrimaryGeneratedColumn('uuid')` everywhere.
- **Naming:** table = entity class name (`Product`, `User`, …); columns are
  `camelCase` (no snake_case mapping configured). Don't mix.
- **Relations:** `@ManyToOne`/`@OneToMany`/`@OneToOne` + `@JoinColumn` on owner;
  let TypeORM create FKs. Don't add bidirectional relations unless needed for
  navigation.
- **Constraints:** enforce in DB — `@Check`, `@Unique`, `NOT NULL`. Example:
  `Product` has `@Check('"stock" >= 0')` and `@Unique(['name'])`.
- **Indexes:** `@Index()` only for real access patterns (`User.email`,
  `Product.name`). Don't index everything.
- **Avoid N+1:** use `relations` in `find*` / `leftJoinAndSelect`. `CartItem.
  product` is `eager: true` by design.

## Transactions & concurrency

- Wrap multi-row writes in `dataSource.transaction(async manager => …)` and use
  `manager.getRepository(Entity)` for all writes.
- Prevent overselling with **pessimistic row lock**:
  `lock: { mode: 'pessimistic_write' }` inside the transaction (see
  `products.service.ts:updateMany`).
- Never compute availability by loading all reservations into memory; maintain
  `reserved_amount` as the aggregate (see inventory design).

## Migrations

- `data-source.ts` sets `migrations: ['src/migration/**/*.ts']` but **none exist**;
  `synchronize: true` is a dev shortcut. Before production, disable `synchronize`
  and add real migrations.
- Never edit a committed migration — add a new one.

## Inventory/reservation (target)

See [`docs/architecture/inventory-reservation.md`](../../docs/architecture/inventory-reservation.md).
`InventoryService` should remain the only writer of `stock`/`reserved_amount`.
