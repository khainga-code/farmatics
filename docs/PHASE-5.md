# Phase 5 - Health monitoring and phone-level privacy

Phase 5 adds the health module the farm asked for, records what is killing
birds, and stops the cash book from travelling to phones that have no business
reading it. It also moves the money arithmetic out of two screens and into one
tested module, and adds CI.

## Health rules

Every figure is derived from events already on the phone; nothing stores a rate
or a status.

| Rule | Value |
| --- | --- |
| First week | Days 1 to 7, where arrival is day 1 (`arrival + 6`) |
| First-week alert | 2% or more of the birds that arrived |
| Cumulative alert | 5% or more of the birds that arrived |
| Last seven days | Inclusive window ending today |
| Survival | `initial - deaths` as a percentage of `initial` |
| Vaccination on time | Recorded on or before its due date (day 12 or day 21) |
| Vaccination late | Recorded after the due date; still counted as cover |
| Vaccination pending / overdue | Not recorded, before / after the due date |

A dose is never inferred from another dose: each scheduled day is matched
against its own event. A batch with no mortality divides by its arrival count,
never by zero.

Deaths may be tagged with a fixed category (`disease`, `heat`, `cold`,
`predator`, `injury`, `culling`, `unknown`). Rows recorded before the category
existed stay uncategorised; they are shown as "Uncategorised", never guessed or
rewritten.

## What a phone may pull

The pull was farm-wide: every member received every row. Finance is now the
exception. `expenses` and `expense_approvals` declare `readPermissions`, and a
pull skips a table when the caller holds none of them. A stock keeper's or
salesperson's phone therefore never receives the cash book at all - it is not a
hidden screen over hidden data.

`bird_sales` is deliberately still pulled by everyone: the bird count drives
every batch balance, so a salesperson must see sales to know what is left. The
sale price travels with it and is visible. That trade is recorded as an open
item below.

Hidden navigation is not a guard. `/finance` also refuses to open without
`view_finance` or `record_expense`, and `/health` without `record_mortality` or
`view_reports`.

When a phone's rights, person or farm change, its local copy is rebuilt:

1. queued work is pushed first, and nothing is dropped if that fails or
   anything is still pending;
2. the local records and the pull cursor are cleared;
3. the farm is pulled again with the new permissions.

The outbox is never touched by the reset, so a permission change cannot lose a
write recorded in the field. Offline, the phone keeps the copy it has and tries
again on the next refresh.

## Data

No new tables. Migration `0007_health.sql` adds `mortality_events.cause_category`
with a check constraint and an index on `(farm_id, recorded_at)` for the
first-week and last-seven-days windows. Older rows keep a null category.

## Screens

- **Health** (`/health`) lists every active batch: alert state and reasons,
  deaths, first-week and last-seven-day losses, mortality and survival,
  vaccination status per dose, and the cause mix. Alerts are listed first.
- The mortality form on a batch now captures the category and the optional
  detail; the batch history shows both.
- Home and Finance use one `money.ts` module for day and month totals, so the
  two screens cannot drift.

## Verification

```
packages/shared   59 tests   includes 12 health tests
packages/sync     17 tests   includes the reset that keeps queued work
apps/web           7 tests   money day/month totals, unpriced sales, approvals
apps/api           4 pull-access tests written over the real endpoints
typecheck          shared, db, sync, api, web
build              web production bundle
```

The pull-access tests cover the owner, farm manager, stock keeper and
salesperson. As in Phases 3 and 4, this machine cannot start PGlite
(`RangeError: Array buffer allocation failed`), so the API files must be run on
a machine with more memory before they are trusted. CI runs them serially on a
standard runner.

CI lives in `.github/workflows/ci.yml`: install, typecheck, then shared, db,
sync, API and web tests one package at a time.

## Still open

- Goat and cattle management, reports and the goat/cattle health schedule are
  unbuilt; this health module covers the broiler schedule.
- Sale prices are visible to every role because bird counts are. A stricter
  split (price on a finance-only table) is not built.
- Per-account throttling and service-worker cache busting are built in Phase 6.
- Commission, salesperson targets, credit sales and receivables are out of
  scope.
