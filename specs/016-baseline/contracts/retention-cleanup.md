# Contract: Outbox Retention Cleanup (S1, P0-1)

**Behavior class**: `[B]` bug fix — approved in `docs/REFACTOR_PLAN.md` §13 P0-1 / Appendix B. Ships as a single-purpose commit (FR-002).

## Current (wrong) behavior

`DELETE FROM outbox_event WHERE (status = $1 AND sentAt < … * $2) OR (status = $2 AND createdAt < … * $2)` with params `['SENT', retentionDays]` — three stacked defects found during implementation:

1. `$2` binds a day-count where a status is compared, so the second arm never matches (deletes nothing by design).
2. Unquoted `sentAt`/`createdAt` fold to `sentat`/`createdat`, which do not exist — the statement actually **throws** `QueryFailedError` on every run.
3. `dataSource.query()` returns `[rows, rowCount]` for `DELETE`, but the code reads `.rowCount` off the array → `undefined ?? 0`, so even a working delete would always report `0`.

## Corrected behavior

One `DELETE` matching expired terminal rows only:

- Statuses: `SENT`, `SENT_TO_MQ`, `CONSUMED`, `DELIVERED` age on `COALESCE(sentAt, createdAt)`; `FAILED` age on `createdAt`.
- Age cutoff: `NOW() - INTERVAL '1 day' * retentionDays` (`OUTBOX_RETENTION_DAYS`, default `30`, clamped `1..365` — unchanged).
- `PENDING` / `PROCESSING` rows never match, at any age.
- Returns the deleted count; logs `outbox cleanup retention <n>d deleted <count>` (unchanged shape).

## Regression matrix (all in one real-DB test)

| # | Seeded row | Expected after `cleanup()` |
|---|---|---|
| 1 | `SENT`, `sentAt` 31d ago | deleted |
| 2 | `SENT_TO_MQ`, `sentAt` 31d ago | deleted |
| 3 | `CONSUMED`, `sentAt` 31d ago | deleted |
| 4 | `DELIVERED`, `sentAt` 31d ago | deleted |
| 5 | `FAILED`, `createdAt` 31d ago | deleted |
| 6 | `SENT_TO_MQ`, `sentAt` 1h ago | preserved |
| 7 | `PENDING`, `createdAt` 60d ago | preserved |
| 8 | `PROCESSING`, `createdAt` 60d ago | preserved |
| 9 | empty table | `0`, no error |
