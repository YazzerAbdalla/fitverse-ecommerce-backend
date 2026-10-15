# Frontend Handoff Package — Mini E-Commerce Storefront

**Backend inspected:** `D:\Job\Projects\mini-e-commerce` (`master`, NestJS 11 modular monolith).
**Date:** 2026-10-10. **Scope:** handoff documentation only — no frontend or backend code was changed.
**No frontend repository exists** in this workspace (no `frontend/`, `apps/web`, or `client/` directory was found). All frontend guidance below is proposed; all backend behavior is evidence-cited.

## What this package is

A complete, traceable specification for building a **separate customer storefront** against the real backend. Another AI agent should be able to implement the frontend from these files without re-asking product questions or inventing API behavior.

## Reading order

1. `backend-capability-audit.md` — what the backend actually does (evidence + status per feature).
2. `feature-matrix.md` — status/dependency/API/implication table with IDs (`FR-*`, `API-*`).
3. `product-requirements.md` — MVP scope (what can ship with today's backend), personas, FR/NFRs.
4. `api-contract.md` — exact REST + GraphQL contracts with examples.
5. `authentication-and-session.md` — token lifecycle, refresh coordination, protected routes.
6. `frontend-data-models.md` — frontend types, enums, nullability, derived data.
7. `user-flows.md` + `page-specifications.md` — journeys and per-route specs.
8. `design-system.md` + `component-inventory.md` — visual tokens and components (`UI-COMP-*`).
9. `frontend-architecture.md` — stack recommendation, clients, state, env, security rules.
10. `backend-change-requests.md` — proposed APIs only (`BE-CHANGE-*`, never to be mistaken for existing endpoints).
11. `testing-and-acceptance.md` — strategy + per-feature criteria (`TEST-*`).
12. `implementation-roadmap.md` — ordered phases with tasks and done-definitions.
13. `open-questions.md` — everything UNVERIFIED or needing a human decision.
14. `api/schema.graphql` — verbatim copy of the backend-generated `src/schema.gql` (verified). `api/README.md` explains why no checked-in `openapi.json` exists and how to export one.

## Traceability

- `FR-AUTH-001` functional requirements → `product-requirements.md`
- `FLOW-*` user journeys → `user-flows.md`
- `PAGE-*` pages/routes → `page-specifications.md`
- `API-REST-*` / `API-GQL-*` operations → `api-contract.md` (+ `feature-matrix.md`)
- `UI-COMP-*` components → `component-inventory.md`
- `TEST-*` acceptance → `testing-and-acceptance.md`
- `BE-CHANGE-*` proposals → `backend-change-requests.md` (always labeled `PROPOSED — BACKEND CHANGE REQUIRED`)

## Key facts up front

- **Products are GraphQL (public, unauthenticated):** `Query.products(page,limit)`, `Query.product(id)`; mutations exist but are admin-oriented and unguarded by auth — the storefront must NOT expose them. No search/filter/sort, no categories, no images, no variants exist. See `API-GQL-001/002`.
- **Cart/orders/payments/notifications are REST + JWT Bearer.** Refresh tokens travel by **body `refreshToken` OR cookie** (`refresh_token`, `HttpOnly`, `SameSite=Strict`, `Path=/auth`); access tokens travel by **`Authorization: Bearer`** only. See `authentication-and-session.md`.
- **Checkout is cart-only:** `POST /order/checkout {}` → `POST /payments/intent {orderId}` → `POST /payments/:id/confirm {result}`. No guest checkout, no Stripe — payment is an in-repo **simulation** (`success`/`declined`). Direct `POST /order/:id/complete` is the admin fallback, not the shopper path.
- **Shopper reservation APIs are intentionally blocked:** `POST /reservations` and `PATCH /reservations/:id/{complete,cancel}` return deterministic `403` for role `User`. Reservation state is read via `GET /order/:id` (`reservationId`, `expiresAt`) or `GET /reservations/:id`.
- **Error envelopes differ:** REST → `{statusCode, message, timestamp}` (`AllExceptionsFilter`); GraphQL → `GraphQLError` with `extensions.code`. POST success is usually **201** (Nest default; only login/confirm/cancel force 200). Extra JSON fields on DTO-less routes (checkout/complete/cancel) are **ignored, not 400**.
- **Biggest risks:** (1) no product search/filter/sort or images — catalog UX is constrained; (2) cart is `User`-role-only (Admin gets 403); (3) success/error status nuance (201 vs annotated 200); (4) WS notifications are ephemeral with a known `tokenVersion` gap — always reconcile with `GET /notifications`.

## Assumptions

- Backend base URL is configurable (`REST_API_BASE_URL`, `GRAPHQL_ENDPOINT`); defaults `http://localhost:3000`, GraphQL `http://localhost:3000/graphql`, Swagger UI `http://localhost:3000/api`.
- Frontend is a separate repo/app (recommended: Next.js or Vite React SPA + Apollo Client + TanStack Query; decision in `frontend-architecture.md`).
- No secrets in browser code. Only `NEXT_PUBLIC_*`-style public env is exposed.
