# Backend Change Requests (PROPOSED — BACKEND CHANGE REQUIRED)

None of the below exists. Do not implement frontend code against these paths until the backend ships them. IDs are `BE-CHANGE-*` for roadmap/test gating.

## BE-CHANGE-001 Server product search / filter / sort
**Need:** catalog UX beyond page pager. Today `products(page,limit)` takes no filter args (`schema.gql:51-54`) and the cache key is filter-blind by construction.
**Proposal:** extend `PaginationArgs` with optional `search?: string`, `minPrice?: Int`, `maxPrice?: Int`, `sort?: 'price_asc'|'price_desc'|'newest'`; include the normalized tuple in the cache key; keep deterministic `ORDER BY`; document `totalPages` semantics under filters. Non-breaking (all optional). Gates client-side-search removal.

## BE-CHANGE-002 Product media + categories + variants
**Need:** real PDP/gallery/filter UX. Today Product has only `id/name/slug/description/price/created_at` (`schema.gql:37-44`); no image/category/variant tables exist.
**Proposal:** `ProductImage {productId, url, alt, sortOrder}`, `Category` + join (or `category` column V1), optional `ProductVariant {attributes, priceDelta, inventoryId?}`; expose in `Product` type + `create/update` inputs with validation; serve via CDN/static with signed URLs if private. Frontend currently uses placeholder art.

## BE-CHANGE-003 Guest cart + merge on login
**Need:** lower-friction shopping. Today every cart route requires JWT `sub` (`cart.controller.ts:27-30`); no guest/merge endpoint.
**Proposal:** anonymous cart keyed by signed cookie/UUID with `POST /cart/guest`, merge endpoint `POST /cart/merge` on login (server-side quantity union + availability re-check, 409 per line). Decide TTL/abuse limits with rate-limit team.

## BE-CHANGE-004 Real payment (Stripe or equivalent)
**Need:** real money movement. Today `provider:'simulation'`, no SDK/webhook/secrets, amount = `Order.total` units (no cents), no `payment.*` outbox event.
**Proposal:** Stripe `PaymentIntent` + webhook (`payment.webhook` verify signature, `evt.id` replay table), `clientSecret` flow, cents handling, `payment.succeeded/failed` outbox events, refunds path with `BE-CHANGE-005`. Keep simulation behind a flag for local dev.

## BE-CHANGE-005 Post-sale cancel / refund (`COMPLETED→CANCELLED`)
**Need:** support/ops flow. Today `COMPLETED→CANCELLED` is 409 (`order-transitions.ts`); cancel only releases `reserved-=qty`, never `stock+=qty`.
**Proposal:** `POST /order/:id/refund {reason}` (Admin or policy-gated user) → `COMPLETED→CANCELLED` + `stock+=qty` + refund record; define payment reversal behavior with `BE-CHANGE-004`. Until then the UI must show "contact support" on COMPLETED cancel attempts.

## BE-CHANGE-006 Strict pagination guards (order/reservation lists)
**Need:** predictable pager behavior. Today `GET /order` and `GET /reservations` use `parseInt`/`+page` without NaN/negative guards (order `NaN` passes through; reservation `NaN`/0 possible), unlike the strict payment/notification lists (400).
**Proposal:** shared `PaginationQueryDto` (`page≥1`, `limit 1..100`, defaults 1/20) returning 400 on violations, matching payment-list strictness. Frontend currently validates client-side as a workaround.

## BE-CHANGE-007 Cart totals endpoint
**Need:** authoritative pre-checkout total without checking out. Today Cart has no total column; frontend sums `Σ qty×price` as an estimate while `Order.total` is the only authority.
**Proposal:** `GET /cart/totals` → `{lines:[{productId,quantity,unitPrice,subtotal}], total, currency}` computed with the same snapshot rules as checkout (read-only, no locks). Display-only; checkout remains the authority.

## BE-CHANGE-008 Health endpoint
**Need:** deploy/monitoring + frontend liveness probe. Today no `/health` controller exists; liveness is inferred from `/api` or GraphQL introspection.
**Proposal:** `GET /health` (public, unthrottled) → `{status:'ok', version, uptime}` plus optional `GET /health/ready` (DB/Redis/RMQ checks, 503 when degraded). No PII.

## BE-CHANGE-009 (minor) Consistent POST success codes + `removeProduct` return shape
**Need:** reduce frontend special-casing. Today most POSTs return 201 by Nest default while Swagger annotates 200, and `removeProduct` declares `Product` but returns `DeleteResult`.
**Proposal:** either annotate actual 201s correctly in Swagger or force `@HttpCode(200)` consistently; fix `removeProduct` schema to `DeleteResult`/`affected`. Docs-only except the schema fix.

## Priority for MVP
Ship MVP with zero backend changes. If backend bandwidth opens: `001` (search) first, then `007` (totals), `006` (pagination), `008` (health). `002/003/004/005` are post-MVP tracks with their own specs.
