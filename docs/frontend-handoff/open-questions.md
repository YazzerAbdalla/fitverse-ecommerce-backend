# Open Questions (UNVERIFIED / needs human decision)

## UNVERIFIED backend behavior (do not assume — probe in Phase 0)

1. **`GET /api-json` shape:** Swagger JSON endpoint name not verified in code (`SwaggerModule.setup('api', …)` only; `/api-json` is the Nest default). Confirm it serves JSON before scripting the export; else use UI "Export" or `SwaggerModule.createDocument` dump. Blocks `api/openapi.json`.
2. **`totalPages` when order/payment lists are empty:** payments code yields `0` (`payment.service.ts:483-484`); order-list code path not line-verified here — probe `GET /order` on an empty user. Pager must handle both `0` and `1`.
3. **Live email delivery in dev:** `EMAIL_PROVIDER=resend` + Resend SMTP defaults are in `.env.example:78-85`, but actual send success/failure latency, `test-email` 500 shape, and whether verify/reset emails arrive in the demo inbox were not probed (no live boot in this task). Treat email-dependent E2E as best-effort until Phase 0 probe.
4. **`GET /auth/google/callback` success transport:** code returns 200 JSON + cookie (`auth.controller.ts:393-409`), but the exact behavior when Google denies consent (302 back with `?error=`) was not traced through passport — probe with a denied flow or record as edge-case gap.
5. **Checkout/outbox failure surfacing:** checkout's `order.created` insert is best-effort catch+warn (commit continues); the exact client-visible difference between "order created, event pending" vs "order created, event failed" is log-only. Frontend needs no branch — noted so E2E doesn't assert on outbox state.
6. **WS `notifications` URL/path:** namespace is `'notifications'` with `cors:true` (`notifications.gateway.ts:18`), but the full socket.io URL (port/path/transports) and prod CORS origin behavior were not probed live. Phase 0 must connect with `auth.token` and record the working URL.

## Product decisions for the human (no default chosen)

7. **Catalog UX without server search:** MVP ships client-side search/sort over loaded pages with the "searches loaded products" label. Approve the label copy, or approve `BE-CHANGE-001` (server search) as the first backend track.
8. **Placeholder product art:** no images exist. Approve initial-letter tiles (proposed) vs a stock-photo set vs leaving image slots empty until `BE-CHANGE-002`.
9. **Google OAuth in MVP:** implemented and cheap (redirect + callback), but adds a redirect-page + edge-case matrix. Include in MVP or defer to v1.1?
10. **Guest browsing vs guest cart:** PDP/catalog are public; availability + cart require login. Approve the "sign in for availability / to shop" gating copy, or approve `BE-CHANGE-003` (guest cart).
11. **Currency label:** prices are unit-less integers; only the payment entity hardcodes `'usd'`. Display "$ / USD / EGP / L.E."? Needs a product decision (no backend truth beyond `currency:'usd'` on Payment).
12. **Order-cancel discoverability:** cancel is effectively unthrottled and cart stays cleared. Approve confirm-dialog copy ("cancelling releases your hold; your cart stays empty") vs hiding cancel behind support until post-MVP.

## Assumed-but-proposed (frontend-only, safe to change)

- Routes (`/products/:id`, `/orders/:id`, `/payments`, `/notifications`, `/account`), design tokens, component names/props, stack pick (Next.js vs Vite), and Tailwind mapping are all **proposed**, not backend-mandated. Any can change without touching the backend.
- `FRONTEND_URL`/`CORS_ORIGINS` values for preview/prod deployments must be supplied by the human and allow-listed in backend env (`cors.ts`, `main.ts:69-73`); empty list fails closed in prod.
