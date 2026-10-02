# Quickstart: Verifying the Auth + Users Refactor

**Feature**: `specs/015-auth-user-refactor` | **Date**: 2026-10-02

## 0. Prerequisites

```bash
docker-compose up -d        # postgres 5432, redis 6379, rabbitmq 5672
npm ci
cp .env.example .env        # never commit .env
```

## 1. Capture the baseline (before ANY structural change)

```bash
npm run build
npm run test -- --runInBand src/modules/auth src/modules/users
```

Confirm the baseline commit contains: the full contract matrix
(`contracts/auth-user-parity.md` — every route × success + error cases, with
cookie/header assertions), the dual-JWT-path 401 matrix (revoked user under
`JwtGuard` vs `JwtStrategy`), the `register.data.password`-present proof, and
the `Promise.all` single-winner suites (refresh/reset/verify reuse) on real PG.

## 2. Implement slice by slice (plan.md order)

After each slice: diff observable behavior against the baseline
(`git stash` comparison or recorded fixtures) — any delta outside the three
approved `[S]` rows (S-1 revocation denial, S-2 authority recheck, D3 password-key
strip) is a defect. Then:

```bash
npm run lint
npm run build
npm run test -- --runInBand src/modules/auth src/modules/users
```

Races re-run wherever locking was touched. Query-shape diffs are signals (PQ-1),
not gates.

## 3. Static boundary checks (spec SC-004)

```bash
# expect zero hits after the UsersService + store migration
grep -rn "getRepository(User)" src/modules/auth/
# expect zero hits (controllers own no tx/persistence)
grep -rn "dataSource.transaction\|EntityManager\|@InjectRepository" src/modules/auth/auth.controller.ts src/modules/users/users.controller.ts
# expect zero hits (no broker/cache inside domain tx)
grep -rn "console.log" src/modules/auth/auth.controller.ts src/modules/auth/auth.service.ts
```

## 4. Done when

Contract matrix green incl. the three `[S]` regression tests, race suites green,
gates green, JSDoc + intent comments per AGENTS.md §3 on every touched
class/method, and the S-1/S-2/D3 deltas documented with their tests.
