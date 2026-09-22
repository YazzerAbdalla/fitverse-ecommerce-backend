# Contract: Order Completion / Sale — `POST /order/:id/complete`

**Branch**: `008-order-completion-sale` | **Spec**: [spec.md](../spec.md) | **Plan**: [plan.md](../plan.md) | **Date**: 2026-09-22

## 1. REST Endpoints

### 1.1 `POST /order/:id/complete` — Sale (canonical)

Complete a `PENDING` order → `COMPLETED` + `Reservation RESERVED→COMPLETED` + `Inventory stock-=qty reserved-=qty`.

| Item | Value |
|------|-------|
| **Method** | `POST` (alias `PATCH /order/:id/complete` allowed, same semantics, optional) |
| **Path** | `/order/:id` `/complete` where `:id` is `Order.id` `uuid` |
| **Auth** | `JwtGuard` via `@Auth()` — owner-or-Admin (`assertOwner(order, requestingUserId, role)`; `User` on own order `200`, other user's order `403`, `Admin` any order `200`) |
| **Body** | `{}` empty — `CompleteOrderDto` has **no fields**; global `ValidationPipe` (`whitelist`+`forbidNonWhitelisted`+`transform`) rejects any `items[]`, `paymentId`, `amount`, `reservationId`, `expiresAt` with `400 { statusCode, message:"property X should not exist", ...}` |
| **Success** | `200 OK` with completed order + reservation link. **Minimal payload** (always present):<br/>`{ id: uuid, status:"COMPLETED", total: int, userId: uuid, createdAt: timestamptz, updatedAt: timestamptz, reservationId: uuid, reservation:{ id, status:"COMPLETED", expiresAt }, items:[{ id, productId, quantity, unit_price:int, unitPrice:int, productNameSnapshot:string|null, subtotal:int }] }`<br/>Optional `inventoriesAffected:[{ inventoryId, productId, stock, reservedAmount, available }]` if plan chooses verbose payload. `total` and `items[*].unit_price` are **unchanged** historical values. |
| **Errors** | `400` DTO validation (extra fields), `401` unauthenticated, `403` owner mismatch, `404` Order not found / Reservation for order not found / Inventory `<id>` not found, `409` invalid transition (`PENDING→COMPLETED` only, `CANCELLED/FAILED→COMPLETED`, `EXPIRED→COMPLETED` mapped to `CANCELLED` 409) or DB `CHECK stock>=0` (`23514` → `409 Insufficient stock to complete sale`) |
| **Idempotency** | `COMPLETED→COMPLETED → 200` idempotent success with no inventory re-mutation (same payload as first). Duplicate `POST` does **not** decrement `stock` again. |
| **Transactional** | Single `dataSource.transaction`: `Lock Order FOR UPDATE → assertOwner → validateOrderTransition → Lock Reservation FOR UPDATE (by orderId) → validateTransition RESERVED→COMPLETED → Lock sorted Inventories FOR UPDATE → stock-=qty reserved-=qty → save Order+Reservation`. Any failure → `ROLLBACK` (no partial). No Redis/RabbitMQ I/O inside. |

**Swagger**:

```ts
@Post(':id/complete')
@Auth()
@ApiBearerAuth('JWT-auth')
@ApiOperation({ summary: 'Complete pending order → sale (stock-=qty)' })
@ApiResponse({ status: 200, description: 'Order completed' })
@ApiResponse({ status: 403, description: 'Forbidden — not owner' })
@ApiResponse({ status: 404, description: 'Order/Reservation/Inventory not found' })
@ApiResponse({ status: 409, description: 'Invalid transition or insufficient stock' })
async complete(@CurrentUser('sub') userId, @CurrentUser('role') role, @Param('id') id, @Body() dto: CompleteOrderDto)
```

**cURL**:

```bash
# as owner (after checkout)
curl -X POST http://localhost:3000/order/<orderId>/complete \
  -H "Authorization: Bearer <jwt>" \
  -H "Content-Type: application/json" \
  -d '{}'
# → 200 { id:"...", status:"COMPLETED", reservationId:"...", ... }

# bad body
curl -X POST .../complete -H ... -d '{"paymentId":"pay_123"}'
# → 400 property paymentId should not exist

# other user's order
curl -X POST .../complete -H "Authorization: Bearer <other-jwt>" -d '{}'
# → 403

# retry (idempotent)
curl -X POST .../complete -H ... -d '{}'
# → 200 (same, no second stock decrement)
```

### 1.2 `PATCH /order/:id/complete` — Alias (optional)

Same as §1.1 method `PATCH`, kept for consistency with `PATCH /reservations/:id/complete`. Plan may expose both (`@Post` + `@Patch` on same handler) or only `POST`; `POST` is canonical.

### 1.3 `GET /order/:id` — Read after sale (existing, unchanged)

| Method | Path | Auth | Success |
|--------|------|------|---------|
| `GET` | `/order/:id` | owner-or-Admin | `200 Order COMPLETED with items + reservationId` (historical `unit_price` frozen even after `Product.price` changes) |

### 1.4 `GET /order` — List with filter (existing, unchanged)

Query `?page=1&limit=10&status=COMPLETED` returns `{ data: Order[], meta:{ totalItems, itemCount, itemsPerPage, totalPages, currentPage } }` paginated `created_at DESC`, owner-scoped (Admin may `?userId=`).

### 1.5 `GET /reservations/:id` — Reservation after sale (existing, unchanged)

`Reservation` with `orderId=O.id` now `status COMPLETED`, `GET` as owner/Admin `200`.

### 1.6 `PATCH /reservations/:id/complete` — Internal/Admin only (unchanged)

Remains `Admin`-only (`User → 403 Reservation transitions via Order lifecycle only`). The Order path §1.1 is the **user-facing** sale; direct Reservation completion by User stays blocked to keep `Order` and `Reservation` consistent (single producer).

---

## 2. DTOs

### `CompleteOrderDto`

```ts
export class CompleteOrderDto {}
// no fields; @ApiProperty none
// class-validator: no decorators → any property triggers ValidationPipe 400
```

### `CheckoutDto` (existing)

Empty `{}` for `POST /order/checkout` — same `forbidNonWhitelisted` handling.

---

## 3. Error Mapping (Global AllExceptionsFilter)

| Status | When | Body |
|--------|------|------|
| 400 | Extra body field, invalid uuid `:id` | `{ statusCode:400, message:"property X should not exist", timestamp }` |
| 401 | Missing/invalid JWT | `{ statusCode:401, message:"Unauthorized" }` |
| 403 | `order.userId !== requestingUserId && role !== Admin` | `{ statusCode:403, message:"You are not allowed to access this order" }` |
| 404 | `Order <id> not found` / `Reservation for order <id> not found` / `Inventory <id> not found` | `{ statusCode:404, message:"... not found" }` |
| 409 | `Invalid order transition: PENDING->COMPLETED` violation, `Invalid reservation transition: RESERVED->COMPLETED` (if reservation not RESERVED), `Insufficient stock to complete sale` (DB CHECK 23514 mapped) | `{ statusCode:409, message:"Inventory invariant violation ..." }` |
| 500 | Unexpected | `{ statusCode:500, message:"Internal server error" }` |

---

## 4. OpenAPI Sketch

```yaml
/components/schemas/CompleteOrderDto: { type: object, properties: {} }
paths:
  /order/{id}/complete:
    post:
      summary: Complete pending order → sale
      security: [ { JWT-auth: [] } ]
      parameters: [{ name: id, in: path, required: true, schema: { type: string, format: uuid } }]
      requestBody: { content: { application/json: { schema: { $ref: "#/components/schemas/CompleteOrderDto" } } } }
      responses:
        200: { description: Order completed, content: { application/json: { schema: { type: object, properties: { id:{type:string}, status:{type:string,enum:[COMPLETED]}, total:{type:integer}, reservationId:{type:string}, reservation:{type:object}, items:{type:array} } } } } }
        400: { description: Validation error }
        403: { description: Forbidden }
        404: { description: Not found }
        409: { description: Conflict }
```

---

## 5. Contract Tests (must pass)

- `POST /order/:id/complete` as owner `PENDING` → `200 COMPLETED` + `GET /inventory/:productId` `stock` decremented.
- As non-owner `User` → `403` no mutation; as `Admin` → `200`.
- `POST` with extra field `{paymentId:1}` → `400`; with no JWT → `401`.
- `POST` on `CANCELLED`/`EXPIRED`/`FAILED` → `409`; missing Reservation → `404`; second `POST` on already `COMPLETED` → `200` idempotent no second `stock` move.
- Concurrent `Promise.all([POST complete, POST complete])` on same order → one `stock` decrement, both `200` (verified via integration).
- `GET /order/:id` after `Product.price 100→999` → `unit_price` still `100`.
