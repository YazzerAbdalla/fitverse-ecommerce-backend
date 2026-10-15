# `api/` — machine-readable contracts

## `schema.graphql` (checked in, verified)

`schema.graphql` in this directory is a **verbatim copy of the backend-generated `src/schema.gql`** (Apollo code-first, `autoSchemaFile`, `src/app.module.ts:65-69`), copied on 2026-10-10 and not hand-edited. It is the source of truth for `API-GQL-*` (queries, mutations, `Product`, `ProductPagination`, inputs). Regenerate by booting the backend (`npm run start:dev`) — the file is rewritten on boot; diff it before trusting a cached copy.

## `openapi.json` (NOT checked in — intentionally)

No `openapi.json` is checked in because **no verified export was produced during this task** (per Rule D / §13.11: never fabricate an OpenAPI file and label it backend-generated).

### How to generate it (backend owner, 2 minutes)

1. Boot the backend with infra up: `docker-compose up -d && npm run start:dev`.
2. Open Swagger UI at `http://localhost:3000/api` (wired in `src/main.ts:49-65`).
3. Export the JSON from `http://localhost:3000/api-json` (default NestJS Swagger JSON endpoint for the `api` setup) and save it here as `api/openapi.json`.
4. Verify before use: confirm it contains the REST controllers actually inspected (`auth`, `cart`, `order`, `payments`, `inventory`, `reservations`, `notifications`, `admin/outbox`, `users`, `admin/products`) and that the paths/methods match `api-contract.md`.

### Known contract gaps the export will NOT fix (document, don't assume)

- Wire POST statuses: most POSTs return **201** by Nest default while Swagger annotates **200** (only login/confirm/cancel set `@HttpCode`). Trust `api-contract.md` + runtime probes, not the annotation.
- `POST /cart` declares `CartItem` in Swagger but the code returns `Cart`; `removeProduct` declares `Product` in GraphQL schema but returns `DeleteResult`.
- DTO-less routes (`POST /order/checkout`, `POST /order/:id/complete|cancel`) accept-and-ignore extra fields (no 400); Swagger may still show a body schema.
- `GET /order` / `GET /reservations` pagination edge inputs (`NaN`, negatives) are unguarded in code; any `openapi.json` constraints on them are aspirational until `BE-CHANGE-006` lands.
