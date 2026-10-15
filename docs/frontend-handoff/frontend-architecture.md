# Frontend Architecture & Integration Strategy

No frontend exists — this is a greenfield recommendation constrained to what the backend needs. Do not add libraries beyond this list without a written reason.

## Stack (recommended default)

- **App:** Next.js (App Router) **or** Vite React SPA — either is fine; pick one and keep SSR off for authenticated routes (all customer data is per-user; SSR buys little and complicates Bearer handling). Language TypeScript strict.
- **GraphQL:** Apollo Client (queries `products/product` only; no subscriptions, no mutations in storefront).
- **Server state:** TanStack Query (caching, dedup, retries for GETs only, pager keys `['products', page, limit]` / `['cart']` / `['orders', …]`).
- **Forms:** React Hook Form + Zod (schemas mirror DTO rules: email format, min 8 password, 64hex tokens, quantity int≥1). Client validation is UX-only; backend decides.
- **Styling:** Tailwind + CSS variables from `design-system.md` (no UI kit required; headless primitives only if needed for Dialog/focus-trap).
- **Realtime:** `socket.io-client` for WS `notifications` namespace only (badge hint; never a data source).

## Structure

```
src/
  app/(routes per PAGE-*)  pages compose features, no data logic in routes
  features/{auth,catalog,cart,checkout,orders,payments,account,notifications}/
    api.ts        # thin fetchers, one per API-REST/GQL ID
    hooks.ts      # TanStack Query wrappers (GETs cached; mutations invalidate)
    components/   # feature-local, page-PAGE-* specific
  components/ui/  # UI-COMP-* only
  lib/{rest-client,graphql-client,auth-store,refresh-coordinator,error-normalize,query-keys}.ts
  types/          # frontend-data-models.md (generated-by-hand, checked against contract)
```

## API integration rules

- **Base URLs (env, public only):** `REST_API_BASE_URL` (default `http://localhost:3000`), `GRAPHQL_ENDPOINT` (default `…/graphql`). Never add secrets; backend `.env.example` secrets (`JWT_SECRET, GOOGLE_*, SMTP_*, RESEND_*, POSTGRES_*, RABBITMQ_*, REDIS_*`) must never appear in frontend env.
- **REST:** `fetch` wrapper with `credentials:'include'`, `Authorization: Bearer <accessToken>` (from in-memory store), `Content-Type: application/json`, optional `x-request-id: crypto.randomUUID()` on checkout/payment writes. Normalize errors to `{status, message (string|object — preserve nested validation body), retryAfter?}` reading `statusCode/message` envelope + `Retry-After`/`X-RateLimit-*` headers.
- **GraphQL:** Apollo `HttpLink GRAPHQL_ENDPOINT` (no auth link for reads); map `errors[0].extensions.code` to status; treat `product:null` + errors as 404. Do not attach Bearer to product queries.
- **Timeouts/retries/cancellation:** 15s timeout on REST; retry GETs only (2×, backoff, no retry on 4xx); never auto-retry `checkout/intent` (non-idempotent); re-confirm/re-cancel are safe to re-click (backend 200 zero-delta). Abort in-flight GET on unmount/param change.
- **Cache:** Query keys include all args (`page,limit,status` for orders; `page,limit,isRead,channel,type` for notifications). Products: `staleTime 30s` (backend TTL 60s); availability: `staleTime 0` (never cached beyond view); cart/orders/payments: invalidate on mutation (`checkout → invalidate cart+orders`; `confirm → orders+payments`; `read → notifications+unread`).
- **Pagination:** render `meta` pager verbatim; client-clamp `page≥1, limit 1..50` (catalog) / `1..100` (admin never used); handle payment `totalPages=0`-when-empty explicitly; never request page 0.
- **Optimistic updates:** allowed only for cart steppers (rollback on 409/404) and notification reads (rollback on 403/404). Never optimistic for checkout/intent/confirm/cancel.
- **Refresh coordination:** `lib/refresh-coordinator.ts` — single-flight `POST /auth/refresh {}` (see `authentication-and-session.md`); 401 (non-refresh call) → refresh-once → retry once → else `clearAuth + redirect /login?expired=1`. Exclude the refresh call itself from this loop. Queue concurrent 401s behind the one promise.
- **Logout/cache clearing:** logout/logout-all → clear accessToken + TanStack cache + WS disconnect + redirect; cookie drop is client-side (server never clears it).
- **Types:** hand-write `types/` from `frontend-data-models.md`; assert both `unitPrice` and `unit_price` on order items; fallback `subtotal ?? qty*price`.

## Data ownership

Server-owned (never invented client-side): Product, InventoryView, Cart, Order/total, Payment, Reservation, Notifications. Client-owned: form drafts, dialogs, `x-request-id`, pager/search-box state, toasts. Derived display-only: cart estimates, `subtotal` fallback, status pills. Cached: product pages ≤60s, single ≤300s, nothing else.

## Security / reliability / a11y checklists (summary; details in testing doc)

- Security: accessToken memory-only; refresh via HttpOnly cookie + optional body copy; `credentials:include`; SafeUser-only persistence; verbatim-but-safe error copy (no token/PII in logs or toasts); untrusted product strings rendered as text (no `dangerouslySetInnerHTML`); no localStorage for refresh without a new threat review; Google via full-page redirect.
- Reliability: offline banner + GET-only retry; 429 countdown + disabled submit; 409 contention recovery (cart/checkout/complete); duplicate-submit locks on all mutations; WS treated as hint (reconcile via history; `tokenVersion` gap documented).
- Accessibility: semantic landmarks, skip link, labeled inputs + `aria-describedby` errors, visible focus, `role=status/alert` announcements, contrast AA, dialog focus-trap + Esc + return-focus, `prefers-reduced-motion` respected, keyboard-operable nav/pager/steppers.
