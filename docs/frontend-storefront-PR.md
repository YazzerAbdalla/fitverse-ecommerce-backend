# PR — Customer Storefront Frontend (React + Redux Toolkit + TanStack Query)

Standalone build doc. Implements the MVP customer storefront against the current NestJS backend (`master`, modular monolith) with zero backend changes.
Source of truth for backend behavior: `docs/frontend-handoff/` (`api-contract.md`, `feature-matrix.md`, `page-specifications.md`, `user-flows.md`, `authentication-and-session.md`, `frontend-data-models.md`, `component-inventory.md`, `design-system.md`, `testing-and-acceptance.md`, `implementation-roadmap.md`, `backend-capability-audit.md`, `open-questions.md`).

## 1. Goal / non-goals

Goal: shopper can register → verify → login → browse products → cart → checkout → simulated pay → track orders/payments → manage account/notifications, against real backend.
Non-goals (V1): admin UI, real money (Stripe), guest cart, server search/filter/sort, categories/images/variants, refunds, OTP, push/SMS, `/health`.

## 2. Stack (imposed)

- **App:** Vite React SPA + TypeScript strict. No SSR (all customer data is per-user; Bearer handling simpler).
- **Client state:** Redux Toolkit (`auth` slice: accessToken in memory + SafeUser + session status; `ui` slice: toasts/dialogs/pager/search-box). No persistence of tokens (no `localStorage` for refresh).
- **Server state:** TanStack Query v5 (all REST + GraphQL reads; mutations via `useMutation` + invalidation). No Apollo — GraphQL `products/product` fetched via `graphql-request` inside Query fetchers (one cache, one retry policy).
- **Forms:** React Hook Form + Zod (schemas mirror DTO rules).
- **Styling:** Tailwind + CSS vars from `design-system.md`. Router: `react-router-dom`. Realtime (optional): `socket.io-client` badge-only.
- **Env (public only):** `VITE_REST_API_BASE_URL` (default `http://localhost:3000`), `VITE_GRAPHQL_ENDPOINT` (`…/graphql`). Never ship `JWT_SECRET/GOOGLE_*/SMTP_*/POSTGRES_*/RABBITMQ_*/REDIS_*`.

State split rule: Redux = auth session + UI drafts; Query = everything server-owned; derived display-only (cart estimates, `subtotal` fallback, pills) computed in selectors/components, never sent back.

## 3. Features to integrate (MVP, all IMPLEMENTED backend)

| Domain | FR IDs | What frontend does |
|---|---|---|
| Auth/session | FR-AUTH-001..007,009,010 | register, login (200), silent refresh single-flight (`POST /auth/refresh {}` cookie path, 201), logout (always 201) / logout-all, verify link (GET 200) + code (POST 201), resend (60s vs 360s 429), forgot → validate (advisory) → reset (authority, kills sessions), Google redirect (`window.location`, not fetch), `GET /users/me` bootstrap, prefs toggles. No OTP UI (501). Admin routes never linked; Admin-on-cart 403 → "shopper account required". |
| Catalog | FR-CAT-001/002/005 | list pager `products(page,limit)` (no max server-side; client clamp 1..50), details `product(id)`, integer price + presentational currency. Client-side search/sort over loaded pages only, labeled "searches loaded products". Never render stock from Product. |
| Inventory | FR-INV-001/004/005 | PDP/cart guard via `GET /inventory/:productId` / `/availability?quantity=` (auth required; 404 = orphan/unavailable; 401 guest = sign-in CTA). Reservation state via order reads (`reservationId/expiresAt`) or `GET /reservations/:id`. Never call reservation writes (deterministic shopper 403). 409 = normal contention. |
| Cart | FR-CART-001..005 | get (auto-create), add (append-or-increment, 201 `Cart`), increase/decrease steppers (200 `CartItem`; decrease-to-0 → remove, backend 400s otherwise), remove/clear (confirm dialog). Totals = frontend estimate `Σ qty×price` labeled "Estimate — final total at checkout"; `Order.total` is authority. Login gate (`/login?next=`). |
| Checkout/orders/payments | FR-ORD-001..006 | `POST /order/checkout {}` (no DTO — extras ignored, 201 PENDING + snapshot items with dual `unitPrice`/`unit_price`) → `POST /payments/intent {orderId}` (201, idempotent PENDING) → confirm screen shows server `amount` only → `POST /payments/:id/confirm {success\|declined+reason}` (200; success → SUCCEEDED+COMPLETED, declined → FAILED hold released). Cancel-pending (`POST /order/:id/cancel`, confirm-gated, re-cancel 200). History/details/receipts lists. Admin-fallback `complete` hidden from shoppers. Never auto-retry checkout/intent; re-confirm/re-cancel safe to re-click. `x-request-id: crypto.randomUUID()` on writes. |
| Notifications | FR-NOTIF-001/002 | center (filters `isRead/channel/type` + pager), unread-count badge, read/read-all idempotent. Optional WS `notifications` namespace badge hint → always reconcile via `GET /notifications` (ephemeral, no replay, `tokenVersion` gap). |
| Cross-cutting | FR-X-001..005 | DTO routes 400 on extras vs DTO-less routes ignore extras; REST `{statusCode,message,timestamp}` vs GraphQL `extensions.code`; 429 `Retry-After` countdown + disabled submit; catalog stale ≤60s disclosed; availability `staleTime 0`; `credentials:'include'` + `Bearer` on all protected REST; 15s REST timeout; retries GET-only (2× backoff, never 4xx, never checkout/intent). |

## 4. Pages required (routes proposed, all need loading/empty/error/expired/429/409/offline states)

| Page | Route | Access | APIs |
|---|---|---|---|
| Home | `/` | public | GQL products(1,8) |
| Catalog | `/products?page=&limit=` | public | GQL products; client search/sort labeled |
| PDP | `/products/:id` | public (availability gated) | GQL product + `GET /inventory/:productId` ∥ `/availability` when authed; guest → sign-in CTA |
| Login | `/login` | guest-only | `POST /auth/login`, then `GET /users/me` |
| Register | `/register` | guest-only | `POST /auth/register` (no auto-login; → verify prompt) |
| Verify | `/verify-email?email=&token=` | public | GET verify (link) / POST verify (code) + resend |
| Forgot / Reset | `/forgot-password`, `/reset-password?email=&token=` | public | forgot → validate (advisory) → reset (forces re-login) |
| Cart | `/cart` | auth(User) | `GET /cart`, add/inc/dec/remove/clear; optimistic steppers + rollback |
| Checkout | `/checkout` | auth | checkout → intent → confirm wizard |
| Order confirmation | `/orders/:id?paid=1` | auth | `GET /order/:id` (+ payment read); cancel-when-PENDING |
| Orders | `/orders` | auth | `GET /order?page&limit&status` (client NaN-guard) |
| Payments + receipt | `/payments`, `/payments/:id` | auth | `GET /payments…` (strict 400s; `totalPages=0` when empty), `GET /payments/:id` |
| Account | `/account` | auth | `GET /users/me`, `PATCH /users/me/preferences`, logout/logout-all, Google link |
| Notifications | `/notifications` | auth | history + unread-count + read/read-all (+ optional WS badge) |
| Shared | `*`, `/403`, `/login?expired=1`, `/500`, `/maintenance` | — | not-found, access-denied (verbatim 403 copy + role guidance), session-expired banner, global error (GET-retry only), maintenance static |

Components: reuse `UI-COMP-001..028` only (AppShell, nav, SearchBar, ProductCard/Gallery, StockBadge from inventory only, PriceDisplay, QuantitySelector, CartLine/Summary, status pills, Skeleton, Pagination, FilterBar, fields, buttons, dialogs, toasts-success/info-only, inline Alert, EmptyState, FieldError). No page-local button/input/badge duplicates.

## 5. API contract check — is `api-contract.md` missing anything?

Verified against `src/*controller.ts` route decorators. Contract is accurate for all shopper paths, but has gaps:

1. **Missing: `GET /admin/products`, `POST /admin/products`, `PATCH /admin/products/:id/stock`** (`admin-products.controller.ts:62,85,135`, `@Auth(Admin)`). Not in `api-contract.md` at all (only inventory admin writes 032/033 are listed). Impact: none for shopper MVP (must stay unlinked), but contract claims to cover "admin/…" surface for the openapi export (`api/README.md:16` lists `admin/products`) and doesn't. Fix: add API-REST-055/056/057 as ADMIN-ONLY or explicitly mark out-of-scope.
2. **Missing trivial: `GET /`** (`app.controller.ts:8` hello). Useful as documented liveness fallback alongside `/api` (BE-CHANGE-008 proposes `/health`). One line.
3. **Under-specified (already flagged in `open-questions.md`, still true):** WS `notifications` full URL/transports; `GET /auth/google/callback` denial flow; `GET /order` empty-list `totalPages` (payments yields 0, orders unverified); live email latency. These are correctly marked UNVERIFIED — no fix needed, but Phase 0 probes must record them.
4. **Already documented, keep:** `POST /cart` returns `Cart` (code) vs Swagger `CartItem`; `removeProduct` returns `DeleteResult` vs schema `Product`; DTO-less routes ignore extras; order/reservation list NaN-guard gap (BE-CHANGE-006); cancel unthrottled (guard without key). These live in `api/README.md:18-23` — correct, just ensure the new frontend's MSW tests encode them (201-vs-200, extras-ignored, `totalPages=0`, dual price fields).
5. **No other missing shopper endpoint.** Auth (001-016), users/me+prefs (017/018), cart (020-025), order checkout/complete/cancel/list/get (026/027,035-039), payments intent/confirm/cancel/list/get (028/029,034,045/046), inventory reads (030/031), reservation reads (043/044) + blocked writes (040-042), notifications history/unread/read (047-050), admin sales/test-email/outbox (051-054) all match code prefixes (`auth`, `users`, `cart`, `order` singular, `payments` plural, `inventory`, `reservations`, prefix-less notifications).

## 6. Frontend architecture (React + Redux + Query)

```
frontend/
  src/
    app/{store.ts, router.tsx, queryClient.ts}
    lib/{rest-client.ts, graphql-client.ts, refresh-coordinator.ts, error-normalize.ts, query-keys.ts}
    slices/{authSlice.ts, uiSlice.ts}
    features/{auth,catalog,cart,checkout,orders,payments,account,notifications}/{api.ts, hooks.ts, components/}
    components/ui/   # UI-COMP-* only
    types/           # from frontend-data-models.md (SafeUser, Product, InventoryView, Cart, Order/CheckoutItem, Payment, Reservation, Notification)
```

- `rest-client`: `fetch` + `credentials:'include'`, `Authorization: Bearer <token from Redux memory>`, 15s timeout, error normalize `{status, message, retryAfter?}`, `x-request-id` on checkout/payment writes.
- `refresh-coordinator`: single-flight `POST /auth/refresh {}`; 401 (non-refresh call) → refresh-once → retry once → else `clearAuth + redirect /login?expired=1`; queue concurrent 401s; refresh-401 → logout, never loop. After reset/logout-all → straight to login.
- Query keys include all args; `products staleTime 30s`, availability `0`, cart/orders/payments invalidate on mutation (checkout → cart+orders; confirm → orders+payments; read → notifications+unread). Optimistic only for cart steppers + notification reads (rollback on 409/404/403). Logout clears token + Query cache + WS.
- Guards: `RequireAuth` (any JWT), `RequireShopper` (role User; Admin → 403 notice), `GuestOnly`.

## 7. Tasks (build order — each independently verifiable)

- [ ] T1 Contract probe (0.5d): boot backend, export `/api-json`, diff `schema.gql`, probe register→login→me→refresh→logout, products/product, cart round-trip, checkout→intent→confirm→cancel on throwaway user; record drift. Done: probes green or drift filed.
- [ ] T2 Scaffold + shell (1d): Vite React TS + Redux Toolkit + Query + Router + Hook Form + Zod + Tailwind tokens, env, AppShell/header/footer, 404/403/500/empty states, PII-free logger. Done: `/`, `/products`, `/login` render at 360/768/1024/1440, no secrets in bundle.
- [ ] T3 UI kit (1d): UI-COMP-004..028 + showcase + Testing Library + axe pass. Done: states/a11y/responsive green.
- [ ] T4 Clients + types (1d): rest/graphql clients, refresh coordinator, hand-written `types/`, MSW contract tests per API ID (201-vs-200, extras-ignored, dual price, `totalPages=0`, NaN-guard). Done: contract tests green.
- [ ] T5 Auth pages (1–2d): login/register/verify/forgot/reset/account, Google redirect+callback+link, 400/401/403/429 UX. Done: TEST-AUTH-001..007 incl. single-refresh proof.
- [ ] T6 Catalog + PDP (1d): home, pager, PDP + parallel availability, labeled client search/sort, StockBadge, orphan/guest states. Done: TEST-CAT-001/002, no stock from product.
- [ ] T7 Cart (1d): full CRUD + optimistic steppers + estimates + gates. Done: TEST-CART-001..003.
- [ ] T8 Checkout/orders/payments (2d): wizard + cancel + history/receipts + locks. Done: TEST-ORD-001..005 on real backend.
- [ ] T9 Notifications + account sessions (1d): center + badge + WS-hint reconcile; logout/logout-all. Done: TEST-NOTIF-001/002, WS never trusted.
- [ ] T10 Hardening + ship (1d): Playwright E2E seeded, 429/401/409/offline drills, secret scan, CORS `FRONTEND_URL` allow-list, ID cross-link check. Done: definition-of-done in `testing-and-acceptance.md`; BE-CHANGE-* marked BLOCKED.

Acceptance per feature: `TEST-*` in `testing-and-acceptance.md` (auth 001-007, cat 001/002, cart 001-003, ord 001-005, notif 001/002, X 001-004) + edge list (expired-mid-session, deleted-product, over-available, offline-mid-submit, double-click, guest-gate, bad-id, refresh-details, empty-payments, admin-on-cart).
