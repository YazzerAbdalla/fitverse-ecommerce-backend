# Data Model: Inventory Foundation (Phase 1)

**Feature**: 001-inventory-foundation
**Source**: [spec.md](./spec.md), [research.md](./research.md)

## Entities

### Inventory (NEW)

Owns inventory state for exactly one Product. Lives in `src/modules/inventory/entities/inventory.entity.ts`.

| Field | Type | Constraints | Notes |
| --- | --- | --- | --- |
| `id` | `uuid` | `@PrimaryGeneratedColumn('uuid')`, PK | UUIDv4 |
| `productId` | `uuid` | `@Column()`, `@Unique`, `@Index()`, FK → `Product.id` | Owning side of one-to-one; `product_id` column in DB |
| `stock` | `number` | `@Column()`, `@Check('"stock" >= 0')`, NOT NULL, default 0 | Physical stock; authoritative |
| `reservedAmount` | `number` | `@Column()`, `@Check('"reserved_amount" >= 0')`, `@Check('"reserved_amount" <= stock')`, NOT NULL, default 0 | Temporarily reserved (used from Phase 2) |
| `createdAt` | `Date` | `@CreateDateColumn()` | |
| `updatedAt` | `Date` | `@UpdateDateColumn()` | |

**Derived value** (not stored):
- `available` = `stock - reservedAmount` (exposed via a getter / `@VirtualColumn`; never a mutable column).

**Relations**:
```text
Inventory (owns FK productId)
   └── @OneToOne(() => Product) @JoinColumn() product
Product
   └── @OneToOne(() => Inventory) inventory   (optional inverse, read-only)
```

**Validation rules (DB-level, per spec FR2)**:
1. `stock >= 0`
2. `reserved_amount >= 0`
3. `reserved_amount <= stock`

**Invariant**: `available = stock - reserved_amount` is always consistent by construction.

### Product (MODIFIED)

File: `src/modules/products/entities/product.entity.ts`

- **Remove** the `stock` column and its `@Check('"stock" >= 0')` (lines 37-39 of current entity).
- Keep `@OneToOne(() => Inventory)` inverse relation (read-only navigation), added in this phase.
- All other columns (`name`, `slug`, `description`, `price`, `created_at`, relations to `OrderItem`/`CartItem`) unchanged.

## State transitions

None in Phase 1 (no reservation lifecycle yet). `reservedAmount` is initialized to 0 and only mutated by later phases' reserve/release/complete operations (defined in research R5 for later wiring).

## Seed / migration data shape

One `Inventory` row per existing `Product`:
```text
Inventory { productId = product.id, stock = product.stock (current), reservedAmount = 0 }
```
New products: `stock` from creation input (default 0), `reservedAmount = 0`.

## Indexes

- `Inventory.productId` — unique + indexed (access pattern: lookup inventory by product; see `docs/plan.md` §13).

## Constraints summary

| Entity | Constraint | Mechanism |
| --- | --- | --- |
| Inventory | stock >= 0 | `@Check` |
| Inventory | reserved_amount >= 0 | `@Check` |
| Inventory | reserved_amount <= stock | `@Check` |
| Inventory | one inventory per product | `@Unique(productId)` |
