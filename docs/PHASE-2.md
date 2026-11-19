# Phase 2 — Poultry and feed

The client's first module choice is poultry with the feed store. Everything is
built on the Phase 1 offline and sync foundation: a phone records work first and
the server reconciles later.

## The rules the farm asked for

| Rule | How it is implemented |
| --- | --- |
| Feed is measured in kilograms | `stock_items.unit` is fixed to `kg`; every movement carries `quantity_kg` |
| A batch starts at arrival | `batches.arrival_date`; arrival date is day 1 |
| Brooding runs for 21 days | Day 1 to day 21 inclusive |
| Sales start on day 22 | `saleOpensOn()` and the API both refuse an earlier sale |
| Vaccinations on day 12 and day 21 | `vaccinationSchedule()` |
| Reminder three days before each dose | Day 9 and day 18, shown on the dashboard and batch screen |

Day arithmetic lives in `packages/shared/src/poultry.ts` and uses UTC date-only
values. The phone and the server therefore agree about which day a batch is on
and whether a sale is allowed.

A sale is judged by the day it happened (`recordedAt`), not by the day the phone
reconnects. A sale recorded offline on day 21 is refused even if it is pushed on
day 25.

## Entities

All eight are ordinary sync entities: phone-generated ids, idempotent insert,
soft deletes, `change_seq` from the farm-scoped trigger.

| Entity | Permissions |
| --- | --- |
| `houses` | `manage_setup` |
| `batches` | `manage_setup` |
| `mortality_events` | `record_mortality` |
| `bird_transfers` | `record_transfer` |
| `bird_sales` | `record_sale` |
| `vaccination_events` | `record_vaccination` |
| `stock_items` | `manage_setup` or `receive_stock` |
| `stock_movements` | receipts: `receive_stock`; issues: `reserve_feed` or `record_feeding`; adjustments: `manage_setup` |

The server checks the permission again on every pushed record. The permissions
in the phone's token are only a convenience for hiding buttons.

## Balances are derived

Nothing stores "birds alive" or "feed on hand". Both are computed from the
events:

```
live   = initial - mortality - sold - transferred_out + transferred_in
on hand = receipts - issues + signed adjustments
```

The phone computes the same way from its own Dexie records, and the API checks
the same expression before accepting an event. This is what stops two phones
from disagreeing, or a balance being edited directly.

Birds may never go negative. Feed may: a negative weight is shown as a warning
rather than blocking a farmer who already fed the birds.

## Offline ordering

The outbox now carries a monotonic `order`. A house is pushed before the batch
that points at it, and a feed item before its first receipt. Without that, a
phone that created both while offline could have its first push rejected as
`unknown_house` or `unknown_stock_item` purely because IndexedDB returned the
rows in a different order.

## Screens

| Screen | What it does |
| --- | --- |
| Home | Counts batches, live birds and feed, and shows vaccinations whose reminder window is open |
| Poultry | Batch list with day number and sale date; reminders; new house and batch |
| Batch | Derived counts, sale gate, vaccination doses, mortality, transfers, sales and feed issues, event history |
| Feed store | Feed on hand, reorder warnings, receive, issue to a batch, adjustment |

Every form writes to Dexie and queues an outbox entry. With no signal the screen
updates immediately and the record is sent when the phone reconnects.

## Business-rule rejections

A refused record comes back as a per-record rejection, so the rest of the batch
still lands and the phone can show what to fix:

| Reason | Meaning |
| --- | --- |
| `unknown_house` | The batch points at a house the server does not have |
| `unknown_batch` | An event points at a batch the server does not have |
| `unknown_stock_item` | A movement points at feed the server does not have |
| `duplicate_batch_code` | Another live batch already uses that code |
| `not_enough_birds` | The event would take the batch below zero |
| `sale_too_early` | The sale date is before day 22 |
| `forbidden` | This user may not record this kind of event |

## Verification

```
packages/shared  30 tests   includes 12 date, sale-gate, vaccination and balance tests
apps/api         46 tests   includes 12 poultry and feed tests over the real sync endpoints
```

The poultry API file passes on its own. The full suite needs a machine with
enough commit charge for one embedded Postgres per file; on a desktop that is
already running several browsers and editors, PGlite can fail to allocate its
WASM heap. `pnpm test` runs packages one at a time for the same reason.

## Still open

- The four initially unconfirmed modules were built in later phases: finance
  (3), salesperson allocation (4), health monitoring (5) and goats and cattle
  (10). Goats and cattle reuse this event model.
- Weight and growth recording were built in Phase 9; feed conversion is still
  an estimate from the latest weighing.
- Feed allocations per salesperson are not built; feed is issued to a batch.
- Prices, buyers' balances and payments are finance, not this phase.
