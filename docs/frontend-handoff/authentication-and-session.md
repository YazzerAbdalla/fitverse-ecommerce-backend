# Authentication & Session

Source: `auth.controller.ts`, `auth.service.ts`, guards, `users.controller.ts`, `.env.example`. Wire statuses are real (see `api-contract.md`).

## Lifecycle

- **Access (15m JWT, header-only):** `POST /auth/login` (200) or Google callback → `{accessToken, refreshToken}` + `Set-Cookie`. Send as `Authorization: Bearer <accessToken>` on every protected REST call; GraphQL reads need none. Payload `{sub,email,fullName,role,tokenVersion,iat,exp}` (`JWT_EXPIRES_IN=15m` default). Missing/malformed/expired → 401. Never put the access token in a cookie/localStorage-persisted readable store — keep in memory (see Security).
- **Refresh (7d opaque, rotating, body-OR-cookie):** `POST /auth/refresh` accepts `{refreshToken?}` OR `req.cookies.refresh_token` (default name) OR raw `Cookie` parse — body wins; `{}` is the cookie path. Cookie flags: `httpOnly:true`, `secure=(SECURE==='true')` (false locally), `sameSite:'strict'`, `path:'/auth'`, `maxAge=ttlMs`. Single-use rotation in one tx (`FOR UPDATE`); old row revoked, cap-5 LRU (6th session evicts oldest), new pair + rotated cookie returned (201) with `X-Email-Unverified:true` when `emailVerified=false`. Unknown/expired/revoked → 401 `'Invalid or expired refresh token'`.
- **Theft semantics:** reusing an already-rotated token triggers revoke-ALL (own tx, survives the 401) + warn + best-effort `INCR idempotency:duplicate:skipped:refresh`. UX: a working refresh suddenly 401s **and every other tab/device dies** → clear state, force re-login, show "session revoked — sign in again" (do not auto-retry).
- **Expiry:** access 15m → silent refresh; refresh 7d → full re-login. `reset-password` and `logout-all` both `tokenVersion++` (+ bulk revoke), killing all access + refresh immediately.
- **Logout:** `POST /auth/logout` (body-or-cookie optional) is idempotent — always 201 `{message:'Logged out'}` even for missing/garbage tokens. No server cookie-clear; frontend clears its own state (and optionally overwrites the cookie). `POST /auth/logout-all` (`@Auth()`, per-user 10/h) kills everything → redirect to login.
- **Verify/reset interplay:** verify/resend do not touch sessions. Forgot/reset validation is 64hex-floored (non-hex → 400 pre-DB); reset success kills sessions (re-login required).

## Protected-route map

| Route group | Guard | Frontend rule |
|---|---|---|
| GraphQL `products/product` | none | No token needed; do not attach auth. |
| Auth public (`register/login/forgot/validate/reset/verify/resend/refresh/logout/google-init+callback`) | `RateLimitGuard` only (+ passport on Google/login) | Handle 400/401/429; never attach Bearer. |
| `GET /users/me`, `PATCH /users/me/preferences`, `GET /order*`, `POST /order/checkout|cancel`, payment intent/confirm/cancel + reads, inventory reads, reservation reads, notifications history/read | `@Auth()` (any role) except cart (`@Auth(User)`) and admin (`@Auth(Admin)`) | Attach Bearer; expect 401 (refresh-once) / 403 (role/owner) / 404. |
| Cart (`GET /cart`, `POST /cart`, `PATCH /cart/*`, `DELETE /cart*`) | `@Auth(User)` | Admin token gets 403 — show "use a shopper account". |
| Admin/dashboard/inventory-writes/sales/test-email/outbox | `@Auth(Admin)` | Never link in storefront. |
| Shopper reservation writes | `@Auth(Admin,User)` + service hard-block | Never call — deterministic 403. |

## Refresh coordinator (required implementation)

- **Single-flight:** one in-flight `POST /auth/refresh {}` (with `credentials:'include'`); queue concurrent 401s behind it; retry each original once with the new access token. Mark the refresh call itself as non-retryable (401 from refresh → logout, never loop).
- **Dedup clicks:** disable submit buttons while pending; re-confirm/re-cancel are backend-idempotent (200 zero-delta) and safe to re-click after failure, but checkout/intent are NOT — require explicit user re-submit.
- **Concurrency:** backend serializes same-token refresh (`FOR UPDATE`); losers get 401-theft (all sessions dead). Frontend must therefore never fire two refreshes in parallel — the coordinator is load-bearing, not an optimization.
- **Storage:** accessToken in memory (or session-scoped state, never `localStorage` for refresh); rely on HttpOnly cookie for refresh + keep an optional body copy only for non-cookie contexts. Clear both on logout/logout-all/theft-401. Never log tokens; send `x-request-id` (uuid) on mutations for tracing.

## Edge cases

- Malformed login body → 400 (guard pre-validates), not 401 — show field errors, not "bad credentials".
- Non-64hex refresh/verify/reset token in body → 400 at validation (never hits DB) — distinct from 401/400-after-lookup.
- `GET /auth/google/*` are redirects — use `window.location`, not `fetch`.
- OTP routes always 501 (DTO-first, so malformed still 400s) — do not surface in UI.
- WS auth accepts `auth.token ?? query.token ?? Bearer` but skips `tokenVersion` (HTTP-only check) — treat WS as untrusted hint; reconcile with `GET /notifications`.
- After `reset-password` or `logout-all`, do not attempt refresh — go straight to login (all tokens dead by design).
