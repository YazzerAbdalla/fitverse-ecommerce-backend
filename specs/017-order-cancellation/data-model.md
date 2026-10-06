# Data Model: Order Cancellation (Phase 8)

**Date**: 2026-10-06 | **Spec**: `specs/017-order-cancellation/spec.md`

No schema change. No migration. This phase uses existing tables only.

## Tables touched (existing columns)

```text
Order        { id uuid PK, userId uuid FK, status enum, total int CHECK>=0,
               created_at, updated_at }  @Index(userId), @Index(status)
Reservation  { id uuid PK, userId FK, orderId FK nullable, status enum,
               expiresAt timestamptz }   @Index(status, expiresAt) composite
ReservationItem { id uuid PK, reservationId FK, inventoryId FK, quantity int }
Inventory    { id uuid PK, productId FK @Unique, stock int, reservedAmount int }
OutboxEvent  { id uuid PK (= payload.eventId), eventType, aggregateType,
               aggregateId, payload jsonb, status, attempts, nextRetryAt }
```

## Order state machine (this feature)

```text
PENDING --(shopper/admin cancel, reason=user)--> CANCELLED
PENDING --(expiry worker)-----------------------> CANCELLED
PENDING --(payment failure, reason=failed)------> FAILED
CANCELLED --(re-cancel)------------------------> CANCELLED  (idempotent 200, 0 delta)
FAILED ----(re-cancel)-------------------------> FAILED     (idempotent 200, 0 delta)
COMPLETED --(cancel)---------------------------> 409 Conflict (no mutation)
CANCELLED/FAILED --(cancel to other terminal)-> 200 idempotent (no mutation)
```

Post-sale `COMPLETED → CANCELLED` (refund, `stock += qty`) is out of scope.

## Reservation coupling (existing semantics, unchanged)

```text
User/failed cancel : Reservation RESERVED → CANCELLED (reserved -= qty, stock unchanged)
Expiry worker      : Reservation RESERVED → EXPIRED   (reserved -= qty, stock unchanged)
                     + Order PENDING → CANCELLED in the same tx (reservation.service.ts:647-676)
Already-terminal reservation on user cancel: order still closes, inventory untouched
```

## Inventory invariant (enforced in DB + service)

- `available = stock - reservedAmount` (derived, never stored).
- Cancel path only decrements `reservedAmount`; `stock` is never written here.
- `CHECK reservedAmount >= 0`, `reservedAmount <= stock` backstop → mapped to
  `409` on violation (same `23514` mapping as completion path).

## `order.cancelled` envelope (OutboxService-owned)

```json
{
  "version": 1,
  "eventId": "<outbox row id>",
  "eventType": "order.cancelled",
  "occurredAt": "<iso>",
  "correlationId": "<x-request-id | x-correlation-id | randomUUID>",
  "data": {
    "orderId": "<uuid>",
    "userId": "<uuid>",
    "previousStatus": "PENDING",
    "newStatus": "CANCELLED | FAILED",
    "reason": "user | expired | failed",
    "reservationId": "<uuid | null>"
  }
}
```

Expiry worker emits the identical shape with `reason: 'expired'`
(`reservation-expiration.service.ts:345-358`).

## Transaction & lock discipline

One `DataSource.transaction` per cancel (controller-owned, consistent with
`complete` in the same controller):

```text
FOR UPDATE Order → assertOwner → terminal-state guard
  → FOR UPDATE Reservation (+items) → FOR UPDATE sorted Inventories
  → reservedAmount -= qty → Reservation → CANCELLED
  → OutboxService.createEvent(order.cancelled) [failure → rollback, FR-009/Q2-A]
  → Order → CANCELLED | FAILED → commit
```

Reads (`GET /order`, `GET /order/:id`) unchanged.
