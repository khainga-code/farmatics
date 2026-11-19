# Phase 7 - Reports and analytics

The owner could see today's state on the dashboard and the cash book in
Finance, but could not ask "how did the last thirty days go?" or "which
salesperson still has birds out?" without adding up screens by hand. Phase 7
turns the records already on the phone into a period report, with exports and a
printable copy.

There are no new tables, endpoints or sync changes. Every figure is derived
from the events the phone already holds, so the report opens offline and is as
fresh as the last sync.

## What the report shows

| Section | Figures |
| --- | --- |
| Summary | Birds sold, deaths and mortality rate, feed used; money in, money out and net when allowed |
| Batch performance | Live birds now; deaths, sales, feed and money for the period, per batch |
| Mortality | Deaths by cause and by batch, with each batch's rate |
| Money in and out | Revenue and approved spend per day or week, spend by category, expenses still awaiting a decision |
| Salespeople | Handovers, birds allocated, sold and returned, still out, feed, and revenue when allowed |

"Live birds" is a snapshot of the flock now. Every other figure is scoped to
the chosen period, so a closed batch keeps its history while a new one starts
from zero.

## Periods

| Choice | Range |
| --- | --- |
| This month | The first of the current month to today |
| Last 7 days | Today and the six days before it |
| Last 30 days | Today and the twenty-nine days before it |
| Last 90 days | Today and the eighty-nine days before it |

Periods are inclusive ranges of calendar days, grouped by the UTC day of each
event's `recordedAt`. This matches how the rest of the app judges a sale: by the
day it happened, not the day the phone reconnected. The choice lives in the URL
(`/reports?period=last30`), so a report can be bookmarked or revisited, and the
default is the current month.

The money trend uses one bar pair per day for the seven-day view. Longer views
use Monday-based weeks, with the first and last weeks clipped to the period.

## Rules the figures follow

- Revenue counts priced sales only. An unpriced sale is counted in birds sold,
  reported as unpriced, and never treated as zero. The summary says how many
  such sales are in the period.
- Spend counts approved expenses only. Pending and rejected expenses are not
  money out; pending ones are counted and named separately.
- Feed used is the feed issued to batches in the period, in kilograms,
  including feed sent out with a salesperson's allocation. Purchases into the
  store are not usage.
- A batch's margin is revenue minus expenses tagged to that batch. Feed cost is
  still not included, because feed is recorded in kilograms rather than
  shillings.
- Batch numbers are derived from the same events as the rest of the app:
  initial count, mortality, transfers, and sales. Allocations and returns move
  no birds out of a batch; only a sale does.
- The mortality rate is the period's deaths divided by the birds at risk when
  the period began, plus birds transferred in during it. A batch that arrived
  inside the period starts from its initial count. A rate with no birds at risk
  is shown as a dash, not zero.
- "Still out" for a salesperson is the derived allocation balance now
  (`allocated - sold - returned`), while handovers and sales cover the period.

## Who sees money

The Reports route requires `view_reports`. Money inside the report follows the
same permission as the cash book: `view_finance` or `record_expense`.

The calculation is skipped entirely when finance is hidden. A member with
`view_reports` but no finance permission sees no money summary, no money
section, no price columns and no price columns in a CSV export - the figures
are never built, so they cannot leak into the DOM or a downloaded file. Sales
prices still arrive on the phone because bird counts drive every batch balance;
the report's gate is explicit rather than relying on the data being absent.

## Exports

Four CSV exports sit beside their sections: batch performance, mortality by
cause, approved spend by category, and salespeople. A filename carries the
report and the period, for example
`farmatics-batch-performance-2026-08-18-to-2026-11-15.csv`.

Cells are quoted when they contain a comma, quote or newline, rows end in CRLF
and the file ends with a newline. A string that begins with `=`, `+`, `-`, `@`,
tab or carriage return is prefixed with an apostrophe, so a buyer name or note
cannot become a spreadsheet formula. Negative numbers are written as numbers,
not escaped text.

The file is created in the browser from the report already on screen and saved
through a temporary object URL. No server round trip is involved, so export
works offline. Finance columns are omitted from an export when the member
cannot see finance.

## Printing

The Print button opens the browser's print dialog. Print styles hide the app
header, module tabs, phone tab bar, period controls and actions, and show a
small farm-and-period line instead. Cards avoid breaking across pages, tables
tighten up, and each trend pair prints its two amounts because the bars alone
are not readable on paper.

## On a phone

The report tables scroll horizontally inside their card rather than making the
page scroll. The module tab bar shrinks its icons and labels at 420px and below;
seven tabs fit a 320px phone without overflowing or truncating a label.

## Files

| File | Purpose |
| --- | --- |
| `apps/web/src/reports.ts` | Pure period and report builder |
| `apps/web/src/money.ts` | Adds the inclusive `rangeMoney` selector used by the report |
| `apps/web/src/csv.ts` | CSV escaping, formula defence, filenames |
| `apps/web/src/download.ts` | Browser download of generated text |
| `apps/web/src/team.ts` | Cached employee names shared by Sales and Reports |
| `apps/web/src/pages/ReportsPage.tsx` | Screen, period picker, exports, print |
| `apps/web/src/components/TrendBars.tsx` | CSS-only money bars |
| `apps/web/test/reports.test.ts` | Report arithmetic and privacy |
| `apps/web/test/csv.test.ts` | Escaping and filenames |
| `apps/web/test/money.test.ts` | Period selectors, including the new range |

`reports.ts` imports types only from `local.ts`, so it can be tested without a
DOM or IndexedDB.

## Verification

```
pnpm typecheck                     5 packages
pnpm test                          web 44, api 77 (plus shared, sync and db)
web build                          production bundle and generated service worker
```

The 17 report tests cover period edges and a year crossing, summary and batch
arithmetic, mortality causes and denominators, finance privacy with null
fields, category totals and zero-filled weekly buckets, pending expenses,
salesperson aggregation, closed batches and feed-per-bird.

The screen was also exercised in a browser against a temporary stub API:

- This month, last 7, last 30 and last 90 days matched hand calculations from
  the seeded events, including the unpriced sale, the pending expense and the
  weekly buckets.
- With the API stopped, a reload fell back to the saved session, the PIN
  unlocked it, and the report rendered from the phone's copy.
- Downloaded CSVs had the expected names, CRLF rows and columns; a member
  without finance received no price columns, and the page contained no "KES".
- Under print media, the header, tabs, tab bar, toolbar and actions computed to
  `display: none`, while the print-only line and cards remained.
- At 320px and 360px iframe viewports the page did not scroll sideways, and
  seven tab-bar items fit without overflow.

## Still open

- Reports are read-only and never stored; there is no scheduled email, server
  PDF or snapshot of "the October report" as it looked at month end.
- Days are grouped in UTC, not the farm's local timezone. An event recorded
  just after local midnight can land in the previous UTC day.
- There is no year-over-year comparison, custom date range or per-house filter.
- Feed cost in margin and weight recording were built in Phase 9.
- Goat and cattle management remain unbuilt.
