# ADR 0006 — GraphQL for Products, REST Elsewhere

- **Status:** Accepted
- **Context:** Product catalog benefits from a flexible query API; operational
  endpoints (auth, cart, order) are simpler as REST with Swagger.
- **Decision:** **Products** are exposed via **GraphQL** (Apollo, code-first:
  entities carry `@ObjectType()`/`@Field()`, inputs in `*.input.ts`). **Auth,
  cart, order** are **REST** controllers with the global `ValidationPipe` and
  Swagger at `/api`.
- **Consequences:** Two API styles coexist. GraphQL and REST share the same
  global `AllExceptionsFilter` and validation philosophy. Auth wiring exists only
  on the REST side today; if GraphQL needs protection, apply the same `@Auth`
  pattern (it is transport-agnostic). Mixed surface is intentional, not a bug.
- **Source:** `src/modules/products/*`, `src/app.module.ts` (`GraphQLModule`),
  `docs/api/conventions.md`.
