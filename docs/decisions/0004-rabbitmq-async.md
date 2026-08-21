# ADR 0004 — RabbitMQ for Async Notifications

- **Status:** Accepted
- **Context:** Need to notify users (order created/completed, etc.) without
  blocking the request path or coupling it to the consistency-critical transaction.
- **Decision:** **RabbitMQ 4** is connected as a NestJS microservice
  (`Transport.RMQ`) in `main.ts`, with a `NOTIFICATION_SERVICE` client registered
  in `app.module.ts`. Events are published **after** the DB transaction commits.
- **Consequences:** The message broker is infrastructure, not a source of truth.
  It must never sit inside the inventory/order consistency path (see
  `docs/plan.md` §19). Consumers/workers are not yet implemented.
- **Source:** `src/main.ts`, `src/app.module.ts` (`ClientsModule`),
  `docker-compose.yml`, `docs/plan.md` §19–§20.
