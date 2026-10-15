# Testing & Acceptance (`TEST-*`)

## Strategy

- **Unit (Vitest/Jest):** pure logic — cart-estimate math, `available` derivation display, pager math, Zod schemas mirroring DTOs, error-normalizer (REST envelope vs GraphQL `extensions.code`), refresh-coordinator single-flight (mock `fetch`).
- **Component (Testing Library):** each `UI-COMP-*` — states (loading/empty/error/disabled), a11y (label association, focus, `aria-describedby`, dialog trap, contrast), responsive snapshots at 360/768/1024/1440 (visual, not pixel-perfect).
- **API client (MSW against contract):** one test per `API-REST-*`/`API-GQL-*` used — assert method/path/body/headers (`Bearer`, `credentials:include`, `x-request-id`), wire status handling (201 vs 200), DTO-extra → 400 mapping, NaN-page client guard, `unitPrice`/`unit_price` dual render.
- **E2E (Playwright, against real backend + seeded DB):** happy paths below + edge cases; separate `admin` user for 403-negative tests. Never hit admin/product-mutation/notification-admin/outbox endpoints from shopper E2E except to assert they 403/404-hide.
- **A11y audits:** `axe-core` per page + keyboard-only pass + screen-reader spot check (NVDA/VoiceOver) on auth/cart/checkout/notifications. **Responsive:** real-device widths, touch ≥44px, no horizontal scroll.

## Acceptance per feature (traceable)

- `TEST-AUTH-001` register→verify→login→me: 201 SafeUser (no password/hash keys) → verify GET 200 → login 200 → me matches. `TEST-AUTH-002` dup register 400 verbatim; race 409 tolerated. `TEST-AUTH-003` refresh: `{}` cookie path 201; reuse old → 401 + all sessions dead → login redirect. `TEST-AUTH-004` concurrent 401s → exactly one refresh request (coordinator). `TEST-AUTH-005` logout always 201; logout-all kills old access (401 on next read). `TEST-AUTH-006` reset: forgot 201-shape → validate advisory → reset 201 → old sessions dead; reuse token 400. `TEST-AUTH-007` Google: redirect (not fetch); callback stores pair; unverified → 400; double-link → 409.
- `TEST-CAT-001` list pager renders `meta` verbatim; page change refetches; stale ≤60s disclosed. `TEST-CAT-002` PDP: GraphQL + availability parallel; orphan inventory 404 → "unavailable" badge (not crash); guest sees sign-in CTA (no silent 401).
- `TEST-CART-001` add→increase→decrease→remove→clear round-trip; decrease-to-0 → 400 → UI routes to remove. `TEST-CART-002` over-available → 409 shows `available` + clamp; product-gone → 404 removes line. `TEST-CART-003` Admin token on cart → 403 "shopper account required".
- `TEST-ORD-001` checkout→intent→confirm-success→COMPLETED: `total` equals server value (never client sum); items carry snapshot prices; reservationId present. `TEST-ORD-002` declined: FAILED + hold released (availability rebounds) + re-shop CTA; cart stays cleared. `TEST-ORD-003` double-click checkout/intent: buttons disabled while pending (no duplicate orders asserted loosely — backend has no idempotency key). `TEST-ORD-004` re-confirm/re-cancel 200 zero-delta (safe re-click). `TEST-ORD-005` cancel PENDING → CANCELLED + reason `user`; COMPLETED cancel → 409 "contact support".
- `TEST-NOTIF-001` history filters + unread badge + read/read-all idempotent (re-read same `readAt`). `TEST-NOTIF-002` WS `notification:new` bumps badge then history reconcile shows the row (offline-missed → history still correct).
- `TEST-X-001` validation: DTO-extra on `POST /cart` → 400 inline; extras on checkout → ignored (no error). `TEST-X-002` GraphQL error maps `extensions.code`; product-null → 404 page. `TEST-X-003` 429 shows `Retry-After` countdown + disabled submit. `TEST-X-004` 401 → refresh-once → retry → else `/login?expired=1` (never loops on refresh-401).

## Edge cases (must all be covered)

1. Expired access (15m) mid-session → silent refresh → original retried once.
2. Product deleted after add-to-cart → checkout 404 → cart line removed + notice.
3. Quantity > available at add/increase/checkout → 409 → stepper clamped to `available`.
4. Submit then network drop → mutation stays "unknown" → explicit user re-submit (no auto-retry); re-confirm/re-cancel safe, checkout/intent not.
5. Double-click checkout → single request (button lock); document backend has no `Idempotency-Key`.
6. Guest hits `/cart`/`/checkout` → `/login?next=…`, returns after login.
7. GraphQL `product(id)` bad id → error path → 404 page (never blank).
8. Refresh order-details page → `GET /order/:id` re-fetches (no stale snapshot reuse); 403 non-owner → denied page.
9. Payment-list empty → `totalPages=0` handled (no divide-by-zero pager).
10. Admin opens storefront cart → 403 → shopper-account notice (not a bug report).

## Definition of done (per feature)

Contract test green against `api-contract.md` + E2E green on real backend + a11y check + responsive check + no secrets in bundle + docs IDs (`FR/FLOW/PAGE/API/UI-COMP/TEST`) cross-linked. Tests depending on `BE-CHANGE-*` are marked `BLOCKED` and skipped, never faked.
