---
name: testing
description: Unit, integration, and E2E testing conventions with Jest in this repo. Use when adding or fixing tests.
---

# Testing (Jest)

Read [`AGENTS.md` §6](../../AGENTS.md) for the rules. Config: Jest in
`package.json` (`rootDir: src`, `ts-jest`), e2e in `test/jest-e2e.json`.

## Run

```bash
npm run test          # unit (src/**/*.spec.ts)
npm run test:cov      # coverage
npm run test:e2e      # e2e (test/app.e2e-spec.ts via supertest)
```

## Unit tests

- Place `*.spec.ts` next to the code. Use `Test.createTestingModule`.
- Mock collaborators (repositories, other services) — do **not** hit the real DB.
- Current specs are mostly smoke tests ("should be defined"); upgrade them with
  real behavior assertions as logic is added.

## Integration tests

- Use a **real PostgreSQL** (or test container) for transactions, locking,
  constraints, and repository behavior. Don't assert consistency against mocks.
- Cover reservation creation, expiration, inventory release, order completion,
  DB constraints.

## E2E tests

- `test/app.e2e-spec.ts` + `supertest`. Cover full flows:
  register → login → add to cart → checkout → order → completion.

## Concurrency tests (required for inventory/reservation)

- Explicitly test "two users reserve the last available unit simultaneously → only
  one succeeds". The system must not oversell.

## Naming

- `describe(Service)` / `it('should <behavior>')`, matching existing style.
- Mock external infra (Redis, RabbitMQ) and other modules' services; do **not**
  mock the DB when testing consistency/locking/transactions.
