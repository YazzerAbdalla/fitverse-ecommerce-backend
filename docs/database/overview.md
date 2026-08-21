# Database — Overview

PostgreSQL 17 via TypeORM (`typeorm` ^1.1). The `DataSource` is configured in
`src/data-source.ts` and reused by `app.module.ts` (`TypeOrmModule.forRootAsync`).

## Current entities

| Entity | Module | Notes |
| --- | --- | --- |
| `User` | users | UUID PK, `email` indexed, `role` enum, `password` (bcrypt), relations to `Order`, `Cart` |
| `Product` | products | UUID PK, `@Check('"stock" >= 0')`, `@Unique(['name'])`, `@Index(['name'])`, GraphQL `@ObjectType` |
| `Cart` | cart | UUID PK, `@OneToOne(User)` with `@JoinColumn` |
| `CartItem` | cart | UUID PK, `@ManyToOne(Cart)`, `@ManyToOne(Product, { eager: true })`, `quantity` |
| `Order` | order | UUID PK, `status` enum, `total_price` bigint, `@ManyToOne(User)`, `@ManyToMany(OrderItem)` + `@JoinTable` |
| `OrderItem` | order | UUID PK, `product_id`, `quantity` decimal, `unit_price` decimal, `subtotal` generated `STORED` (`quantity * unit_price`) |

`Inventory`, `Reservation`, `ReservationItem` do **not** exist yet (see
[`../architecture/inventory-reservation.md`](../architecture/inventory-reservation.md)).

## Conventions (enforced by code + rules)

- **Primary keys:** `@PrimaryGeneratedColumn('uuid')` everywhere (UUIDv4).
- **Naming:** table name = entity class name (e.g. `Product`, `User`); columns are
  `camelCase`. **No `snake_case` mapping is configured** — keep columns camelCase
  to match the code. Do not mix.
- **Relations:** defined with `@ManyToOne`/`@OneToMany`/`@OneToOne` +
  `@JoinColumn` on the owning side; TypeORM creates FK columns.
- **Constraints:** enforce in DB (`@Check`, `@Unique`, `NOT NULL`) — e.g.
  `Product` stock ≥ 0, unique name.
- **Transactions:** use `dataSource.transaction(async manager => …)` and perform
  all writes through `manager` (see `products.service.ts:updateMany`).
- **Concurrency:** pessimistic row lock `lock: { mode: 'pessimistic_write' }`
  inside the transaction to prevent overselling.

## Migrations

- `data-source.ts` sets `migrations: ['src/migration/**/*.ts']` but **no migrations
  exist**; `synchronize: true` is on (dev shortcut).
- Before production: turn off `synchronize`, add real migrations. Never edit a
  committed migration — add a new one.
- To generate: `typeorm migration:generate` against this `DataSource` (or the
  configured script). Ensure `dotenv` loads `.env` (already imported in
  `data-source.ts`).

## Config

Read from `.env` (git-ignored): `POSTGRES_HOST/PORT/USER/PASSWORD/DATABASE`.
`data-source.ts` uses `dotenv.config()`; `app.module.ts` reads the same via
`ConfigModule`/`ConfigService`.
