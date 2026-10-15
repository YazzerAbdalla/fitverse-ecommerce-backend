# Product Requirements — Customer Storefront MVP

## 1. Goals / non-goals

**Goals:** let a shopper discover products, manage a cart, check out, simulate payment, track orders, and manage account/notifications — entirely against implemented backend APIs. Demonstrate transactional correctness (no oversell, idempotent retries) with polished UX.

**Non-goals (V1):** admin UI, real money movement, guest shopping, server search/filter/sort, categories, images/variants, refunds, push/SMS, OTP login.

## 2. Personas (kept minimal)

- **Shopper (role `User`):** browses, carts, checks out, pays (simulation), tracks orders, manages prefs. Needs trust signals (availability, totals, order state) and clear recovery on 409/401/429.
- **Guest → registrant:** must register/login before cart (backend has no guest cart). Needs low-friction auth + verify + reset.
- **Admin (out of storefront):** uses dashboard/inventory/sales/outbox APIs elsewhere. Storefront must not link them; if an Admin opens the storefront cart, show "shopper account required" (403 is expected).

## 3. MVP scope (implementable today)

- Auth: register, login, refresh (silent), logout/logout-all, verify (link + code), resend, forgot/validate/reset, me, prefs. Google OAuth as redirect (optional but cheap). No OTP UI.
- Catalog: home, listing (page pager), details. Client-side search/sort over fetched pages, labeled as such. Availability fetched separately per PDP/cart line.
- Cart: get, add, increase/decrease, remove, clear. Estimated totals labeled as estimates.
- Checkout: `POST /order/checkout {}` → payment intent → confirm (`success`/`declined`) → confirmation. Cancel-pending. Order + payment history/details. Admin-fallback complete hidden from shoppers.
- Account: profile, prefs toggles, logout everywhere.
- Notifications: center (list/unread/read/read-all), optional WS badge with reconcile.
- States: loading/empty/error/expired/429/409/offline on every page.

## 4. MVP with backend changes (do NOT build now; see BE-CHANGE-*)

- `BE-CHANGE-001` server product search/filter/sort; `BE-CHANGE-002` images/categories/variants; `BE-CHANGE-003` guest cart; `BE-CHANGE-004` Stripe; `BE-CHANGE-005` refunds/post-sale cancel; `BE-CHANGE-006` strict pagination guards (NaN clamp); `BE-CHANGE-007` cart totals endpoint; `BE-CHANGE-008` health endpoint.

## 5. Future enhancements

Cursor pagination, wishlist, reviews, coupons, multi-address, shipment tracking, per-route notification prefs, i18n, PWA offline cart.

## 6. Functional requirements (traceable)

- FR-AUTH-001..010 (see matrix): register/login/refresh/logout/verify/reset/Google/me/prefs/roles.
- FR-CAT-001/002/005: list/details/price. FR-CAT-003/004 explicitly out of MVP-server scope.
- FR-INV-001/004/005: availability + reservation reads + contention UX. FR-INV-002/003 admin/blocked — never called.
- FR-CART-001..005: full cart minus guest.
- FR-ORD-001..006: checkout/payment/cancel/history. FR-ORD-007 out.
- FR-NOTIF-001/002: history center + optional WS badge.
- FR-X-001..005: validation/errors/429/cache/CORS honored everywhere.

## 7. NFRs

- Performance: PDP < 2s (product + availability parallel); list pagination instant with skeletons; ≤60s catalog staleness disclosed.
- Reliability: no duplicate charges/submits (idempotency keys off, but backend re-confirm/re-cancel 200-safe); single-flight refresh; retries only for idempotent GETs and re-confirm/re-cancel; never auto-retry checkout/intent.
- Security: accessToken in memory only; refresh via HttpOnly cookie + body fallback; `credentials:include`; no secrets in bundle; SafeUser only in storage.
- Accessibility: WCAG 2.2 AA (labels, focus, contrast, announcements, reduced-motion) — see `frontend-architecture.md` + `testing-and-acceptance.md`.
- Responsive: 360px → 1440px, touch targets ≥44px, layouts per `design-system.md`.
- Observability: log `correlationId` per mutation; surface `Retry-After`; never log tokens.
