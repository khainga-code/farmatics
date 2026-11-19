# Phase 10 - Goats and cattle

The farm keeps goats and cattle as well as poultry. Until now the app could
only describe a flock, so the other animals lived in notebooks and the reports
told half the story. Phase 10 lets one farm record all three.

The chosen shape is deliberately small: a batch gains a **species**, and every
existing event - deaths, transfers, sales, feed issues and weighings - works
for the new species unchanged. Counts are still never typed into a balance, and
the phone still works offline.

## What a species changes

| Rule | Poultry | Goats | Cattle |
| --- | --- | --- | --- |
| May be sold from | Day 22 | Arrival day | Arrival day |
| Vaccination schedule | Days 12 and 21, reminder 3 days before | None | None |
| Weighing ceiling | 10 kg | 200 kg | 2000 kg |
| Transfers | Poultry batch only | Goat batch only | Cattle batch only |

Everything else is shared. Brooding, day counts, mortality, transfers, feed in
kilograms, sales, allocations and approvals are the same events for every
species.

Poultry keeps the day-22 gate because that rule was the farm's own. Goats and
cattle can leave on the day they arrive. The server compares the day of the
sale, not the day the phone reconnects, so a queued sale is judged by when it
happened.

A transfer may only move animals into a batch of the same species. The server
rejects anything else with `species_mismatch`, so a goat never lands in a
poultry count.

## Weighing limit

The shared schema accepts any weight up to 2000 kg, the absolute guard against
a decimal point in the wrong place. The server then applies the species limit:
10 kg for poultry, 200 kg for goats, 2000 kg for cattle. A 410 kg reading is
valid for cattle and refused for poultry with `invalid_weight`.

The database check was widened from 100 kg to 2000 kg in the same way. The
species-specific judgement lives in the sync entity, where the batch is known.

## Existing data

`batches.species` defaults to `'poultry'`, so every batch recorded before this
phase stays valid and keeps its brooding and vaccination rules. The phone reads
an unknown or missing species as poultry for the same reason.

## What changed

| Area | Change |
| --- | --- |
| Database | `0009_livestock.sql`: `batches.species` with a check constraint; weighing ceiling raised to 2000 kg |
| Shared rules | `SPECIES`, `SPECIES_LABELS`, `animalWord()`, `MAX_WEIGHT_KG` / `maxWeightKg()`, `isSpecies()`; species-aware `saleOpensOn()` and `canSellOn()`; species on `batchInputSchema` |
| Sync | Batch species round-trips; sales use the batch species; transfers refuse mixed species; weighings apply the species ceiling |
| Livestock screen | Species filter, species badge, species on the new-batch form, animal wording throughout |
| Batch screen | Species-aware sale gate, vaccinations only for poultry, species-specific weighing limit, transfers limited to the same species |
| Health and dashboard | Vaccination compliance only for poultry; animal wording elsewhere |
| Reports | Species column in the batch CSV and the species label on each batch row; animal wording in headings and exports |
| Sales | Allocation, sale and return forms say animals rather than birds |

## Verification

```
packages/shared tests             74 tests
apps/web tests                    48 tests
pnpm typecheck                    5 packages
production web build              bundle and service worker generated
```

`pnpm seed` now adds a goat herd and a cattle herd with feed, a death, two
weighings each and one priced cattle sale, so the livestock screens, reports
and CSV exports show more than poultry on first sign-in.

`apps/api` tests could not run on this machine: PGlite cannot start here, the
same limitation recorded in earlier phases. The new API cases
(`apps/api/test/poultry.test.ts`, "goats and cattle") run in CI. They cover a
young goat batch selling while poultry of the same age is refused, species
round-tripping through pull, a mixed-species transfer being rejected, and a
cattle weight accepted where the same weight is refused for poultry. The
migration was not applied against a live Postgres here; CI applies it through
the API suites.

The livestock screens were not exercised in a browser here for the same reason:
the API cannot boot, so sign-in cannot complete. Typecheck, the shared and web
tests, and the production build cover the new branches; a local run with the
embedded database is still the first thing to do on a machine where PGlite
starts.

## Still open

- Animals are counted, not individually identified. There are no ear tags,
  animal histories, births or breeding records.
- Milk, weight targets and cattle/goat-specific feed rations are not modelled.
- Goats and cattle have no health schedule and no compliance view; only their
  deaths are tracked by category.
- Sales allocation stays a count-based hand-over. The forms now say animals,
  but there is no per-animal allocation.
- Moving animals between species is not supported, by design.
