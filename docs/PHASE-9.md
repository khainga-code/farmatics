# Phase 9 - Feed cost and growth

Phase 8 made the app safe to run. Phase 9 makes the batch margin tell the
truth. Until now feed was counted in kilograms and left out of the money, so a
batch that ate well looked more profitable than it was. The farm also had no
way to say how heavy the birds were getting.

Two rules close both gaps, in the same shape as the rest of the app: a price
belongs to a delivery, a weighing is an event, and every total is derived.

## Feed cost

A feed delivery may carry a price per kilogram. Nothing else can:

| Record | Carries a price | Why |
| --- | --- | --- |
| `receipt` | Yes, optional | This is the purchase; the farm knows what it paid |
| `issue` | No | The cost comes from the feed's deliveries |
| `adjustment` | No | A correction is not a purchase |

The price of one feed is the **kg-weighted average** of its priced deliveries.
Ten kilograms at 60 and ten at 80 cost 70 per kilogram, and a delivery with no
price does not drag the average down. Weighted averaging is deliberate: two
phones that saw the same deliveries compute the same price, and a receipt that
arrives late from another phone moves the average rather than rewriting stored
figures. No table stores a cost or a margin.

Issued feed is valued at that average. Feed with no priced delivery is counted
in kilograms as **uncosted** and shown as a warning, never valued at zero.

A batch's money card and the report now read:

```
margin = priced sales revenue - approved tagged expenses - feed cost
```

The cash book is unchanged: money out is still approved expenses. Feed cost is
a production cost that answers "did this batch pay?", not a second cash book.

**Recording a feed purchase twice.** A purchase entered as a priced delivery
and again as a `feed` expense is counted twice in margin. The store form says
so, and the finance form shows the same note when the category is feed. Buy
feed through the store; use a feed expense only for feed that never entered
stock.

## Growth

A weighing is a new append-only event, `batch_weights`: how many birds were
weighed and the average they came to. It is recorded from the batch screen, by
anyone with `record_growth` (owner, farm manager, stock keeper by default).

From those events the batch screen shows:

- **Average weight** - the latest weighing on this phone.
- **Feed per kg sold** - feed issued to the batch divided by the birds sold
  times the latest average weight. A sale records a price, not a weight, so
  every sold bird is valued at the latest average. This is an estimate and the
  screen labels it as one.

Reports add the latest average weight as a column. Weighings are not period
money and do not enter the cash book.

## What changed

| Area | Change |
| --- | --- |
| Database | `0008_costs_and_growth.sql`: `stock_movements.unit_cost_kes_per_kg` (receipts only), `batch_weights` table with RLS and grants |
| Shared rules | `averageCostKesPerKg()`, `feedCostKes()`, `batchFinance(..., feedCost)`; `latestWeight()`, `weightGainKg()`, `feedPerKgSoldKg()`; `weightInputSchema`; receipt price in `stockMovementInputSchema` |
| Sync | `batch_weights` entity with `record_growth`; delivery price round-trips on `stock_movements` |
| Store | Optional price per kilogram on receive; average cost per feed on the list |
| Batch | Record weight form, average weight and feed-per-kg-sold stats, weight history, feed cost in the money card |
| Reports | Average weight column, feed cost in margin, uncosted feed warning, CSV columns |

## Verification

```
packages/shared tests             70 tests
apps/web tests                    47 tests
pnpm typecheck                    5 packages
production web build              bundle and service worker generated
```

`pnpm seed` now leaves the demo farm with a priced delivery (750 kg at 62.50 a
kilogram) and two weighings on the demo batch, so feed cost, average weight and
growth are populated on first sign-in instead of waiting for the first entry.

`apps/api` tests could not run on this machine: PGlite cannot start here, the
same limitation recorded in Phases 3 to 6. The new API cases
(`apps/api/test/poultry.test.ts`, "feed cost and growth") run in CI, which uses
a standard runner. They cover the delivery-price round trip, refusing a price
on an issue, recording and pulling a weighing, the `record_growth` gate,
invalid samples and a batch from another farm. The migration was not applied
against a live Postgres here; CI applies it through the API suites.

## Still open

- Feed cost uses the average of all priced deliveries on the phone, not a
  per-day or per-delivery valuation. A late receipt changes the average, which
  is visible but not historical.
- Feed per kg sold is an estimate: sale weights are not recorded.
- There is no feed stock valuation, no per-feed cost trend and no weighed
  sample history chart.
- Goat and cattle management was added in Phase 10: a batch now carries a
  species and reuses the same event model. The feed and growth rules here apply
  to all three species.
