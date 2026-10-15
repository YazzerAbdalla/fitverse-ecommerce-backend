# Implementation Roadmap

Phases are dependency-ordered; each is independently verifiable. Do not skip ahead (e.g., no checkout UI before auth coordinator + contract tests are green).

## Phase 0 — Contract verification (0.5 day)
- **Objective:** prove the docs match the running backend. **Prereqs:** `docker-compose up -d`, backend `npm run start:dev`.
- **Tasks:** export `api/openapi.json` from `/api-json` (see `api/README.md`); diff `src/schema.gql` vs `api/schema.graphql`; probe: register→login→me→refresh→logout (statuses 201/200/201), `products/product` GraphQL, cart add→increase→decrease, checkout→intent→confirm→cancel on a throwaway user; record any drift in `open-questions.md`.
- **Done:** contract probes green; drift (if any) filed, not silently patched.

## Phase 1 — Foundation + tokens (1 day)
- **Objective:** app shell, routing, design tokens, env. **Deliverables:** Next.js/Vite scaffold, Tailwind + `:root` tokens from `design-system.md`, `REST_API_BASE_URL`/`GRAPHQL_ENDPOINT` env, AppShell/Header/Footer, 404/403/500/empty states, logger without PII.
- **Done:** `/`, `/products`, `/login` render with tokens at 4 breakpoints; no secrets in bundle.

## Phase 2 — Shared components (1 day)
- **Objective:** `UI-COMP-004..028` (buttons, fields, dialogs, toasts, skeletons, pager, cards, badges, pills). **Depends:** Phase 1.
- **Done:** Storybook-style showcase or page usage + component tests + a11y pass.

## Phase 3 — API clients + types (1 day)
- **Objective:** REST wrapper (`credentials:include`, Bearer, `x-request-id`, timeout 15s, error normalizer), Apollo client, hand-written `types/` from `frontend-data-models.md`, MSW contract tests for every `API-REST-*`/`API-GQL-*` used.
- **Done:** contract tests green (method/path/body/headers/statuses, 201-vs-200, dual `unitPrice`/`unit_price`, `totalPages=0` case).

## Phase 4 — Auth (1–2 days) — FR-AUTH-001..010
- **Tasks:** register/login/logout/verify/resend/forgot/validate/reset/me/prefs pages (`PAGE-LOGIN-001` etc.); in-memory accessToken store; **single-flight refresh coordinator**; `GET /auth/google` redirect + callback + link; 400/401/403/429 UX; `TEST-AUTH-001..007`.
- **Risks:** parallel refresh → theft-nuke (coordinator is load-bearing); `tokenVersion++` after reset/logout-all (force re-login, never retry refresh).
- **Done:** all auth E2E green incl. concurrent-401 single-refresh proof.

## Phase 5 — Catalog + PDP (1 day) — FR-CAT-001/002/005, FR-INV-001
- **Tasks:** home, catalog pager, PDP (GraphQL + parallel availability when logged in), client-side search/sort labeled as such, `StockBadge`, orphan-404 + guest-CTA states; `TEST-CAT-001/002`.
- **Done:** no stock rendered from product; stale ≤60s disclosed.

## Phase 6 — Cart (1 day) — FR-CART-001..005
- **Tasks:** `GET /cart`, add/increase/decrease/remove/clear with optimistic steppers + rollback, estimate totals (labeled), guest→login gate, Admin-403 notice; `TEST-CART-001..003`. **Depends:** Phase 4 (User JWT).
- **Done:** 409/404 recovery paths proven; clear confirms via dialog.

## Phase 7 — Checkout + orders + payments (2 days) — FR-ORD-001..006
- **Tasks:** checkout wizard (review → `checkout {}` → intent (server `amount` only) → confirm success/declined → confirmation; cancel-pending with confirm; orders/payments history+details+receipts; `x-request-id` per write; duplicate-submit locks; `TEST-ORD-001..005`.
- **Risks:** non-idempotent checkout/intent (never auto-retry); unthrottled cancel (still confirm-gate); NaN-page gap (client validation). Admin-fallback `complete` hidden from shoppers.
- **Done:** success + declined + cancel + idempotent re-click E2E green on real backend.

## Phase 8 — Account + notifications (1 day) — FR-AUTH-009, FR-NOTIF-001/002
- **Tasks:** profile/prefs, sessions (logout/logout-all), notification center (filters, unread badge, read/read-all), optional WS badge (`socket.io-client`, `notification:new` → reconcile via history); `TEST-NOTIF-001/002`.
- **Done:** WS never treated as committed; offline-missed → history correct; `tokenVersion` gap documented in UI copy.

## Phase 9 — Hardening + ship (1 day)
- **Tasks:** full Playwright E2E on seeded backend, `axe-core` + keyboard + SR spot checks, responsive 360→1440, 429/401/409/offline drills, bundle secret scan, docs cross-link check (`FR→FLOW→PAGE→API→TEST`), deploy preview with `FRONTEND_URL` allow-listed in backend CORS.
- **Done:** Definition of done per `testing-and-acceptance.md` met; `BE-CHANGE-*` items marked `BLOCKED`, never faked.

**Blockers (explicit):** no server search/filter/sort, images, guest cart, Stripe, refunds, cart totals, health endpoint — see `backend-change-requests.md`. MVP ships with zero backend changes.
