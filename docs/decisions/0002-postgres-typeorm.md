# ADR 0002 — PostgreSQL + TypeORM

- **Status:** Accepted
- **Context:** Need a reliable, strongly-consistent store for transactional
  business state (users, products, cart, orders, inventory).
- **Decision:** **PostgreSQL 17** as the system of record, accessed via
  **TypeORM** (`typeorm` ^1.1). UUIDv4 primary keys, camelCase columns (no
  snake_case mapping configured), DB-level constraints (`@Check`, `@Unique`,
  `NOT NULL`).
- **Consequences:** PostgreSQL is authoritative for all business state. Use
  `dataSource.transaction` + `pessimistic_write` locks for concurrency control.
  `synchronize: true` is a dev shortcut; real migrations are required before
  production (see `docs/database/overview.md`).
- **Source:** `src/data-source.ts`, `docker-compose.yml`, `docs/plan.md` §2, §28.
