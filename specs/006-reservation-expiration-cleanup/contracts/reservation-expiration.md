# Contracts — Reservation Expiration Cleanup (Phase 5)

**Branch**: `006-reservation-expiration-cleanup` | **Spec**: [spec.md](../spec.md) | **Plan**: [plan.md](../plan.md)

No new REST endpoint in Phase 5 — manual `PATCH /reservations/:id/expire` (admin, immediate override) is unchanged from Phase 4. This document contracts the **internal BullMQ job** and the **RabbitMQ domain event** introduced by clarifications Q2/Q3.

---

## 1. BullMQ Job — `reservation-expiration` repeat

### Queue

```text
Queue name: reservation-expiration
BullMQ: @nestjs/bullmq BullModule.registerQueue({name:'reservation-expiration'})
Redis: ioredis via REDIS_URL (same as CacheModule)
Repeat: every EXPIRATION_INTERVAL_MS (default 30000) — or EXPIRATION_CRON / BULLMQ_REPEAT cron string; default repeat 30s to meet 60s SLA (Q1)
Job singleton: jobId = 'reservation-expiration-tick' (job deduplication, Q4)
Enabled: EXPIRATION_ENABLED (boolean, default true) — when false, processor short-circuits without scan but queue remains
Concurrency: 1 (@Processor concurrency guard, non-overlapping ticks, Q4)
```

### Job payload

```typescript
// Tick job has no payload — scan discovers candidates
interface ReservationExpirationTickJob {
  // empty: processor calls service.processExpiredBatch(EXPIRATION_BATCH_SIZE)
}
```

### Processor

```typescript
@Processor('reservation-expiration', { concurrency: 1 })
export class ReservationExpirationProcessor {
  @Inject(ReservationExpirationService) private readonly service: ReservationExpirationService;
  private readonly logger = new Logger(ReservationExpirationProcessor.name);
  private processing = false;

  @Process('reservation-expiration-tick') // or default processor handle
  async handleRepeat(job: Job<ReservationExpirationTickJob>): Promise<{
    scanned: number; expired: number; skipped: number; failed: number; retried: number;
  }> {
    if (process.env.EXPIRATION_ENABLED === 'false') { logger.log('expiration disabled'); return {scanned:0,expired:0,skipped:0,failed:0,retried:0}; }
    if (this.processing) { logger.debug('skip overlapping tick'); return {scanned:0,expired:0,skipped:0,failed:0,retried:0}; }
    this.processing = true;
    try { return await this.service.processExpiredBatch(+process.env.EXPIRATION_BATCH_SIZE || 10); }
    finally { this.processing = false; }
  }
}
```

### Error handling

```text
- Per-candidate failure (404, 409 CHECK, concurrent winner) → catch, increment failureCount map, log warn/error, continue batch (FR-007, D7). After EXPIRATION_MAX_RETRIES (default 3) for same reservationId → skip further auto-retries until manual fix.
- Batch-level failure (Redis down, BullMQ queue error) → log error, return failed count, repeat will retry next interval (repeat persisted in Redis, D2).
- No HTTP status — internal. Observability via Logger per FR-009 (tick summary log).
```

### Registration

```typescript
// AppModule
BullModule.forRootAsync({
  imports: [ConfigModule],
  inject: [ConfigService],
  useFactory: (cfg: ConfigService) => ({
    connection: { host: cfg.get('REDIS_HOST','127.0.0.1'), port: +cfg.get('REDIS_PORT',6379), url: cfg.get('REDIS_URL') },
  }),
}),
BullModule.registerQueue({ name: 'reservation-expiration' }),
ClientsModule.registerAsync([{ name:'NOTIFICATION_SERVICE', ... }]), // already present
```

### Existing REST (unchanged, for reference)

```text
PATCH /reservations/:id/expire
  Auth: @Auth(UserRoles.Admin) — admin-only, immediate override (FR-004, D3)
  Request: no body
  Success: 200 { id, status: EXPIRED, expiresAt, items: [...] }
  Errors: 404 (not found), 409 (invalid transition), 403 (non-admin), 500 (CHECK) mapped to 409
  Note: Does NOT enforce expiresAt <= NOW() — any RESERVED may be expired immediately
```

---

## 2. RabbitMQ Domain Event — `reservation.expired` (Q3)

### Transport

```text
Transport: Transport.RMQ (already NOTIFICATION_SERVICE in AppModule)
Exchange/queue: notification_queue (via ClientsModule, durable:true, urls:[RABBITMQ_URL])
Pattern: 'reservation.expired' (emit, not request/response)
Timing: published ONLY after per-reservation DB COMMIT (FR-003), outside the FOR UPDATE transaction
Failure: try/catch around client.emit(...), log error with reservationId, do NOT roll back — at-most-once
```

### Payload

```typescript
interface ReservationExpiredEvent {
  reservationId: string;        // uuid, Reservation.id
  userId: string;               // uuid, Reservation.userId
  expiredAt: string;            // ISO 8601, commit time (new Date().toISOString())
  expiresAt: string;            // ISO 8601, original Reservation.expiresAt
  inventoryIds: string[];        // uuid[], sorted lexicographically
  items: { inventoryId: string; quantity: number }[]; // per ReservationItem
  status: 'EXPIRED';             // canonical
}
```

### Publisher (inside ReservationExpirationService)

```typescript
// after COMMIT succeeded in expireOne(manager, id)
const payload: ReservationExpiredEvent = {
  reservationId: reservation.id,
  userId: reservation.userId,
  expiredAt: new Date().toISOString(),
  expiresAt: reservation.expiresAt.toISOString(),
  inventoryIds: sortedIds,
  items: reservation.items.map(i => ({ inventoryId: i.inventoryId, quantity: i.quantity })),
  status: 'EXPIRED',
};
try {
  this.client.emit('reservation.expired', payload).subscribe({
    error: (e) => this.logger.error(`reservation.expired emit failed for ${reservation.id}: ${e.message}`, e.stack),
  });
  // fire-and-forget is acceptable; subscribe ensures error callback; no await required for SLA
  this.logger.debug(`reservation.expired emitted for ${reservation.id}`);
} catch (e) {
  this.logger.error(`reservation.expired emit threw for ${reservation.id}: ${e.message}`, e.stack);
}
```

### Consumer (out of scope for Phase 5, for reference)

```text
Phase 11 will add @MessagePattern('reservation.expired') consumers (notification worker, email, analytics).
Phase 5 does not require a consumer — the event is emitted for future consumers and for integration-test assertion (mock ClientProxy asserts emit called).
Tests: mock NOTIFICATION_SERVICE ClientProxy and assert emit('reservation.expired', expect.objectContaining({reservationId, status:'EXPIRED'})) called exactly once per successful expiration; failed expirations do not emit.
```

---

## 3. Service Method — `processExpiredBatch`

### Signature

```typescript
@Injectable()
export class ReservationExpirationService {
  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    @Inject('NOTIFICATION_SERVICE') private readonly client: ClientProxy,
  ) {}

  // Read-only scan, outside tx
  async findExpiredCandidateIds(limit: number): Promise<string[]> {
    // SELECT id FROM reservation WHERE status='RESERVED' AND expiresAt <= NOW() ORDER BY expiresAt ASC, id ASC LIMIT :limit
  }

  // Single-candidate transactional unit (reuses ReservationService helper)
  async expireOne(manager: EntityManager, reservationId: string): Promise<Reservation> {
    // delegates to reservationService.transitionWithInventoryInternal(manager, null, id, EXPIRED, ..., false)
  }

  // Batch orchestrator — internal contract, not HTTP
  async processExpiredBatch(limit = 10): Promise<{
    scanned: number;
    expired: number;
    skipped: number;
    failed: number;
    retried: number;
  }>

  // Optional for tests: drain all
  async processAll(batchSize = 10): Promise<{ scanned: number; expired: number }>
}
```

### Behavior contract

```text
- Scan: findExpiredCandidateIds(limit) without FOR UPDATE, deterministic ordering
- Loop: for each id, try { await dataSource.transaction(manager => expireOne(manager,id)); publish RabbitMQ } catch { increment retry map, log, count failed, continue }
- Poison: after EXPIRATION_MAX_RETRIES failures for same id, skip further retries until data fixed; every retry logged; batch always continues
- Return: counts for logging/metrics and for integration-test assertions
```

### Batch example (integration test)

```typescript
// 25 expired RESERVED across 5 inventories, batchSize 10
const r1 = await reservationExpirationService.processExpiredBatch(10); // {scanned:10, expired:10, ...}
const r2 = await reservationExpirationService.processExpiredBatch(10); // {scanned:10, expired:10}
const r3 = await reservationExpirationService.processExpiredBatch(10); // {scanned:5, expired:5}
expect(r1.expired + r2.expired + r3.expired).toBe(25);
```

---

## 4. Error Mapping (no new HTTP errors — worker is internal)

| Cause | Logged As | Batch Effect | HTTP (manual path only) |
|-------|-----------|--------------|-------------------------|
| Candidate not found / already deleted | warn `reservation <id> not found` | failed++ continue | 404 |
| Status != RESERVED after FOR UPDATE (concurrent winner) | debug `skip <id> status=<actual>` | skipped++ continue | — (internal skip) |
| Inventory missing | warn `Inventory <id> not found` | failed++ continue, retry counted | 404 (manual) |
| CHECK violation (reservedAmount) | error `Inventory invariant violation ...` | failed++ continue, retry counted | 409 |
| RabbitMQ emit failure | error `reservation.expired emit failed for <id>` | expired still counted, not rolled back | — |
| Redis/BullMQ queue unavailable | error `reservation-expiration queue error` | failed batch, next repeat retries | — |
