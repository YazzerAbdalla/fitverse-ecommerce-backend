# Quickstart: Verify S1 (Reconcile + Baseline)

**Scope**: `specs/016-baseline` — run these after `/speckit.tasks` + `/speckit.implement`, before closing S1.

## 0. Preconditions

```bash
docker-compose up -d        # postgres 5432, redis 6379, rabbitmq 5672
npm ci
git checkout 016-baseline
```

S1 does not close on skipped infra-dependent suites — they must run green against live services.

## 1. Retention fix (P0-1, isolated commit first)

```bash
npm run build
npx jest src/modules/outbox/test --runInBand   # includes the new retention matrix (contracts/retention-cleanup.md)
```

Confirm: seeded old-terminal rows gone, fresh + non-terminal preserved, empty table → `0`.

## 2. CORS allow-list (P0-7)

```bash
FRONTEND_URL=http://localhost:3000 CORS_ORIGINS=https://admin.example.com npm run start:dev
curl -sI -H "Origin: http://localhost:3000" http://localhost:3000/order    # allow-origin echoes + credentials
curl -sI -H "Origin: https://evil.example" http://localhost:3000/order    # no credentialed access
curl -sI http://localhost:3000/order                                        # no Origin → served normally
```

## 3. Secrets hygiene (P0-6, human steps + gates)

```bash
git check-ignore .env                          # must print ".env"
diff <(grep -v '^#' .env | grep -v '^$') <(echo '(placeholders only)')  # eyeball: no live values
./scripts/scan-secrets                         # exit 0 on placeholders; plant a fake re_ key → exit non-zero naming the pattern
```

Provider-side rotation (Google + Resend) is a human operator step recorded in the reconcile checklist — code cannot do it.

## 4. Pins + baselines (P0-2–P0-5, zero prod change)

```bash
npx jest src/modules/auth src/modules/users --runInBand   # jwt-path pins, token races, verify/resend, parity
npm run test -- --runInBand                               # full unit+integration green
```

Confirm: no production file outside the two approved deltas (P0-1, P0-7) shows a behavior diff; the reconcile checklist (`tasks.md` gate) marks every Phase 0/S1 item done-with-evidence or open.

## 5. Close-out gates

```bash
npm run lint && npm run build && npm run test && npm run test:e2e  # relevant suites green
```

Then tick `docs/REFACTOR_PLAN.md` S1 checkboxes with evidence (files, behavior delta, tests) and proceed to S2.
