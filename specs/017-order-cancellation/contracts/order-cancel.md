# Contract: `POST /order/:id/cancel`

**Auth**: `JwtGuard` (any authenticated role). Owner-or-Admin enforced in
service (`403` otherwise). Rate-limited (shared order-write posture, `429`
with `Retry-After` on excess).

## Request

```text
POST /order/:id/cancel
Authorization: Bearer <accessToken>
Content-Type: application/json
Body: {} (empty; extra fields → 400 via global ValidationPipe)
```

`reason=user` is implied by this route. (`reason=failed` is used by the
payment-failure path internally; `reason=expired` by the expiry worker —
neither is a public route parameter.)

## Success — `200`

```json
{
  "id": "3fa85f64-5717-4562-b3c3-2c963f66afa6",
  "status": "CANCELLED",
  "total": 250,
  "userId": "3fa85f64-5717-4562-b3c3-2c963f66afa6",
  "reason": "user",
  "reservationId": "3fa85f64-5717-4562-b3c3-2c963f66afa6"
}
```

- `reason`: `user` for this route. `reservationId` is `null` when the order
  has no linked reservation.
- Re-cancel of an already `CANCELLED`/`FAILED` order returns `200` with the
  current state and zero inventory movement.

## Errors

| Code | When | Body hint |
|------|------|-----------|
| 400 | Non-empty/unknown body fields | ValidationPipe message |
| 401 | Missing/invalid JWT | `Unauthorized` |
| 403 | Not owner and not Admin | `You are not allowed to access this order` |
| 404 | Order not found; linked Inventory row missing | `Order <id> not found` / `Inventory <id> not found` |
| 409 | Order is COMPLETED (or FAILED→CANCELLED cross-transition); DB CHECK violation | `Invalid order transition: COMPLETED -> CANCELLED` |
| 429 | Rate limit exceeded | `Too Many Requests`, `Retry-After: 3600` |

Error envelope (REST): `{ statusCode, message, timestamp }` via
`AllExceptionsFilter`.
