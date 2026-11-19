# Phase 3 — Finance

The client's second module is money: what the farm sold, what it spent, and what
is still waiting to be approved. Like poultry and feed it is built on the same
offline foundation, so an expense recorded in a shed with no signal is queued
and lands when the phone reconnects.

The farm chose **cash only**. There are no invoices, credit sales, receivables
or statements in this phase.

## The rules the farm asked for

| Rule | How it is implemented |
| --- | --- |
| Sales are priced per bird | `bird_sales.unit_price_kes`, captured on the sale form |
| Revenue is birds × price | `saleRevenueKes()` rounds once, at the total |
| Expenses are cash amounts | `expenses.amount_kes`, positive, two decimal places |
| Owner **and** farm manager approve | `approve_expense` in both role defaults |
| A batch's margin uses direct costs only | Approved expenses tagged to the batch; feed cost is excluded for now |

An unpriced sale is **not** counted as zero. Older queued sales, or a sale where
the farmer genuinely does not know the price yet, come back with
`unitPriceKes: null` and are reported on screen as "unpriced" so a month's
revenue is never quietly understated.

## Entities

| Entity | Permissions |
| --- | --- |
| `expenses` | `record_expense` |
| `expense_approvals` | `approve_expense` |
| `bird_sales` (extended) | `record_sale`, now with an optional price |

Approvals are append-only events, not an `approved` flag on the expense. The
expense an offline phone pushed is therefore never edited underneath it: the
decision is a separate row that arrives in the same pull stream.

An expense has **one** decision. A partial unique index on `expense_id` (where
`deleted_at is null`) means a second, different decision is refused as
`already_decided`; a retried push of the same approval is idempotent like every
other record.

## Money is derived

No table stores a balance. Cash in, cash out and margin are computed from the
events, exactly like birds alive and feed on hand:

```
revenue  = sum(price × birds)          for priced sales
spend    = sum(amount)                 for approved expenses
net      = revenue - spend
margin   = priced sale revenue - approved expenses tagged to the batch
```

Amounts are rounded to the nearest cent **once**, when added up
(`roundKes()` and `sumKes()` in `packages/shared/src/finance.ts`). A stored
running total would let two phones drift apart.

Expenses may be tagged to a batch or left untagged as farm overhead. Only
approved direct costs reduce a batch's margin; a pending or rejected expense
does not.

Feed cost is deliberately left out of batch margin in this phase. Feed is
recorded in kilograms at the store, and turning that into shillings needs a
costing decision the client has not made yet. Laying the two numbers side by
side would produce a margin that looks better than it is, so the batch screen
says so in words.

Phase 9 closes this: a delivery can carry a price per kilogram, and a batch's
margin subtracts the cost of the feed issued to it.

## Screens

| Screen | What it does |
| --- | --- |
| Finance | Today and this month in / out / net, unpriced-sale warning, pending approvals, expense form, expense list with state |
| Batch | Revenue, direct costs and margin for one batch, with the unpriced and feed-cost caveats |
| Home | This month's in / out / net, but only for people with finance access |

Approve and reject are ordinary saves: they write to Dexie, queue an outbox
entry and sync when the phone has signal. The money on screen updates
immediately because it is derived from the local rows.

The **Finance** navigation item appears only for people holding
`view_finance` or `record_expense`. A stock keeper and a salesperson never see
the cash book. The server checks the permission again on every push.

## Rejections

| Reason | Meaning |
| --- | --- |
| `unknown_expense` | The approval points at an expense the server does not have |
| `already_decided` | This expense already has an approval or rejection |
| `unknown_batch` | The expense is tagged to a batch the server does not have |
| `invalid_record` | Amount is zero or negative, category or method is unknown |
| `forbidden` | This user may not record expenses or approve them |

## Verification

```
packages/shared  39 tests   includes 9 money, approval and batch-margin tests
apps/api          9 finance tests, passing over the real sync endpoints
```

The finance API tests cover an owner and manager recording expenses, a stock
keeper being refused, a zero amount, a single decision per expense, cross-farm
approval and cross-farm batch tagging, and the priced / unpriced sale wire
shape.

> **Verification note.** The finance suite and the migration chain were first
> written while this machine was out of memory. They have since been run here:
> migrations `0001` to `0006` apply cleanly and all nine finance tests pass. CI
> is still to be added.

## Still open

- Credit sales, receivables, customer statements and part-payments are out of
  scope for this phase.
- Feed cost per batch, and therefore a true batch margin, waits on costing.
- Discounts, payroll, tax, bank reconciliation and other income are not built.
- The other unconfirmed modules remain unbuilt: goat and cattle, standalone
  vaccination and mortality monitoring, and salesperson allocation.
