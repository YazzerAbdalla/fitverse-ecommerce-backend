# Quickstart: Inventory Foundation (Phase 1)

**Feature**: 001-inventory-foundation
**Prereqs**: Docker infrastructure up (`docker-compose up -d` → postgres, redis, rabbitmq). Node + NestJS dev env.

## Implementation order (smallest increment first)

1. **Entity** — create `src/modules/inventory/entities/inventory.entity.ts` with fields, `@Check` constraints, `@OneToOne` → `Product`, `available` getter.
2. **Product change** — remove `stock` column + its `@Check` from `product.entity.ts`; add inverse `@OneToOne(() => Inventory)` (read-only).
3. **Seed existing data** — add `InventorySeeder` (idempotent, runs once via `onModuleInit` in `InventoryModule`) that creates one `Inventory` per `Product`, copying `Product.stock` → `stock`, `reservedAmount = 0`. Run this step **before** removing the `Product.stock` column in code; on dev (`synchronize: true`) the column remains until step 2's entity change is applied, then drops on next boot.
4. **Service** — extend `InventoryService`:
   - `getInventory(productId)`, `checkAvailability(productId, qty)`, `increaseStock`, `decreaseStock` (real implementations on `Inventory` repository/`EntityManager`).
   - Redirect existing `decreaseStockForOrderMany` / `restoreStockForOrderMany` to operate on `Inventory` instead of `Product`.
   - Stub `reserve` / `releaseReservation` / `completeSale` with correct math (wired into transactions in Phase 3/4).
5. **DTOs** — `create-inventory.dto.ts`, `update-inventory.dto.ts` (increase/decrease with `quantity: int >= 1`), response DTO.
6. **Controller** — `inventory.controller.ts` implementing the routes in `contracts/inventory-api.md`; thin, delegates to service; protected with `@Auth`.
7. **Module** — `InventoryModule` imports `ProductsModule`, provides + **exports** `InventoryService`; register controller + entity repository.
8. **Tests**:
   - Unit: mock repository/`ProductsService`; assert service math and error throwing.
   - Integration (real PostgreSQL): assert `@Check` rejects `stock < 0`, `reservedAmount < 0`, `reservedAmount > stock`; assert `available = stock - reservedAmount`; assert one-inventory-per-product uniqueness.
9. **Docs** — update `AGENTS.md` (module map: inventory now has entity + API), add/refresh `docs/architecture/inventory.md`, record the `Product.stock` removal decision as an ADR in `docs/decisions/`.
10. **Production migration** — before prod, disable `synchronize` and add a TypeORM migration (create `Inventory`, seed from `Product.stock`, drop `Product.stock`). Never edit committed migrations.

## Verification

```bash
npm run lint
npm run build
npm run test          # unit + integration
npm run test:e2e      # optional full-flow smoke
```

## Key risks / reminders
- Seed **before** dropping `Product.stock` to avoid data loss.
- `available` is derived; never persist it as a mutable column.
- Other modules must call `InventoryService`, never `@InjectRepository(Inventory)`.
- Concurrency/locking is Phase 3 — do not add pessimistic locking here.
