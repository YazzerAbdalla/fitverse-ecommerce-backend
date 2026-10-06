# Contract: CORS Allow-List (S1, P0-7)

**Behavior class**: `[S]` security fix — approved in `docs/REFACTOR_PLAN.md` §13 P0-7 / Appendix B-8. One-line-class change + test.

## Current (wrong) behavior

`app.enableCors({ origin: true, credentials: true })` (`src/main.ts:68-71`) reflects any requesting origin while allowing credentials → credentialed cross-site request forgery.

## Corrected behavior

- `origin` = `[FRONTEND_URL, ...CORS_ORIGINS]` (trimmed, empties dropped); `credentials: true` retained, now scoped to listed origins only.
- Requests with no `Origin` header bypass the list (non-browser clients unaffected — FR-006).
- Neither variable set → production fails closed (no credentialed origins) with a boot `Logger.warn`; development warns and continues.
- New variable documented in `.env.example` (`CORS_ORIGINS=` empty default, same placeholder convention as neighboring keys).

## Test matrix

| # | Request origin | Credentials | Expected |
|---|---|---|---|
| 1 | Listed (`FRONTEND_URL` value) | yes | accepted, `Access-Control-Allow-Origin` echoes origin, `Allow-Credentials: true` |
| 2 | Listed (second entry via `CORS_ORIGINS`) | yes | accepted as in 1 |
| 3 | Unlisted (`https://evil.example`) | yes | rejected (no credentialed access) |
| 4 | No `Origin` header | n/a | served normally |
