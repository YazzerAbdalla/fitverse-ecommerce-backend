---
name: backend-development
description: Implement NestJS backend features (modules, services, controllers/resolvers, DTOs, auth) following this repo's conventions. Use when adding or modifying API/domain behavior.
---

# Backend Development (NestJS)

Follow the structure under `src/modules/<name>/`. This repo is a **NestJS 11
modular monolith** (TypeScript, npm). Read [`AGENTS.md`](../AGENTS.md) and the
relevant module in [`docs/architecture/modules.md`](../docs/architecture/modules.md)
before coding.

## Module shape

```text
src/modules/<name>/
  <name>.module.ts     # imports / providers / controllers / exports
  <name>.service.ts    # business logic + DB access (inject Logger)
  <name>.controller.ts # REST (thin)  OR  <name>.resolver.ts (GraphQL)
  entities/*.entity.ts # TypeORM + (products) @ObjectType/@Field
  dto/*.dto.ts         # REST class-validator
  dto/*.input.ts       # GraphQL inputs
  *.spec.ts            # unit tests
```

- Export any service another module needs; other modules import the **service**,
  never `@InjectRepository` of a foreign entity.
- Inject `Logger` and use it (no `console.log`).

## Controller / Resolver

Thin only: parse input → call service → return result. No DB access, no business
logic. REST uses `@Auth(...roles)` + `@CurrentUser()` for auth.

## DTOs / Inputs

- All fields annotated with `class-validator`. The global `ValidationPipe`
  (`whitelist + forbidNonWhitelisted + transform`) rejects unknown fields.
- Quantities/prices from clients are untrusted — re-validate invariants in the
  service.

## Auth

Use the existing `Auth(...roles)` decorator (`JwtGuard` + `RolesGuard`) and
`@CurrentUser('prop')`. Do not hand-roll auth. Roles: `UserRoles.Admin/User`.

## Errors

Throw Nest HTTP exceptions (`BadRequestException`, `NotFoundException`,
`ConflictException`, `ForbiddenException`, `UnauthorizedException`). The global
`AllExceptionsFilter` serializes them; do not return plain objects.

## Transactions

Multi-row writes (order + inventory, reservation + inventory) go inside
`dataSource.transaction(async manager => { … })`; do **all** writes through
`manager`. See `products.service.ts:updateMany` for the `pessimistic_write` lock
pattern.

## Documentation (required — see AGENTS.md §3)

- Add class-level JSDoc `/** This service is responsible for ... */` to every `Service`/`Controller`/`Resolver`/`Entity`/`Guard`.
- Add method-level JSDoc (`@param`, `@returns`, `@throws`) to every public method.
- Add `//` intent comments for complex conditions and formulas (e.g. `// Available stock excludes already-reserved units` before `stock - reservedAmount` checks, `// skip pagination: (page-1)*limit`).

## Tests, docs & verification

- Mirror existing test style (`*.spec.ts`).
- Update `docs/` and `docs/decisions/` when behavior/architecture changes.
- Run `npm run lint && npm run build && npm run test` before marking complete.
