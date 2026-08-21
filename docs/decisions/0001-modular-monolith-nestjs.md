# ADR 0001 — NestJS Modular Monolith

- **Status:** Accepted
- **Context:** Need a maintainable backend with clear boundaries that can scale
  infrastructure (Redis, RabbitMQ) independently later without becoming a
  distributed system.
- **Decision:** Use **NestJS 11** as a **modular monolith**. One deployable
  process, one PostgreSQL database, modules under `src/modules/*` with explicit
  `imports/providers/controllers/exports`.
- **Consequences:** Cross-module calls go through exported services, not raw
  repositories. Avoids premature microservices; keeps transactional consistency
  simple. If a module needs independent scaling later, it can be extracted.
- **Source:** `src/main.ts`, `src/app.module.ts`, `docs/plan.md` §2–§3, §32.
