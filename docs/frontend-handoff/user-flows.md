# User Flows

Conventions: `FLOW-*` IDs; each flow lists start, actions, transitions, APIs, states, recovery. Auth = JWT Bearer unless noted. Wire statuses are real (POST usually 201; login/confirm/cancel 200).

## FLOW-AUTH-001 Register → verify → login

- Start: logged out. Actions: `POST /auth/register` (API-REST-001) → 201 SafeUser → prompt verify (link email contains `GET /auth/verify-email?email=&token=`) → verify page calls GET (200) or manual-code POST (201) → login form `POST /auth/login` (200) → `GET /users/me` bootstrap.
- Loading: inline spinner on submit, disable form. Success: "Account created — check email" (register never blocks on email). Validation 400: inline per field. Duplicate: render backend string verbatim ("This email already exist."). 429: countdown from `Retry-After`.
- Recovery: resend link → `POST /auth/resend-verification` (60s cooldown → 429 `Retry-After:60` distinct from hourly 3600).

## FLOW-AUTH-002 Silent refresh + expired session

- Start: accessToken in memory, refresh in HttpOnly cookie (+ optional body copy). On 401 from any protected call (except refresh itself): single-flight `POST /auth/refresh {}` (cookie path) → 201 new pair → retry original once. Reuse/expired/unknown → 401 `'Invalid or expired refresh token'` → treat as theft-or-expiry: clear state, redirect `/login?expired=1`. Never loop refresh on 401-from-refresh.
- Concurrency: queue parallel 401s behind one refresh promise. After `reset-password` or `logout-all`, all tokens die (`tokenVersion++`) — force re-login, do not retry.

## FLOW-AUTH-003 Forgot → validate → reset

- `POST /auth/forgot-password` (always 200-shape, wire 201) → "If an account exists…" → reset page (link token) → optional `POST /auth/validate-reset-token` (`{valid:true}` vs 400; advisory only) → `POST /auth/reset-password` (newPassword 8..72, ≠ email) → success forces re-login (sessions killed). Second use of same token → 400. Never trust validate; reset is authority.

## FLOW-AUTH-004 Google OAuth (optional)

- Full-page `window.location = GET /auth/google` → Google → callback `GET /auth/google/callback` (link-out page, not fetch) → 200 `{accessToken, refreshToken}` → store + bootstrap → home. Errors: 400 unverified Google email; 409 double-link; 401 OAuth denial. `GET /auth/google/link` (logged-in link) → 200 `{message:'Google linked.'}`.

## FLOW-CAT-001 Browse → PDP

- Home (`/`) → catalog (`/products?page=&limit=`) via API-GQL-001 → PDP (`/products/:id`) via API-GQL-002 + parallel `GET /inventory/:productId` (or `/availability?quantity=`) for `UI-COMP-008` stock badge. Product 404/null → GraphQL error → not-found state. No stock on product — never render availability from product. Stale ≤60s acceptable; show "prices refresh at checkout".
- Search/sort: client-side over fetched pages only, labeled "searches loaded products". Empty: `EmptyState` + clear action. Pagination: page pager (no cursor); clamp limit client-side.

## FLOW-CART-001 Add → manage cart

- Requires login (guest → `/login?next=/cart`). PDP "Add" → `POST /cart {productId, quantity}` (201 `Cart`) → toast + badge. Cart page `GET /cart` → steppers `PATCH /cart/increase|decrease` (200 `CartItem`; decrease floor <1 → 400, use remove) → remove `DELETE /cart/:cartItemId`, clear `DELETE /cart` (confirm dialog) → totals are estimates (`Σ qty×price`, labeled).
- Failure: 409 over-available → show `available` count + clamp stepper; 404 product gone → remove line + notice; 429 → countdown; Admin 403 → "shopper account required".

## FLOW-ORD-001 Checkout → pay (simulation) → confirmation

1. Cart review → "Checkout" (disable while pending; generate `x-request-id` uuid) → `POST /order/checkout {}` → 201 `{id(PENDING), total(authoritative), reservationId, expiresAt, items(snapshot)}`. Empty cart → 400; 404 product/inventory gone → back to cart with removals; 409 insufficient → back to cart with availability; 429 → countdown.
2. `POST /payments/intent {orderId}` → 201 PENDING (or same row if retried) → confirm screen shows server `amount` (never client total).
3. `POST /payments/:id/confirm {result:'success'}` → 200 `{payment SUCCEEDED, order COMPLETED}` → confirmation page (`/orders/:id?paid=1`) with snapshot lines (`unitPrice`/`unit_price`, `subtotal`), reservation state, receipt link to `/payments/:id`. Declined variant: `{result:'declined', failureReason: card_declined|insufficient_funds|expired_card}` → 200 `{payment FAILED, order FAILED}` → "payment failed, hold released" + re-shop CTA (cart stays cleared).
4. Never auto-retry checkout/intent (non-idempotent). Re-confirm is safe (200 zero-delta). Duplicate-click guard: disable + idempotency via button state, not backend keys.

## FLOW-ORD-002 Cancel pending order

- Order details (PENDING) → "Cancel order" (confirm) → `POST /order/:id/cancel` → 200 `{status CANCELLED, reason:'user'}` → inventory hold released (verify via availability). Re-cancel → 200 zero-delta. COMPLETED → 409 (no refund — show "contact support"). Cancel is effectively unthrottled but still confirm-gated.

## FLOW-ORD-003 History → details → receipts

- `/orders` (`GET /order?page&limit&status`) → `/orders/:id` (`GET /order/:id`: items + `reservationId` + `expiresAt`; 403 non-owner; 404). `/payments` + `/payments/:id` (strict 400s; `totalPages=0` when empty). Validate page/limit client-side (backend order-list lacks NaN guard; payment-list 400s).

## FLOW-NOTIF-001 Notifications

- `/notifications`: `GET /notifications` (filters page/limit/isRead/channel/type) + `GET /notifications/unread-count` badge → `PATCH /notifications/:id/read` / `PATCH /notifications/read-all` (idempotent). Optional WS `notifications` namespace (`auth.token`, event `notification:new`) → badge bump only, then reconcile via history (ephemeral, no replay, `tokenVersion` gap). `notification:read` client event is echo-only — never treat as committed.

## FLOW-ERR-001 Global failures

- 401 (non-refresh): refresh-once → retry → else login redirect. 403: access-denied page (Admin-on-cart, non-owner order, shopper-on-reservation-write). 404: not-found page. 409: contention copy + recovery (cart/checkout/complete). 429:429 page state with `Retry-After` countdown, submit disabled. 5xx/offline: error page + retry (GETs only; mutations require explicit user re-submit). GraphQL errors: `extensions.code` mapped the same way.
