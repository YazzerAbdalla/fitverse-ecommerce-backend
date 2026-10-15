# Feature Matrix

Status: `IMPLEMENTED` / `PARTIAL` / `PLANNED` / `MISSING` / `UNVERIFIED`. Evidence = backend file:line. `BE-CHANGE-*` are proposals (see `backend-change-requests.md`), never existing APIs.

## Auth & session

| ID | Feature | Status | API | Evidence | Frontend implication |
|---|---|---|---|---|---|
| FR-AUTH-001 | Register | IMPLEMENTED | API-REST-001 `POST /auth/register` | `auth.controller.ts:104`, `user-register.dto.ts:15-44` | MVP form: firstName,lastName,email,password + optional prefs. Expect wire 201. Map 400 dup string verbatim (backend typo `exist.`/`successfuly`). |
| FR-AUTH-002 | Login (password) | IMPLEMENTED | API-REST-002 `POST /auth/login` | `auth.controller.ts:124`, `local-auth.guard.ts:25-37` | MVP. Malformed → 400, bad creds → 401. Only route forcing 200. Store accessToken in memory; refresh via body+cookie. |
| FR-AUTH-003 | Refresh rotation | IMPLEMENTED | API-REST-003 `POST /auth/refresh` | `auth.controller.ts:307`, `auth.service.ts:312-464` | MVP silent-refresh with single-flight coordinator. `{}` = cookie path. 201 success. Reuse → 401 + all sessions dead (theft). |
| FR-AUTH-004 | Logout / logout-all | IMPLEMENTED | API-REST-004/005 | `auth.controller.ts:343-376` | MVP: logout always "succeeds" (201); clear local state + cookies client-side. Logout-all kills every session (`tokenVersion++`). |
| FR-AUTH-005 | Email verify + resend | IMPLEMENTED | API-REST-006/007/008 | `auth.controller.ts:199-262` | MVP: verify link page `GET` (200) + manual code form `POST` (201); resend with 60s-cooldown UX (429 `Retry-After:60`). Anti-enum messages are UX copy. |
| FR-AUTH-006 | Password reset | IMPLEMENTED | API-REST-009/010/011 | `auth.controller.ts:151-197` | MVP forgot → validate (advisory only) → reset. Never trust validate; reset is authority. Reset kills sessions (re-login required). |
| FR-AUTH-007 | Google OAuth | IMPLEMENTED | API-REST-012/013/014 | `auth.controller.ts:379-427` | MVP-optional: full-page redirect to `GET /auth/google`; callback is link-out, not fetch. 302/200 handling + 400 unverified / 409 double-link. |
| FR-AUTH-008 | OTP (WhatsApp) | PARTIAL (501) | API-REST-015/016 | `auth.controller.ts:278-305` | EXCLUDE from MVP. Do not render OTP UI. |
| FR-AUTH-009 | Me + preferences | IMPLEMENTED | API-REST-017/018 | `users.controller.ts:40-69` | MVP: `GET /users/me` bootstrap + `PATCH` prefs toggles. SafeUser allow-list is the only storable profile. |
| FR-AUTH-010 | Roles | IMPLEMENTED | guard-level | `roles.ts`, `roles.guard.ts:37-51` | MVP: `User` shopper only. Admin routes (dashboard/inventory/sales/outbox) must not be linked in storefront. Cart 403s for Admin — show "use shopper account". |

## Catalog

| ID | Feature | Status | API | Evidence | Implication |
|---|---|---|---|---|---|
| FR-CAT-001 | Product list | IMPLEMENTED | API-GQL-001 `products(page,limit)` | `schema.gql:51-54`, `products.service.ts:542-579` | MVP catalog with page/size pager only. Defaults 1/10, no max. Stale ≤60s acceptable. |
| FR-CAT-002 | Product details | IMPLEMENTED | API-GQL-002 `product(id)` | `schema.gql:52`, `products.service.ts:590-622` | MVP PDP. Fields only id/name/slug/description/price/created_at. Null → GraphQL error (treat as 404). No stock here — fetch inventory separately. |
| FR-CAT-003 | Search/filter/sort | MISSING | — | `schema.gql:51-54` (no args) | Client-side only over fetched pages, labeled as such. Server search = BE-CHANGE-001. |
| FR-CAT-004 | Categories/images/variants | MISSING | — | no entity/columns | Placeholder art + no variant UI. BE-CHANGE-002. |
| FR-CAT-005 | Price display | IMPLEMENTED | same as above | `product.entity.ts:44-46` + `CHK>=0` | Integer price; currency label is presentational (`usd` only appears in payment entity). |
| FR-CAT-006 | Admin product mutations | IMPLEMENTED (out of storefront scope) | API-GQL-003..007 | `schema.gql:21-27` | MUST NOT expose. No `@Auth()` — hiding is a frontend responsibility. |

## Inventory & reservations

| ID | Feature | Status | API | Evidence | Implication |
|---|---|---|---|---|---|
| FR-INV-001 | Live availability | IMPLEMENTED | API-REST-030/031 | `inventory.controller.ts:32-62` | MVP PDP/cart guard: `GET /inventory/:productId` or `/availability?quantity=`. Auth required. 404 = orphan. |
| FR-INV-002 | Admin stock writes | IMPLEMENTED (admin) | API-REST-032/033, dashboard stock | `inventory.controller.ts:66-107` | Not in storefront. |
| FR-INV-003 | Shopper reservation writes | IMPLEMENTED (blocked) | API-REST-040/041/042 | `reservation.controller.ts:36-153` | Never call as shopper — deterministic 403 copy is specified. State via order reads. |
| FR-INV-004 | Reservation reads | IMPLEMENTED | API-REST-043/044 | `reservation.controller.ts:54-77` | MVP order-details supplement (owner-or-Admin). |
| FR-INV-005 | Oversell guarantee | IMPLEMENTED | behavior | sorted `FOR UPDATE` + races in specs | Treat 409/401-after-submit as normal contention with retry/back-off UX. |

## Cart

| ID | Feature | Status | API | Evidence | Implication |
|---|---|---|---|---|---|
| FR-CART-001 | Get/create cart | IMPLEMENTED | API-REST-020 | `cart.controller.ts:34-43` | MVP. Auto-creates. `@Auth(User)` — Admin 403. |
| FR-CART-002 | Add item | IMPLEMENTED | API-REST-021 | `cart.controller.ts:45-78` | MVP. Append or increment. 409 over-available. Code returns `Cart` (not Swagger's `CartItem`). 201. |
| FR-CART-003 | Increase/decrease | IMPLEMENTED | API-REST-022/023 | `cart.controller.ts:80-148` | MVP steppers. Decrease floor: result <1 → 400 (use remove). |
| FR-CART-004 | Remove/clear | IMPLEMENTED | API-REST-024/025 | `cart.controller.ts:150-191` | MVP. Clear returns immediately (background delete). |
| FR-CART-005 | Totals | PARTIAL | derived | no total column on cart entities | Frontend estimates `Σ qty×price`; backend `Order.total` is authority. Label estimates. |
| FR-CART-006 | Guest/merge/expiry | MISSING | — | JWT `sub` required everywhere | Require login before cart. BE-CHANGE-003. |

## Checkout / orders / payment

| ID | Feature | Status | API | Evidence | Implication |
|---|---|---|---|---|---|
| FR-ORD-001 | Cart-only checkout | IMPLEMENTED | API-REST-026/027 | `order.controller.ts:48-109` | MVP. `POST /order/checkout {}` (alias deprecated). No body DTO — extras ignored. 201 PENDING + reservationId + snapshot items. 10/h/user. |
| FR-ORD-002 | Payment intent+confirm | IMPLEMENTED | API-REST-028/029/034 | `payment.controller.ts:64-156` | MVP payment step (simulation). `success` → COMPLETED; `declined` (+ fixed reason) → FAILED + hold released. Idempotent re-confirm 200. Owner-only writes (no Admin bypass). 10/h/user. |
| FR-ORD-003 | Admin-fallback complete | IMPLEMENTED | API-REST-035/036 | `order.controller.ts:123-216` | Show only as support/admin path, not the shopper happy path. |
| FR-ORD-004 | Cancel before sale | IMPLEMENTED | API-REST-037 | `order.controller.ts:226-271` | MVP "cancel pending order". 200 enriched; re-cancel 200 zero-delta. COMPLETED → 409 (no refund). Cart stays cleared. Effectively unthrottled (no route key). |
| FR-ORD-005 | Order history/details | IMPLEMENTED | API-REST-038/039 | `order.controller.ts:273-307` | MVP account pages. Unthrottled reads; `status` unvalidated; `userId` silently scoped for non-Admin; NaN-page gap → validate client-side. |
| FR-ORD-006 | Payment reads | IMPLEMENTED | API-REST-045/046 | `payment.controller.ts:169-216` | MVP receipts page. Strict 400s (unlike order list) + `totalPages=0` when empty. |
| FR-ORD-007 | Guest/Stripe/refund | MISSING | — | no SDK/webhook; cancel 409 on COMPLETED | Out of MVP. BE-CHANGE-004/005. |

## Notifications

| ID | Feature | Status | API | Evidence | Implication |
|---|---|---|---|---|---|
| FR-NOTIF-001 | History + unread + read | IMPLEMENTED | API-REST-047..050 | `notifications.controller.ts:127-263` | MVP notification center (poll + reconcile). Unthrottled. Idempotent reads. |
| FR-NOTIF-002 | WS live badge | IMPLEMENTED (ephemeral) | WS `notifications` | `notifications.gateway.ts:18-117` | MVP-optional live badge; never trust alone (no replay, `tokenVersion` gap). Always reconcile with history. `notification:read` client event is echo-only. |
| FR-NOTIF-003 | Sales/test-email/outbox | IMPLEMENTED (admin) | API-REST-051/052/053/054 | `notifications.controller.ts:52-117`, `outbox.controller.ts:30-125` | Not in storefront. |

## Cross-cutting

| ID | Feature | Status | Evidence | Implication |
|---|---|---|---|---|
| FR-X-001 | Validation | IMPLEMENTED | `main.ts:39-45` | DTO routes 400 on extras; DTO-less routes ignore extras. Validate forms client-side first, but backend decides. |
| FR-X-002 | Errors | IMPLEMENTED | `all-exceptions.filter.ts` | REST envelope vs GraphQL `extensions.code`. Render `message` verbatim for 400/403/409 (they are UX copy). |
| FR-X-003 | Rate limits | IMPLEMENTED | `rate-limit.guard.ts:18-59` | Handle 429 with `Retry-After` countdown + disable submit. Fail-open means limits can vanish (do not depend on 429 for logic). |
| FR-X-004 | Cache staleness | IMPLEMENTED | `products.service.ts`, `app.module.ts:40-48` | Catalog ≤60s stale; availability never cached. Do not cache stock client-side beyond the current view. |
| FR-X-005 | CORS/cookies | IMPLEMENTED | `cors.ts`, `main.ts:69-73` | `credentials:'include'` + `Bearer` header required; `x-request-id` optional tracing. |
| FR-X-006 | Images/files/health | MISSING/PARTIAL | no upload module; no `/health` | Placeholder images; liveness via `/api` or GraphQL introspection. |
