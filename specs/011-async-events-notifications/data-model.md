# Data Model: Transactional Outbox (Phase 11)

**Feature**: `011-async-events-notifications` | **Spec**: [spec.md](./spec.md) | **Research**: [research.md](./research.md) | **Date**: 2026-09-23

## Entity: OutboxEvent

**Table**: `outbox_event` — transient delivery buffer for at-least-once `order.*`/`reservation.expired` (not event sourcing). PostgreSQL 17 + TypeORM (`synchronize:false`, migration `17559xxxxxx-CreateOutboxEvent`).

```text
OutboxEvent
-----------
id                  uuid PK @PrimaryGeneratedColumn('uuid') // eventId, stable dedup key
eventType           varchar(64)  @Index  // 'order.created' | 'order.completed' | 'order.cancelled' | 'reservation.expired'
aggregateType       varchar(32)  @Index  // 'Order' | 'Reservation'
aggregateId         uuid         @Index  // Order.id or Reservation.id (no FK, see D6)
payload             jsonb  NOT NULL     // {version:1, eventId:id, eventType, occurredAt:ISO, correlationId, ...business} PII-free
status              enum OutboxStatus {PENDING, PROCESSING, SENT, FAILED} default PENDING @Index (composite)
attempts            int default 0  CHECK (attempts >= 0)
nextRetryAt         timestamptz NOT NULL default NOW() @Index (composite)
lastError           varchar(1000) nullable
processingStartedAt timestamptz nullable // set when claimed PROCESSING, for lease reclaim
createdAt           timestamptz @CreateDateColumn @Index
sentAt              timestamptz nullable // set when SENT
```

**TypeORM** (`src/modules/outbox/entities/outbox-event.entity.ts`):
```ts
@Entity('outbox_event')
@Index(['status', 'nextRetryAt', 'createdAt']) /* composite publisher query */
@Index(['eventType']) @Index(['aggregateId']) @Index(['createdAt'])
@Check(`"attempts" >= 0`) @Check(`"payload"->>'version' IS NOT NULL`)
export class OutboxEvent {
  @PrimaryGeneratedColumn('uuid') id: string;
  @Column({type: 'varchar', length: 64}) @Index() eventType: string;
  @Column({type: 'varchar', length: 32}) aggregateType: string;
  @Column({type: 'uuid'}) @Index() aggregateId: string;
  @Column({type: 'jsonb'}) payload: Record<string, unknown>; // {version, eventId, eventType, occurredAt, correlationId, orderId, userId, ...}
  @Column({type: 'enum', enum: OutboxStatus, default: OutboxStatus.PENDING}) status: OutboxStatus;
  @Column({type: 'int', default: 0}) attempts: number;
  @Column({type: 'timestamptz', default: () => 'NOW()'}) nextRetryAt: Date;
  @Column({type: 'varchar', length: 1000, nullable: true}) lastError: string | null;
  @Column({type: 'timestamptz', nullable: true}) processingStartedAt: Date | null;
  @CreateDateColumn({type: 'timestamptz'}) createdAt: Date;
  @Column({type: 'timestamptz', nullable: true}) sentAt: Date | null;
}
export enum OutboxStatus { PENDING='PENDING', PROCESSING='PROCESSING', SENT='SENT', FAILED='FAILED' }
```

### Constraints & Invariants

- `payload` MUST contain `payload.version==1`, `payload.eventId==id`, `payload.eventType==eventType`, `payload.occurredAt` ISO, `payload.correlationId` (from `X-Request-Id`/`X-Correlation-Id` or `randomUUID()` at controller). PII-free: only `orderId, userId, total, currency, items[{productId,inventoryId,quantity,unit_price}], reservationId, expiresAt, ...` — no `email`/`Authorization`.
- `status` lifecycle: `PENDING → PROCESSING → SENT` (success) or `PROCESSING → PENDING` (retry, `attempts++`, `nextRetryAt=NOW()+base*2^(attempts-1)` cap `60s`) until `attempts>=5` → `FAILED` (terminal, retained `30d` not deleted). Manual requeue: `UPDATE outbox_event SET status='PENDING', attempts=0, nextRetryAt=NOW(), lastError=NULL WHERE id=:id AND status='FAILED'`.
- `aggregateId` intentionally **no FOREIGN KEY** to `Order`/`Reservation` (research D6) to keep `outbox_event` retained when business row `DELETE CASCADE`; audit via `aggregateId` + `aggregateType`.
- `payload` is `jsonb` (not `json`) to allow `->>` index check.

### Indexes

```sql
CREATE TYPE outbox_status AS ENUM ('PENDING','PROCESSING','SENT','FAILED');
CREATE TABLE outbox_event (...);
CREATE INDEX idx_outbox_status_next_retry_at_created ON outbox_event (status, nextRetryAt, createdAt);
CREATE INDEX idx_outbox_event_type ON outbox_event (eventType);
CREATE INDEX idx_outbox_aggregate_id ON outbox_event (aggregateId);
CREATE INDEX idx_outbox_created_at ON outbox_event (createdAt DESC);
-- publisher query:
-- SELECT * FROM outbox_event WHERE (status='PENDING' AND nextRetryAt<=NOW())
--    OR (status='PROCESSING' AND processingStartedAt < NOW() - INTERVAL '30 seconds')
-- ORDER BY createdAt ASC, id ASC LIMIT :batchSize FOR UPDATE SKIP LOCKED
```

`EXPLAIN` must show `Bitmap Index Scan` on `idx_outbox_status_next_retry_at_created`, not seq scan.

### State Diagram

```text
PENDING --claim FOR UPDATE SKIP LOCKED--> PROCESSING --client.emit success--> SENT
   ^                                        |
   |   failure (ECONNREFUSED)               | failure → attempts++ nextRetryAt exponential
   +----------------------------------------+
                                            +-- attempts>=5 --> FAILED (retained)
FAILED --manual PATCH /admin/outbox/:id/requeue--> PENDING
PROCESSING (lease expired processingStartedAt < NOW()-30s) --reclaim next poll--> PROCESSING (fresh lease)
```

### Relationships (none FK)

- `OutboxEvent` is **not** a relation of `Order`/`Reservation`/`Inventory` — it is a separate bounded context `OutboxModule` (`src/modules/outbox/outbox.module.ts` `TypeOrmModule.forFeature([OutboxEvent])` `exports: [OutboxService]`). Business services import `OutboxModule` and call `OutboxService.createEvent(manager, ...)` inside their `DataSource.transaction`.

### Validation Rules (from spec FR-001..002)

- `POST /order/checkout` inside same `manager` inserts `order.created` **only if** commit will happen (no `400/409`); `payload` includes `orderId, userId, total, currency, items, reservationId, expiresAt, createdAt`, `version:1`.
- `POST /order/:id/complete` `PENDING→COMPLETED` inserts `order.completed` **before** saving `Order`/`Reservation` `COMPLETED`; idempotent `COMPLETED→COMPLETED` guards no duplicate row.
- `ReservationExpirationService.processExpiredBatch` per-candidate inserts `reservation.expired` + optionally `order.cancelled {reason:'expired'}` atomically with `RESERVED→EXPIRED` / `PENDING→CANCELLED`.
- `Payload` size <10KB JSONB (no unbounded batch).

## Entity: Order / Reservation / Inventory (existing, referenced for atomicity)

- Already in `src/modules/order/entities/order.entity.ts` (`status PENDING|COMPLETED|CANCELLED|FAILED`), `src/modules/reservation/entities/reservation.entity.ts` (`status RESERVED|COMPLETED|EXPIRED|CANCELLED`, `@Index(['status','expiresAt'])`), `src/modules/inventory/entities/inventory.entity.ts` (`stock, reservedAmount CHECK >=0 reserved<=stock`, `available=stock-reservedAmount` derived). No schema change; outbox is additive `INSERT` inside same `manager`.

## JSDoc Requirement (AGENTS.md §3)

- `@Entity('outbox_event') export class OutboxEvent` gets `/** This entity represents the transactional outbox for at-least-once domain events (order.*, reservation.expired). It handles durable buffering so business commit never depends on RabbitMQ. */`
- Every field needing invariant gets `//` intent: e.g., `// attempts tracks durable retry, not consumer retry` etc.
