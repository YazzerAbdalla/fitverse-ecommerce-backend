# Contract: Payment API (Demo)

**Feature**: `018-payment-simulation` | **Base**: same host/auth as order APIs (`@Auth()` + `JwtGuard`, `RateLimitGuard` outermost on intent/confirm, global `ValidationPipe` + `AllExceptionsFilter`).

## Endpoints

| Method | Path | Auth | Body / Query | Success | Errors |
|--------|------|------|--------------|---------|--------|
| POST | `/payments/intent` | owner-only (`@Auth()`, no admin bypass) | `{ orderId: uuid }` | `201 { id, orderId, amount, currency: 'usd', status: 'PENDING', provider: 'simulation' }` (existing PENDING same order → same row 201) | `400` validation, `401`, `403` not owner, `404` order not found, `409` order not PENDING or terminal payment exists, `429` throttled |
| POST | `/payments/:id/confirm` | owner-only | `{ result: 'success' \| 'declined', failureReason?: 'card_declined' \| 'insufficient_funds' \| 'expired_card' }` | `200 { payment, order }` (success → `SUCCEEDED` + order `COMPLETED`; declined → `FAILED` + order `FAILED`; terminal → already-processed 200 zero-delta) | `400` validation, `401`, `403`, `404`, `429`; never `409` on confirm (idempotent) |
| POST | `/payments/:id/cancel` | owner-only | `{}` (empty, forbid unknown) | `200 payment CANCELLED + order CANCELLED + reservation CANCELLED` | `400`, `401`, `403`, `404`, `409` already terminal |
| GET | `/payments/:id` | owner-or-Admin | — | `200 payment` | `401`, `403`, `404` |
| GET | `/payments` | owner-or-Admin | `?page=1&limit=20&status=&userId=(admin only)` | `200 { data: Payment[], meta }` newest-first, owner-scoped | `400` bad pagination/filter, `401`, `403` |

## DTOs

```text
CreatePaymentIntentDto { orderId: uuid (IsUUID, ApiProperty) }
ConfirmPaymentDto {
  result: 'success' | 'declined' (IsIn),
  failureReason?: 'card_declined' | 'insufficient_funds' | 'expired_card' (IsOptional, IsIn; required-by-convention when declined — missing on declined → 400)
}
```

Global pipe rejects unknown fields (e.g. client `amount` → 400; amount is always server-copied).

## Error shape

Standard `AllExceptionsFilter` `{ statusCode, message, timestamp }`; `429` also carries `Retry-After` + `X-RateLimit-*` headers.

## Notes

- `POST /order/:id/complete` stays as the Admin fallback (unchanged); payment confirm is the normal shopper path.
- Currency fixed `usd`; provider fixed `simulation`; no `clientSecret` in demo.
