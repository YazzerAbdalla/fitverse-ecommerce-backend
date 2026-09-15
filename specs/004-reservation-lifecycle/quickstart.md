# Quickstart — Reservation Lifecycle (Phase 4)

**Branch**: `004-reservation-lifecycle` | **Date**: 2026-09-14 | **Spec**: [spec.md](./spec.md) | **Plan**: [plan.md](./plan.md)

## 1. Prereqs (once)

```powershell
docker compose up -d        # postgres:17, redis:8, rabbitmq:4 (healthy)
npm install
npm run build
npm run lint   # 0 errors (warnings OK)
```

## 2. Tests (canonical, real PG)

All integration/concurrency tests require **real PostgreSQL** and **serial** execution:

```powershell
npm run test -- --runInBand          # 13 suites / 89+ tests expected (unit + integration + new lifecycle)
npm run test -- reservation.service   --runInBand
npm run test -- reservation.integration --runInBand
npm run test:e2e -- --runInBand
```

Without `--runInBand`, parallel Jest workers sharing one DB may flake (`NotFoundException Inventory ...`). Keep `synchronize: false`; migrations `1755800000000`, `1755850000000` already applied.

## 3. Manual verification (with dev user + inventory)

Assume `userId` from `POST /auth/login` (or `POST /auth/register`) and `inventoryId` from `GET /inventory/:productId`. All reservations created `POST /reservations` as `{items:[{inventoryId, quantity:1}], expiresAt?:future}` → `201 {status:"RESERVED"}`.

### 3.1 RESERVED → COMPLETED (stock+reserved decrement)

```powershell
# 1) snapshot inventory
curl -s http://localhost:3000/inventory/<inventoryId> -H "Authorization: Bearer <JWT>"
# -> {productId, stock:10, reservedAmount:3, available:7}

# 2) complete (optionally with orderId)
curl -s -X PATCH http://localhost:3000/reservations/<reservationId>/complete -H "Authorization: Bearer <JWT>" -H "Content-Type: application/json" -d '{"orderId":"<existingOrderId>"}'
# -> 200 {status:"COMPLETED", orderId:"..."}

# 3) verify DB
# psql $DATABASE_URL -c "SELECT stock, \"reservedAmount\", stock-\"reservedAmount\" as available FROM inventory WHERE id='<inventoryId>';"
# -> stock 7, reservedAmount 0 (stock-=3, reserved-=3) when qty=3

# 4) idempotent retry (Q4: B) — same complete again → 200 not 409, no double decrement
curl -s -X PATCH http://localhost:3000/reservations/<reservationId>/complete -H "Authorization: Bearer <JWT>" -H "Content-Type: application/json" -d '{}'
# -> 200 {status:"COMPLETED"}; re-query inventory: stock 7, reserved 0 unchanged

# 5) orderId overwrite (Q3: A) — if allowed, second complete with new orderId overwrites
curl -s -X PATCH http://localhost:3000/reservations/<newReservedId>/complete -H "Authorization: Bearer <JWT>" -H "Content-Type: application/json" -d '{"orderId":"<orderB>"}'
# -> 200 {orderId:"<orderB>"}
curl -s -X PATCH http://localhost:3000/reservations/<newReservedId>/complete -H "Authorization: Bearer <JWT>" -H "Content-Type: application/json" -d '{"orderId":"<orderC>"}'
# -> 200 {orderId:"<orderC>"} but inventory not changed second time (idempotent)
```

### 3.2 RESERVED → CANCELLED (reserved only)

```powershell
curl -s -X PATCH http://localhost:3000/reservations/<reservedId>/cancel -H "Authorization: Bearer <JWT>"
# -> 200 {status:"CANCELLED"}
# psql -> stock 10 (unchanged), reservedAmount 3 (was 5, qty2 released), available 7
# retry cancel on same CANCELLED -> 409 Invalid transition (Q5: A)
curl -s -X PATCH http://localhost:3000/reservations/<cancelledId>/cancel -H "Authorization: Bearer <JWT>" -v
# -> 409 {message:"Invalid reservation transition: CANCELLED -> CANCELLED"}
```

### 3.3 RESERVED → EXPIRED via admin (immediate override, Q1: A)

```powershell
# even though expiresAt is future (+15m), admin can expire immediately
curl -s -X PATCH http://localhost:3000/reservations/<reservedId>/expire -H "Authorization: Bearer <admin JWT>"
# -> 200 {status:"EXPIRED"}; psql -> reservedAmount -=qty, stock unchanged
# retry expire on EXPIRED -> 409 (Q5)
curl -s -X PATCH http://localhost:3000/reservations/<expiredId>/expire -H "Authorization: Bearer <admin JWT>" -v
# -> 409
# non-admin expire -> 403
curl -s -X PATCH http://localhost:3000/reservations/<reservedId>/expire -H "Authorization: Bearer <user JWT>" -v
# -> 403
```

### 3.4 Invalid transitions → 409, no inventory change

```powershell
# COMPLETED -> CANCELLED should 409
curl -s -X PATCH http://localhost:3000/reservations/<completedId>/cancel -H "Authorization: Bearer <JWT>" -v
# -> 409 Invalid reservation transition: COMPLETED -> CANCELLED
# verify inventory still stock 7 reserved 0

# EXPIRED -> COMPLETED -> 409
curl -s -X PATCH http://localhost:3000/reservations/<expiredId>/complete -H "Authorization: Bearer <JWT>" -H "Content-Type: application/json" -d '{}' -v
# -> 409
```

### 3.5 Concurrent complete vs cancel — single winner

```powershell
# open two terminals / use node parallel fetch against same RESERVED id:
# Terminal 1: PATCH /:id/complete  &   Terminal 2: PATCH /:id/cancel  (fire at same time)
# Exactly one -> 200, the other -> 409; psql shows reservedAmount decremented once (either stock+reserved or reserved-only path, not both).
# Verified by integration concurrency test SC-005.
```

### 3.6 Invalid orderId on complete → 404, rolled back

```powershell
curl -s -X PATCH http://localhost:3000/reservations/<reservedId>/complete -H "Authorization: Bearer <JWT>" -H "Content-Type: application/json" -d '{"orderId":"00000000-0000-0000-0000-000000000000"}' -v
# -> 404 Order not found; psql shows reservation still RESERVED and inventory unchanged
```

### 3.7 DB CHECK backstop (Q2) — stock>=0

```powershell
# manually set stock low to trigger constraint (admin/internal):
# psql -c "UPDATE inventory SET stock=1, \"reservedAmount\"=1 WHERE id='<inventoryId>';"
# create RESERVED qty 1 -> complete would do stock-=1 (0 OK), but stock-=2 would hit CHECK
# service does NOT pre-check stock>=qty; violation → rollback 409 per FR-007
```

## 4. psql helpers

```sql
-- reservation + items
SELECT id, "userId", status, "orderId", "expiresAt" FROM reservation WHERE id='<id>';
SELECT "reservationId", "inventoryId", quantity FROM reservation_item WHERE "reservationId"='<id>';
-- inventory
SELECT id, "productId", stock, "reservedAmount", stock-"reservedAmount" as available FROM inventory WHERE id='<inventoryId>';
-- indexes
SELECT indexname FROM pg_indexes WHERE tablename IN ('reservation','reservation_item','inventory');
```

## 5. Checklist

- [ ] `npm run lint` / `npm run build` pass
- [ ] `npm run test -- --runInBand` green (new lifecycle integration + concurrency + idempotent)
- [ ] Manual `RESERVED→COMPLETED` `stock`+`reserved` decremented, idempotent second `200` no double
- [ ] `RESERVED→CANCELLED` `reserved` only decremented, `stock` unchanged, retry `409`
- [ ] `RESERVED→EXPIRED` admin immediate override (future `expiresAt` still expires), retry `409`, non-admin `403`
- [ ] Invalid edges `COMPLETED→CANCELLED` etc. `409`, inventory unchanged
- [ ] Concurrent `complete` vs `cancel` → one `200` one `409`, inventory mutated once
- [ ] `complete` with valid `orderId` overwrites, invalid `orderId` → `404` rolled back
