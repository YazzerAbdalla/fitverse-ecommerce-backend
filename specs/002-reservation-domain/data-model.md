# Data Model: Reservation Domain (Phase 2)

**Feature**: `002-reservation-domain` | **Date**: 2026-08-22
**Spec**: [spec.md](./spec.md) | **Plan**: [plan.md](./plan.md)

## Entities

### 1. Reservation

Represents a temporary claim on one or more inventory records for a user,
optionally linked to an order after checkout (Phase 6).

| Field | Type | Constraints / Notes |
| --- | --- | --- |
| `id` | `uuid` | `@PrimaryGeneratedColumn('uuid')` PK |
| `userId` | `uuid` | FK → `User.id` `ON DELETE CASCADE`, `NOT NULL`, `@Index()` |
| `orderId` | `uuid` | FK → `Order.id` `ON DELETE SET NULL`, `nullable`, `@Index()` |
| `status` | enum `ReservationStatus` | `RESERVED | COMPLETED | EXPIRED | CANCELLED`, `NOT NULL`, `default: RESERVED`, `@Index()`, Postgres enum type |
| `expiresAt` | `timestamptz` | `NOT NULL`, `@Index()`, validated future at creation; service defaults to `now+15m` if omitted |
| `createdAt` | `timestamptz` | `@CreateDateColumn()` |
| `updatedAt` | `timestamptz` | `@UpdateDateColumn()` |

**Indexes**:
- `@Index(['userId'])`
- `@Index(['status'])`
- `@Index(['expiresAt'])`
- Composite `@Index(['status', 'expiresAt'])` for Phase 5 cleanup `WHERE status='RESERVED' AND expiresAt <= NOW()`
- Optional `@Index(['userId', 'status'])` for user-scoped listing

**Relations**:
- `@ManyToOne(() => User)` via `userId` (no inverse needed)
- `@ManyToOne(() => Order, { nullable: true })` via `orderId`
- `@OneToMany(() => ReservationItem, item => item.reservation, { cascade: true })` → `items`

**Enum**:
```ts
export enum ReservationStatus {
  RESERVED = 'RESERVED',
  COMPLETED = 'COMPLETED',
  EXPIRED = 'EXPIRED',
  CANCELLED = 'CANCELLED',
}
```

**State machine** (service-enforced, not only DB):
- `RESERVED → COMPLETED | EXPIRED | CANCELLED` allowed
- All other transitions rejected with `409 Conflict`
- Phase 2 transitions are status-only; inventory mutation is Phase 3-4

---

### 2. ReservationItem

Line item claiming a quantity of a specific inventory within a reservation.

| Field | Type | Constraints / Notes |
| --- | --- | --- |
| `id` | `uuid` | `@PrimaryGeneratedColumn('uuid')` PK |
| `reservationId` | `uuid` | FK → `Reservation.id` `ON DELETE CASCADE`, `NOT NULL`, `@Index()` |
| `inventoryId` | `uuid` | FK → `Inventory.id` `ON DELETE CASCADE` (or `RESTRICT`), `NOT NULL`, `@Index()` |
| `quantity` | `int` | `NOT NULL`, `@Check('"quantity" > 0')`, DTO `@IsInt() @Min(1)` |
| `createdAt` | `timestamptz` | `@CreateDateColumn()` |
| `updatedAt` | `timestamptz` | `@UpdateDateColumn()` |

**Constraints**:
- `@Unique(['reservationId', 'inventoryId'])` — prevents duplicate inventory claim within same reservation (reject duplicate items)
- `@Check('"quantity" > 0')`
- `quantity` is integer; quantities/prices from clients are untrusted and re-validated in service (constitution VIII)

**Relations**:
- `@ManyToOne(() => Reservation, r => r.items, { onDelete: 'CASCADE' })`
- `@ManyToOne(() => Inventory)` via `inventoryId` (Inventory does not need inverse)

**Indexes**:
- `@Index(['reservationId'])`
- `@Index(['inventoryId'])`
- Unique composite naturally indexed

---

## Entity Diagram

```text
User 1 ── * Reservation 1 ── * ReservationItem * ── 1 Inventory 1 ── 1 Product
                │
                └─ 0..1 Order (nullable orderId, Phase 6)
```

- `Inventory.productId → Product.id` already exists (Phase 1)
- `Reservation.userId → User.id`
- `Reservation.orderId → Order.id` nullable
- `ReservationItem.reservationId → Reservation.id`
- `ReservationItem.inventoryId → Inventory.id`

---

## Validation Rules (from spec FR-006, research)

- `expiresAt` required (service defaults to now+15m if DTO omits); when supplied must be `> now` (strictly future).
- `items` must be non-empty array (at least 1), each item: `inventoryId` valid uuid, `quantity` int >=1.
- No duplicate `inventoryId` within a single reservation's items.
- `inventoryId` must reference existing `Inventory` (service lookup → 404 if not found).
- `orderId` if supplied must reference existing `Order` or be omitted (null allowed).
- All fields declared in DTOs; global `ValidationPipe` with `whitelist + forbidNonWhitelisted + transform`.

---

## DTOs (shape for contracts)

### CreateReservationDto
```ts
{
  expiresAt?: string; // ISO date, IsOptional IsDateString isFuture
  orderId?: string;   // uuid nullable, optional Phase 2
  items: Array<{
    inventoryId: string; // uuid
    quantity: number;    // IsInt @Min(1)
  }>; // @ArrayMinSize(1), @ValidateNested({each: true}), unique inventoryId
}
```

### ReservationResponse shape
```ts
{
  id: string;
  userId: string;
  orderId: string | null;
  status: ReservationStatus;
  expiresAt: string;
  createdAt: string;
  updatedAt: string;
  items: Array<{
    id: string;
    reservationId: string;
    inventoryId: string;
    quantity: number;
    inventory?: { id: string; productId: string; stock: number; reservedAmount: number };
  }>;
}
```

---

## Migration Notes

- Phase 2 migration: `CreateReservationAndReservationItem` — creates enum `reservation_status`, tables `Reservation`, `ReservationItem`, indexes, FKs, checks, unique constraint.
- `synchronize: false` → migration required (as in Phase 1).
- Add `Reservation`, `ReservationItem` to `src/data-source.ts` entities array.

---

## Out of Scope (Phase 2)

- No `Inventory.reservedAmount` mutation on reservation create/complete/cancel/expire
- No pessimistic locking / `FOR UPDATE` (Phase 3)
- No expiration cleanup worker (Phase 5)
- No checkout/order transaction linking (Phase 6)
