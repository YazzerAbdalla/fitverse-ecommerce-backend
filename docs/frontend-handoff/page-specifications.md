# Page Specifications

Route conventions: proposed paths below. Access: `public` | `auth(User)` (any JWT; cart additionally requires role `User` — Admin 403) | `guest-only` (redirect if logged in). Every page lists APIs (`API-*`), states, acceptance.

## Public storefront

### PAGE-HOME-001 `/` (public)
Purpose: entry, trust, discovery. Layout: header/nav, hero, featured products (first page of API-GQL-001), value props, footer. Data: `products(page:1, limit:8)` + no auth. States: skeleton grid → cards; GraphQL error → alert + retry; empty → EmptyState. A11y: landmarks, skip link. Acceptance: loads without auth; no stock rendered from product.

### PAGE-CATALOG-001 `/products?page=&limit=` (public)
Intent: browse. Structure: toolbar (client-side search input + sort select, labeled "searches loaded products"), grid `UI-COMP-006`, pager `UI-COMP-016`. APIs: API-GQL-001 only. Validation: clamp `page≥1`, `limit 1..50` client-side (backend has no max). Responsive: 2 cols mobile → 3 tablet → 4 desktop. Acceptance: page change refetches; stale ≤60s acceptable; error maps `extensions.code`.

### PAGE-PDP-001 `/products/:id` (public)
Intent: decide. Layout: gallery (placeholder art), title/price/description, `UI-COMP-008` availability (separate auth-required fetch — guest sees "sign in for availability" CTA), quantity selector + Add-to-cart (guest → login redirect with `next=`). APIs: API-GQL-002 + API-REST-030/031 (parallel when logged in). States: product-null → 404 page; inventory 404 → "unavailable / orphan" badge; 401 on inventory → sign-in prompt (not error). Acceptance: never derives stock from product; price labeled "refreshes at checkout".

### PAGE-LOGIN-001 `/login` (guest-only) — FR-AUTH-002
Fields: email, password (+ show/hide). Client validation mirrors DTO (email format, required). API API-REST-002 (200). Errors: 400 inline per field; 401 "invalid credentials"; 429 countdown. Success: store accessToken (memory), bootstrap `GET /users/me`, redirect `next=` or `/`. Acceptance: malformed → 400 path tested; concurrent submit disabled.

### PAGE-REGISTER-001 `/register` (guest-only) — FR-AUTH-001
Fields: firstName (≤30), lastName (≤30), email, password (≥8), optional prefs checkboxes. API API-REST-001 (201). Errors: 400 verbatim (incl. dup string); 409 race; 429 countdown. Success: "check email" + link to verify/resend; auto-login is NOT performed (backend returns SafeUser only). Acceptance: no auto-redirect to cart.

### PAGE-VERIFY-001 `/verify-email?email=&token=` (public) — FR-AUTH-005
Modes: link mode auto-calls API-REST-006 (200); code mode form posts API-REST-007 (201). Resend section posts API-REST-008 with cooldown UX (60s button timer vs hourly countdown). States: 400 "invalid/expired" + resend CTA; already-verified message distinct. Acceptance: both transports tested.

### PAGE-FORGOT-001 `/forgot-password` + PAGE-RESET-001 `/reset-password?email=&token=` (public) — FR-AUTH-006
Forgot: email form → API-REST-009 (always success copy, wire 201). Reset: token (prefilled from query) + newPassword (8..72, ≠ email) → optional validate call (advisory) → API-REST-011. Success forces re-login (sessions killed). Errors: second-use 400; validation inline. Acceptance: validate never gates submit.

### PAGE-CART-001 `/cart` (auth(User)) — FR-CART-001..004
Data: API-REST-020 on mount; mutations 021-025 with optimistic steppers + rollback on 409/404. Layout: lines (`UI-COMP-011`) + summary (`UI-COMP-012`, estimates labeled) + checkout CTA (disabled when empty/pending). States: empty cart art + "browse" CTA; 403 → shopper-account notice; 429 → countdown. Acceptance: decrease-to-0 uses remove; clear confirms; totals never sent to backend.

## Authenticated customer area

### PAGE-CHECKOUT-001 `/checkout` (auth) — FR-ORD-001/002
Prereq: non-empty cart. Steps: review (estimates) → `POST /order/checkout {}` (201 PENDING) → intent (201) → confirm screen (server `amount` only) → `confirm {success|declined}`. Idempotency: disable buttons while pending; `x-request-id` sent. Failure branches: 400 empty → cart; 404 → cart with removals; 409 → cart with availability; 429 → countdown; network → explicit re-submit (never auto-retry). Acceptance: declined path shows FAILED + re-shop CTA; re-confirm safe.

### PAGE-ORDER-CONFIRM-001 `/orders/:id?paid=1` (auth) — FR-ORD-004/005
Data: API-REST-039 (+ payment read for receipt). Content: status pill, snapshot lines (both `unitPrice`/`unit_price` supported, `subtotal` fallback), `reservationId`/`expiresAt`, cancel button when PENDING (confirm dialog → API-REST-037). States: 403 non-owner → denied page; 404 → not-found. Acceptance: COMPLETED cancel attempt shows 409 copy.

### PAGE-ORDERS-001 `/orders` (auth) — FR-ORD-005
List via API-REST-038 with status filter + pager. Client-validates page/limit (backend NaN gap). Empty → EmptyState. Item links to details.

### PAGE-PAYMENTS-001 `/payments` + `/payments/:id` (auth) — FR-ORD-006
Strict backend validation: bad page/limit/status → 400 (show inline error, unlike orders). `totalPages=0` when empty (handle explicitly). Receipt shows `amount/currency/provider/status`.

### PAGE-PROFILE-001 `/account` (auth) — FR-AUTH-009
Data: `GET /users/me` (SafeUser only). Prefs toggles → `PATCH /users/me/preferences` (either-or; neither → 400). Sessions section: logout (always succeeds) + logout-all (kills all, redirect login). Google link button (redirect). Acceptance: no token/hash ever rendered.

### PAGE-NOTIF-001 `/notifications` (auth) — FR-NOTIF-001/002
Data: API-REST-047 + unread-count badge; filters channel/type/read; read/read-all mutations (idempotent). Optional WS badge (reconcile on `notification:new`). Acceptance: `notification:read` WS event never treated as committed.

## Shared / exceptional

| Page | Route | Behavior |
|---|---|---|
| Not found | `*` | 404 art + home/catalog links. Product-null and order-404 route here. |
| Access denied | `/403` | 403 copy verbatim + role guidance (Admin-on-cart, non-owner, reservation-write blocks). |
| Session expired | `/login?expired=1` | Banner "session expired — sign in again"; refresh already attempted once. |
| Global error | `/500` + inline alerts | 5xx/offline: retry GETs only; mutations need explicit re-submit. Never auto-retry checkout/intent. |
| Maintenance | `/maintenance` | Static; triggered by repeated 5xx/offline or feature flag. |
| Empty cart | `/cart` empty state | Art + browse CTA; checkout CTA hidden. |
| Empty catalog/search | catalog empty state | Clear-filters action. |
| Out-of-stock | PDP/cart inline | Badge + clamp stepper + "notify" is out of scope (no such API). |
| Failed checkout | checkout inline | 409/404 branches back to cart (see FLOW-ORD-001); never a dead-end. |

All MVP pages require loading/empty/success/failure states; forms require inline validation + `aria-describedby`; mutations require duplicate-submit guards.
