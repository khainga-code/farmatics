# Phase 4 — Salesperson allocation

The farm gives a salesperson birds to sell away from the farm. This phase makes
that hand-over a record, so the owner can see who holds which birds and the
salesperson can sell only from what they were given. It is built on the same
offline foundation as the other modules: allocating, selling and returning all
work with no signal and land when the phone reconnects.

## The rules the farm asked for

| Rule | How it is implemented |
| --- | --- |
| A salesperson sells only from their own allocation | `bird_sales.allocation_id`; the API checks the allocation belongs to the caller |
| The owner and farm manager may record a walk-in sale | A sale without `allocation_id` stays valid for those roles |
| Birds are handed over, not removed | Allocating does not change the batch's live count |
| Unsold birds come back | `bird_returns` lifts birds off the allocation; the batch count is unchanged |
| Never promise more birds than exist | Outstanding allocations may not exceed the batch's live birds |
| Never sell more than was allocated | `sold + returned + count ≤ allocated` |
| Feed goes out with the birds | An ordinary store issue tagged with `stock_movements.allocation_id`, in kg |

The balance is derived, like every other count:

```
remaining = allocated - sold - returned
```

Allocating birds keeps them in the batch. They are only subtracted from the
flock when a sale records that they left, so the batch's live count and the
salesperson's allocation describe the same birds. A return therefore does not
add birds back to the batch - the birds never left.

Feed handed over with the birds follows the same rule as every other stock
movement: it is an `issue` in kilograms, tagged with the allocation. Feed on hand
stays derived from the store's movements, so there is no separate salesperson
balance to reconcile. The allocation and its feed issue are queued in one
`saveRecords` transaction, which keeps the bird hand-over and the feed hand-over
together even when the phone is offline.

## Entities

| Entity | Permissions |
| --- | --- |
| `sales_allocations` | `allocate_stock` |
| `bird_returns` | `record_return` |
| `bird_sales` (extended) | `record_sale`, now with an optional `allocation_id` |
| `stock_movements` (extended) | an `issue` may carry `allocation_id`, under the usual feed permissions |

Both new tables are ordinary sync entities: phone-generated ids, idempotent
insert, soft deletes and `change_seq` from the farm-scoped trigger. The phone
pushes an allocation before the return or sale that points at it, because the
outbox already orders writes by sequence.

## Rejections

| Reason | Meaning |
| --- | --- |
| `unknown_allocation` | The sale or return points at an allocation the server does not have |
| `not_your_allocation` | A salesperson is using another salesperson's birds |
| `allocation_required` | A salesperson recorded a sale without an allocation |
| `allocation_mismatch` | The sale, return or feed issue names a different batch from the allocation |
| `not_enough_allocated` | The sale or return would exceed the allocation |
| `not_enough_birds` | Allocating would promise more birds than the batch has alive |
| `unknown_salesperson` | The allocation is not for an active salesperson on this farm |
| `forbidden` | This user may not allocate or return |

A rejected record is reported per record, so the rest of an offline batch still
lands and the phone can show what to fix.

## Screens

| Screen | What it does |
| --- | --- |
| Sales | Allocations with allocated / sold / returned / remaining and feed sent in kg; allocate birds with optional feed (owner and manager); sell from an allocation; return unsold birds |
| Batch | The sale form asks a salesperson to pick one of their allocations for that batch; walk-in sales are unchanged for the owner and manager |
| Home | A salesperson sees the birds left to sell and feed handed over across their allocations |
| Navigation | The Sales item appears for `allocate_stock`, `record_sale` or `record_return`; a stock keeper sees it to allocate, a salesperson to sell |

The team list used by the allocate form is cached on the phone after one online
visit, so a manager who has opened the app online can still allocate in the
field. The allocation itself is a normal queued write. A salesperson needs no
network at all to sell or return. If the sender has the feed permissions, the
form also takes a feed item and a weight, and the two records are written
together.

## Verification

```
packages/shared  47 tests   includes 8 allocation balance and schema tests
packages/sync    16 tests   includes the atomic related-record save and its order
packages/db       9 tests   migration chain 0001 to 0006, applied twice
apps/api         10 allocation tests over the real sync endpoints
typecheck        shared, db, sync, api, web
build            web production bundle
```

The API tests cover allocation permissions, allocating to a non-salesperson,
over-allocation, a salesperson selling from their own allocation, walk-in sales,
another salesperson's allocation, overselling, returns, cross-farm ids, a
mismatched batch, and feed issued with the birds.

## Still open

- Goat and cattle management, the standalone vaccination and mortality
  monitoring module, and reports remain unbuilt.
- A salesperson's sales are still pulled to their phone with the rest of the
  farm's changes; per-role pull filtering is not built.
- Commission, salesperson targets, credit sales and receivables are out of
  scope.
