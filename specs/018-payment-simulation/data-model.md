# Data Model: Payment Simulation (Demo)

**Feature**: `018-payment-simulation` | **Date**: 2026-10-07
**Source of truth**: PostgreSQL (authoritative for `Payment` + existing `Order`/`Reservation`/`Inventory`). Redis holds throttle/skip counters only.

## Entity: `Payment` (new table `payment`)

| Column | Type | Constraints / Notes |
|--------|------|---------------------|
| `id` | `uuid` PK | `@PrimaryGeneratedColumn('uuid')` |
| `orderId` | `uuid` FK → `Order.id` `ON DELETE CASCADE` | `@Unique` (one payment per order, demo) + `@Index`; owning side `@OneToOne` + `@JoinColumn` |
| `userId` | `uuid` FK → `User.id` `ON DELETE CASCADE` | `@Index`; mirrors `Order.userId` at intent time (denormalized owner for fast `assertOwner` without order join) |
| `amount` | `int` | `CHECK (amount >= 0)`; **copied from `Order.total` at intent**, never client-supplied; same unit as `Order.total` (no cents conversion in demo) |
| `currency` | `varchar(3)` | default `'usd'`; fixed for demo |
| `status` | enum `PaymentStatus` | `PENDING \| SUCCEEDED \| FAILED \| CANCELLED`, default `PENDING`, `@Index` |
| `provider` | `varchar` | default `'simulation'`; no Stripe columns in demo |
| `failureReason` | `varchar` nullable | set only on `declined` confirm; allowed values `card_declined \| insufficient_funds \| expired_card` (service-enforced; DB stores raw string) |
| `createdAt` | `timestamptz` | `@CreateDateColumn` |
| `updatedAt` | `timestamptz` | `@UpdateDateColumn` |

**Indexes**: `@Unique(['orderId'])`, `@Index(['userId', 'status'])`, `@Index(['status', 'createdAt'])` (expiry-skip scan + admin list).
**No FK from `Order` back to `Payment`** — single direction `Payment.orderId → Order.id` (optional read-only `@OneToOne` relation `eager: false`).

## State transitions

```text
PENDING → SUCCEEDED  (confirm success → Order COMPLETED, Reservation COMPLETED, stock-=qty reserved-=qty)
PENDING → FAILED     (confirm declined → Order FAILED, Reservation CANCELLED, reserved-=qty only)
PENDING → CANCELLED  (cancel before confirm → Order CANCELLED, Reservation CANCELLED, reserved-=qty only)
SUCCEEDED → * : re-confirm returns already-processed 200, zero delta; cancel → 409
FAILED → *    : same idempotent re-confirm; cancel → 409
CANCELLED → * : same; cancel → 409
```

Terminal states have no outgoing transitions. All multi-row mutations share one tx with lock order `Payment → Order → Reservation → sorted Inventories`.

## Relationships

```text
User 1:N Payment (userId FK, owner scope; admin reads any)
Order 1:1 Payment (orderId UNIQUE FK; Payment SUCCEEDED ↔ Order COMPLETED, FAILED ↔ FAILED, CANCELLED ↔ CANCELLED)
Payment → Reservation (indirect via Order.orderId → Reservation.orderId; no direct FK)
```

## Validation rules (service re-checks even though DTOs gate first)

- `orderId` must be a UUID; order must exist (404), be `PENDING` (else 409), and belong to caller (403, owner-only, no admin bypass per Q1).
- Second `intent` for same order: existing `PENDING` → return same row (201 idempotent); existing terminal → 409.
- `confirm.result ∈ {success, declined}`; `failureReason` absent-or-ignored on `success`, must be in-enum on `declined` (400 otherwise).
- `confirm`/`cancel` on missing payment → 404; non-owner → 403; non-`PENDING` → 200 idempotent (confirm) / 409 (cancel).
- List: `page ≥ 1` (default 1), `1 ≤ limit ≤ 100` (default 20), `status` optional enum filter (Q5); unknown query keys rejected by global pipe.

## What is NOT changing (demo)

- No `Order` columns; `Order.status` values already cover all mappings.
- No `stripePaymentIntentId`, `clientSecret`, cents, webhook/replay tables (post-demo §19.10).
- No payment outbox event type (D9); existing order/reservation outbox rows flow unchanged.
