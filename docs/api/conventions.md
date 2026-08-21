# API — Conventions

The app exposes **two API styles**: REST for `auth`, `cart`, `order`; GraphQL
(Apollo, code-first) for `products`. Swagger UI is at `/api` (bearer auth).

## Global behavior (both styles)

- **ValidationPipe** (registered in `main.ts`):
  `whitelist: true`, `forbidNonWhitelisted: true`, `transform: true`. Unknown
  fields are stripped/rejected; payloads are transformed into DTO/class instances.
- **AllExceptionsFilter** (registered in `main.ts`) handles both REST and GraphQL
  and is the single place errors are serialized.

## REST

### Routing

Noun resources + HTTP verbs:

```text
POST   /auth/register
POST   /auth/login
GET    /cart
POST   /cart/items
PATCH  /cart/items/:id
DELETE /cart/items/:id
GET    /order            (protected: @Auth(UserRoles.User))
POST   /order
GET    /order/:id
PATCH  /order/:id
DELETE /order/:id
```

### Status codes

| Code | Use |
| --- | --- |
| 200 / 201 | success (201 for create) |
| 400 | bad input (also DTO validation failures) |
| 401 | unauthenticated (`JwtGuard`) |
| 403 | forbidden / insufficient role (`RolesGuard`) |
| 404 | not found |
| 409 | conflict (e.g. duplicate email, insufficient stock) |
| 422 | validation |
| 500 | unexpected |

### Error body (REST)

```json
{ "statusCode": 409, "message": "…", "timestamp": "2026-…" }
```

Throw Nest HTTP exceptions in services; the filter serializes them. Do **not**
return plain objects for expected errors.

### Auth / authz

- Protected routes use `@Auth(...roles)` → applies `JwtGuard` + `RolesGuard`.
- Current user: `@CurrentUser()` (whole payload) or `@CurrentUser('email')` etc.
- JWT signed by global `JwtModule` (secret `JWT_SECRET`, `JWT_EXPIRES_IN` from
  `.env`).

### Pagination (products list equivalent)

Offset-based `{ page, limit }` → `skip = (page - 1) * limit`; return shape:

```json
{
  "data": [ … ],
  "meta": {
    "totalItems": 42,
    "itemCount": 10,
    "itemsPerPage": 10,
    "totalPages": 5,
    "currentPage": 1
  }
}
```
Reuse this shape for new list endpoints.

## GraphQL (products)

- Code-first: entities carry `@ObjectType()`/`@Field()`; inputs are `*.input.ts`;
  args are `*.args.ts`. Resolver methods map 1:1 to `ProductsService`.
- Errors surface as `GraphQLError` with `extensions.code` (status int), still via
  `AllExceptionsFilter`.
- No auth wiring on the GraphQL side yet (only REST uses `@Auth`).

## Validation

- REST: `*.dto.ts` with `class-validator` decorators; every accepted field must be
  declared (the global pipe rejects unknowns).
- GraphQL: `*.input.ts` / `*.args.ts` with `class-validator` + `@Field()`.
- Quantities/prices from clients are **never trusted**; re-validate invariants in
  the service (e.g. positive integer quantity, stock sufficiency).
