# Quickstart: Cache Constraints Indexes

**Branch**: `020-cache-constraints-indexes` | **Time**: ~0.5 day | **Infra**: `docker-compose up -d` (PG 5432, Redis 6379)

## 1. Audit first (blocking for migration)

```bash
# violation counts (expect 0 before adding CHECKs)
docker exec -it mini-e-commerce-postgres-1 psql -U postgres -d ecommerce \
  -c "SELECT COUNT(*) FROM \"Product\" WHERE price < 0;" \
  -c "SELECT COUNT(*) FROM \"order\" WHERE total < 0;"
# EXPLAIN hot paths (record plans in data-model.md)
docker exec -it mini-e-commerce-postgres-1 psql -U postgres -d ecommerce \
  -c "EXPLAIN SELECT * FROM reservation WHERE status='RESERVED' AND \"expiresAt\" <= NOW() ORDER BY \"expiresAt\", id LIMIT 10;"
```

## 2. Implement (plan D1–D2)

- `products.service.ts`: delete both `clear()` paths → version-stamp fallback; add `ORDER BY created_at, id`; document TTL ms defaults.
- `product.entity.ts` (+ audit findings): add `@Check`s / `@Index`es.
- `src/migration/1755900000013-*.ts`: guarded additive DDL; run migration.

## 3. Verify

```bash
npm run lint && npm run build
npm run test -- --runInBand src/modules/products
# real-infra suites (need docker up):
npm run test -- --runInBand src/modules/products/test/products-cache.integration.spec.ts
# namespace proof: seed rl:/expiration:/notification: keys, mutate products, assert intact
# never-authoritative: checkout identical with Redis warm / cold / down
npm run test:e2e
```

## 4. Close out

Tick `docs/plan.md` Phase 9 tasks + Phase 13 exit (2–3 indexes + EXPLAIN evidence), add decision note.
