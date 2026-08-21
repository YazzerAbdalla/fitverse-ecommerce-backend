---
name: code-review
description: Review NestJS/TypeORM changes for correctness, security, performance, DB consistency, concurrency, error handling, and architecture violations. Use before marking work complete.
---

# Code Review

Apply to every change. Prioritize correctness, consistency, security, and
concurrency safety over style.

## Checklist

### Correctness
- Business logic in **services**, not controllers/resolvers.
- DTOs declare every accepted field; global pipe strips unknowns.
- Quantities/prices re-validated in the service (client input untrusted).
- Return shapes match existing conventions (e.g. pagination `data`+`meta`).

### Security
- No secrets in source; read from `.env`/`ConfigService` only.
- Auth via `@Auth(...roles)` + `@CurrentUser`; no hand-rolled auth.
- Passwords hashed (bcrypt); never returned in responses.
- No SQL injection — use parameterized queries / repositories / `In()` / `FindOptions`.

### Performance
- No N+1: use `relations` / `leftJoinAndSelect`; `CartItem.product` is eager.
- Cache reads where appropriate (products list), but don't cache authoritative
  inventory values.
- Avoid loading all rows to compute aggregates; use DB aggregates/`reserved_amount`.

### DB consistency & concurrency
- Multi-row writes wrapped in `dataSource.transaction` with all writes via
  `manager`.
- Overselling prevented via `pessimistic_write` lock on the inventory/product row.
- `available = stock - reserved_amount`; don't store `available` independently.
- Migrations (not `synchronize`) for schema in production; never edit committed
  migrations.

### Error handling
- Throw Nest HTTP exceptions; the global `AllExceptionsFilter` serializes them.
- Don't swallow expected errors into plain objects.
- Use correct status codes (409 for stock/duplicate conflicts, 404 not found, …).

### Maintainability & architecture
- Cross-module calls via exported **services**, not foreign repositories.
- `Logger` used instead of `console.log`.
- No unnecessary new dependencies.
- Changes touch only what's needed; no unrelated "style" rewrites.

## Output

For each issue: severity (blocker/major/minor), file:line, why it matters, and a
concrete fix. Confirm tests cover the changed behavior.
