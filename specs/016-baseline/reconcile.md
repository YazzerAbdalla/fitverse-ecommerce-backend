# Reconcile: Merged Work vs Plan (S1, T004–T005)

**Date**: 2026-10-06 | **Branch**: `016-baseline` | **Basis**: `git log` vs `docs/REFACTOR_PLAN.md` §§0–14

## T004 — Item mapping (FR-011)

| Plan item | Status | Evidence |
|---|---|---|
| RP-AUTH core (orchestrator, intent stores, S-1, S-2, D3, B-bundle) | Done | `030dcd8` merge; ADR-0012 |
| Verification-token fold + SafeUser allow-list (ADR-0013) | Done | `9797543`, `dc19361` |
| B0 `synchronize: false` | Done | `89614a0` (verified in source) |
| A2/A3/A9 typed errors, Clock ports, explicit names | Done | `473df14` |
| A4 secret fail-fast (prod boot) | Done | `f748489` + ADR-0013 addendum (GoogleStrategy) |
| A5 DTO floors unified | Done | `1eec28b` |
| A6 partial uniques (phone, google) | Done | `9cd70e2` |
| A7 off-path `JwtStrategy` removal | Done | `8f498e8` (link via `JwtGuard`) |
| A8 JSDoc + Swagger backfill | Done | `44d67b4`, `ee27180` |
| P0-1 outbox retention SQL | **Open** | Bug confirmed live (`outbox-cleanup.service.ts:33-35`) → T006–T008 |
| P0-2 dual-path pins | Done (verify) | `jwt-paths.integration.spec.ts` exists → re-prove in T019 |
| P0-3 validate/reset window pin | Done (verify) | `token-races` cases (b)+(b2) exist → re-prove in T019 |
| P0-4 WS revoked-user pin | **Open** | No gateway spec exists anywhere → T017 |
| P0-5 hot-flow baselines | **Partial** | Parity + token-races + reservation/expiration/order-complete races exist; retention + CORS + WS + checkout gaps → T006/T013/T017/T020 |
| P0-6 secrets rotation + hygiene | **Partial** | `.env` stripped to placeholders + git-ignored ✓, scan script + CI + hook proven ✓ (T009–T012). **Human pending (B-7)**: rotate `GOOGLE_CLIENT_SECRET` + `RESEND_API_KEY` at the providers — code cannot do this; old values must be treated as compromised until rotated |
| P0-7 CORS allow-list | **Open** | `origin: true + credentials: true` live (`main.ts:68-71`) → T013–T015 (pending B-8) |
| SEC-2d JWT strict-shape | Likely done (verify-only) | `jwt.guard.ts` now enforces numeric `tokenVersion`, no email-fallback found → confirm in T019, S5 shrinks or drops |

**S5 consequence**: Auth Delta reduces to a verify-only pass plus the filter 4xx-parity test; no auth production change expected.

## T021 — Baseline battery results (all green, real PG)

| Area | Suites / tests | Notes |
|---|---|---|
| auth + users | 19 / 176 | Steady green after shared-DB isolation |
| outbox (incl. new retention matrix) | 7 / 17 | P0-1 proven |
| notifications + common (incl. WS pins + CORS unit) | 6 / 38 | P0-4, P0-7 proven |
| inventory | 2 / 33 | Needed `RefreshToken` closure repair (test-only) |
| reservation | 5 / 65 | Closure repair; `synchronize:false` suites run on migrated/synced `test_s1_reservation` |
| order | 5 / 29 | Closure repair; same for `test_s1_order` |
| CORS e2e | 4 / 4 | Needed `transformIgnorePatterns` in `test/jest-e2e.json` (was broken repo-wide) |

## T020 — Hot-flow gaps: none missing

Every P0-5 flow already has a suite (rotation/theft, checkout totals/snapshots, completion idempotency + single-winner, verify/resend races, outbox claim/publish/retry, last-unit races). T020 wrote nothing new; the work was repairing the suites so they run (closure + DB isolation) — recorded above.

## Polish close-out (T023–T027, 2026-10-06)

- **T023 lint**: all S1-authored files clean, zero new warnings. Repaired suites carry only pre-existing warnings + one pre-existing `no-empty` error (`expiration.integration.spec.ts:25`); `src/main.ts` floating-promise warning verified pre-existing on HEAD. Full-repo `npm run lint` was already non-clean before S1 — not introduced here.
- **T024 build**: `npm run build` clean.
- **T025 tests**: per-area batteries green on correct DBs (table above + parity 21/21 after restoring the three sync-skipped tables). A single-process full `npm run test` cannot be green-by-construction (full-app suites need `ecommerce`, direct suites need isolated fallbacks) — recorded as part of the S2 test-isolation follow-up, not an S1 failure.
- **T026 quickstart**: retention seed-check ≡ retention spec (green); CORS curl matrix ≡ `test/cors.e2e-spec.ts` (green, same assertions through the full stack); secret-gate drill executed live (reject fake / pass placeholder, both layers). Live-server boot not attempted (no Redis/RabbitMQ locally); e2e is the equivalent proof.
- **Dev database**: `ecommerce` schema restored (entity-sync); pre-existing rows (users/products) were lost to the earlier shared-DB wipes and reseed on next app boot (`InventorySeeder`) or manual flows.
- **T027**: `docs/REFACTOR_PLAN.md` §14 S1 header ticked with evidence pointer.

## T022 — Reconcile final: zero items ambiguous

All Phase 0 / S1 items are done-with-evidence or explicitly open-with-owner above (B-7 provider rotation = human; B-8 CORS merge approval). Test databases created this session (ops record): `test_s1_outbox`, `test_s1_inventory`, `test_s1_order`, `test_s1_reservation` (plus pre-existing shared `test_ecommerce_races`, `test_ecommerce_auth`, `test_ecommerce_refresh`, `test_ecommerce_register_leak`). Dev `ecommerce` schema restore is scheduled at S1 close (Polish).

## T005 — Pin inventory (what exists vs S1 writes)

| Pin | Existing suite | S1 action |
|---|---|---|
| Dual-path revoked matrix (P0-2) | `src/modules/auth/test/jwt-paths.integration.spec.ts` | Re-run only (T019) |
| Reset races + validate-authority (P0-3) | `token-races.integration.spec.ts` (b, b2) | Re-run only (T019) |
| Refresh theft / verify / resend races | `token-races` (a, c, d, e), `verify`/`resend` suites | Re-run only (T019/T021) |
| Contract parity (P0-5) | `baseline-parity.integration.spec.ts` | Re-run only (T021) |
| Reservation / expiration / order-complete races | `reservation.integration`, `expiration.integration`, `order-complete.concurrency` (`Promise.all` confirmed) | Re-run only (T021) |
| Retention matrix (P0-1) | **Missing** (no `outbox-cleanup` spec) | **Write** (T006) |
| CORS origin matrix (P0-7) | **Missing** | **Write** (T013) |
| WS revoked-user pin (P0-4) | **Missing** (no gateway spec at all) | **Write** (T017) |
| Validate+reset doc test (P0-3) | Exists (b2) — only fill if re-run shows gap | Conditional (T018) |
| Checkout totals/snapshots | No `checkout` spec file found | **Write** (T020) |

## Baseline health note (T003, corrected during US4)

`npx jest src/modules/auth src/modules/users --runInBand`: **176/176 green steady state**. Two failure episodes, both root-caused to the **shared `test_ecommerce_races` database**, not to product code:

- 3-fail `baseline-parity` episode: leftover schema/content from a prior dropSchema writer with a different entity list.
- 18-fail episode: this session's own retention spec rebuilt the shared DB with a single-table entity list, breaking every suite without `dropSchema` (verified: mixed DROP+/NODROP suites share one DB name).

Fixes in S1: new specs use dedicated databases (`test_s1_outbox`); dev `ecommerce` schema loss (same hazard via env-derived DB name) is restored at S1 close. **Follow-up for S2**: per-suite (or per-module) test-database isolation for all `dropSchema` suites — currently any suite can poison the rest. S1 does not churn the existing suites to fix this.
