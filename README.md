# Farmatics

Farm and poultry management for D Ayo Farm. Offline-first: staff record work
on their phones whether or not there is signal, and the server reconciles when
they reconnect.

## Status

**Phase 1 foundation complete. Phase 2 poultry and feed built. Phase 3 finance
built. Phase 4 salesperson allocation built. Phase 5 health and phone-level
privacy built. Phase 6 hardening built. Phase 7 reports and analytics built.
Phase 8 production deployment prepared.**
Accounts, roles, devices, the
sync engine and offline PIN unlock work end to end. Poultry batches, mortality,
transfers, sales, vaccinations and the feed store now sit on that foundation,
with a cash book for sales revenue, expenses and approvals, allocations
that keep a salesperson selling only from the birds the farm gave them, a
health screen that turns the flock's records into losses, survival and
vaccination cover, sign-in limits that follow the account rather than the
network it is tried from, and period reports that open offline and export to
CSV.

| Area | State |
| --- | --- |
| Owner registration, OTP verification, sign-in | Working |
| Employee sub-accounts with temporary PIN | Working |
| Roles and permission model | Working |
| Farm isolation (row level security) | Working, tested |
| Change sequence for sync cursors | Working, tested |
| Sync engine (outbox push, pull by cursor) | Working, tested on two phones |
| Offline PIN unlock and offline day limit | Working |
| Installable PWA with a revisioned app-shell cache | Working |
| Poultry batches, mortality, transfers, sales | Working, tested |
| Vaccination schedule and reminders | Working |
| Feed store in kilograms | Working, tested |
| Cash book: priced sales, expenses, approvals | Working, tested |
| Salesperson allocation and returns | Working, tested; birds and feed kg |
| Health monitoring, mortality causes and vaccination compliance | Working, tested in shared |
| Cash book hidden from phones without finance permission | Working, API tests written |
| Per-account limits on register, verify and sign-in | Working, tested |
| Period reports, CSV exports and print layout | Working, tested |
| Production API image, config guards and runbook | Prepared; hosting not wired |

## Offline behaviour

Every save writes to the phone's local database first and queues an outbox
entry in the same transaction. When the phone has signal the outbox is pushed
and the farm's changes are pulled by cursor. Record ids are generated on the
phone, so a retried push cannot double-count.

With no signal the app opens from the saved session and asks for the PIN. It
keeps working for fourteen offline days; after that it asks for a fresh sign-in.
Writes recorded offline stay queued and are sent when the API is reachable
again.

## Poultry and feed

Arrival is day 1. Brooding runs to day 21 and birds may be sold from day 22.
Vaccinations fall on day 12 and day 21, with a reminder three days before each
(day 9 and day 18). Feed is recorded in kilograms.

Counts are never typed into a balance. Birds alive and feed on hand are derived
from the events that changed them - mortality, transfers, sales, receipts and
issues - so two phones cannot disagree about a balance. A sale is judged by the
day it happened, not by the day the phone reconnects.

The full rule set is in [`docs/PHASE-2.md`](./docs/PHASE-2.md).

## Finance

The farm keeps a cash book. A sale carries the price it was sold at, an expense
carries the amount that was paid, and the owner or farm manager approves it.
Revenue, spend and a batch's margin are derived from those events; no table
stores a running balance.

An unpriced sale is reported as unpriced rather than counted as zero, and only
approved expenses reduce a batch's margin. Feed cost is not included in batch
margin yet, because feed is recorded in kilograms rather than shillings.

The full rule set is in [`docs/PHASE-3.md`](./docs/PHASE-3.md).

## Sales allocation

The owner or farm manager hands birds from a batch to a salesperson. She sells
only from that allocation, and unsold birds can be returned. Allocating does
not change the batch's live count: the birds stay in the flock until a sale
records that they left. The balance is derived from the events
(`allocated - sold - returned`), so two phones cannot disagree.

Feed can go out with the birds. It is recorded as an ordinary store issue in
kilograms, tagged with the allocation, so feed on hand is still derived from the
store. The allocation and its feed are queued together in one write.

Allocating, selling and returning are ordinary queued writes. The only network
the allocate form needs is one earlier visit to cache the team list; a
salesperson needs no network at all to sell.

The full rule set is in [`docs/PHASE-4.md`](./docs/PHASE-4.md).

## Health monitoring

The Health screen reads the events already on the phone and shows, per active
batch, how many birds were lost, how many in the first week and in the last
seven days, the mortality and survival rates, whether each vaccination was on
time or late, and what is killing birds by category. A batch is flagged when
first-week losses reach 2% or cumulative losses reach 5% of the birds that
arrived.

Deaths can be tagged as disease, heat, cold, predator, injury, culling or
unknown. Older deaths with no category are shown as uncategorised, never
guessed.

## Reports and analytics

The Reports screen answers period questions from the records already on the
phone. It offers this month, the last 7, 30 or 90 days, and shows birds sold,
deaths and mortality rate, feed used, batch performance, deaths by cause and
batch, money in and out by day or week, spend by category, and each
salesperson's handovers, sales still out and feed.

Revenue counts priced sales only, and an unpriced sale is reported rather than
counted as zero. Spend counts approved expenses only, with pending ones named
separately. Live birds is where the flock stands now; every other figure is
scoped to the chosen period. Nothing extra is stored or fetched, so the report
works offline and is as fresh as the last sync.

Each section exports to CSV in the browser, with spreadsheet-formula prefixes
neutralised, and the whole report has a print layout. A member with
`view_reports` but no finance permission gets the operational report with no
money figures and no price columns in the exports.

The full rule set is in [`docs/PHASE-7.md`](./docs/PHASE-7.md).

## Who sees what

The pull only carries the tables a member may read. Expenses and their
approvals are not sent to a phone without `view_finance` or `record_expense`,
so the cash book does not sit on a stock keeper's device at all. When a
person's rights change, the phone pushes any queued work, rebuilds its local
copy and pulls again.

Sales are still pulled by everyone because bird counts drive every batch
balance; the sale price travels with them. The Reports route additionally
requires `view_reports`, and the money inside a report is only calculated for a
member who may see the cash book.

The full rule set is in [`docs/PHASE-5.md`](./docs/PHASE-5.md).

## Going live

The browser app deploys to Cloudflare Workers as static assets. The API runs as
a container against Postgres; the two are separate origins joined by
`VITE_API_URL` and `CORS_ORIGINS`. Production refuses to start on an implicit or
plain-http browser origin, warns while the embedded database or stub SMS sender
is still in use, and refuses to seed demo accounts. The web build fails when
`VITE_API_URL` is missing rather than shipping an app that cannot sign in.

The database needs two roles: the owner for migrations and auth, and the
RLS-restricted `farmatics_app` for everything else. Create the restricted role
with its own password before running migrations. The runbook - environment
matrix, first-run checklist, backups and rollback - is in
[`docs/PHASE-8.md`](./docs/PHASE-8.md).

## Requirements

- Node.js 22 or newer
- pnpm 10 (`npm install -g pnpm@10`)

No database server, Docker, or admin install is needed for development: the
API runs an embedded Postgres (PGlite) on first start.

## Getting started

```bash
pnpm install
pnpm db:migrate        # only needed once; the API also migrates on boot
pnpm seed              # optional: demo farm and accounts
pnpm dev               # API on :4000, app on :5173
```

Open <http://localhost:5173>.

Seeded accounts:

| Role | Sign in with | Credential |
| --- | --- | --- |
| Owner | phone `0700 000 001` | `farmatics2026` |
| Stock keeper | username `joseph` | temporary PIN printed by `pnpm seed` |
| Salesperson | username `mercy` | temporary PIN printed by `pnpm seed` |

The seed also creates a demo house, a batch that arrived twenty days ago, and
750 kg of feed, so the poultry and store screens have real data on first
sign-in. The second vaccination is due on that batch, and its reminder is open.
Two demo expenses are created too: one approved for chicks and one transport
cost still waiting for a decision. The salesperson has an 80-bird allocation
from the demo batch, with 60 kg of feed sent along, so the Sales screen has real
data.

In development the six-digit sign-up code is returned by the API and shown on
the verify screen, so no SMS provider is needed.

## Scripts

| Command | What it does |
| --- | --- |
| `pnpm dev` | Runs the API and the app together |
| `pnpm dev:api` / `pnpm dev:web` | Runs one side only |
| `pnpm typecheck` | TypeScript across every package |
| `pnpm test` | Unit, database and API tests across every package |
| `pnpm db:migrate` | Applies pending SQL migrations |
| `pnpm db:reset` | Drops and rebuilds the local database |
| `pnpm seed` | Creates the demo farm and accounts |

`pnpm test` runs packages one at a time. The embedded Postgres is memory
hungry, and two copies running together can exhaust the Node heap on a small
machine.

## Project layout

```
apps/
  api/        Fastify API, auth, validation, sync push and pull; Dockerfile for production
  web/        React + TypeScript app, installable as a PWA
packages/
  shared/     Zod schemas, DTOs, permissions, sync wire contract, poultry and finance rules
  db/         Schema, migrations, database drivers, tenant helpers
  sync/       Dexie stores, outbox, sync client, offline session and PIN verifier
docs/
  ARCHITECTURE.md   How the pieces fit and why
  PHASE-1.md        Foundation: what is built, what is stubbed
  PHASE-2.md        Poultry and feed: rules, entities, screens, rejections
  PHASE-3.md        Finance: cash book, approvals, batch margin
  PHASE-4.md        Salesperson allocation: birds, feed, sales, returns
  PHASE-5.md        Health monitoring and phone-level privacy
  PHASE-6.md        Hardening: per-account limits and a revisioned shell
  PHASE-7.md        Reports: periods, CSV exports, print and privacy
  PHASE-8.md        Going live: roles, environment, deploy, backups, rollback
```

## Configuration

Copy `.env.example` to `.env` when you need to change a default. The app runs
without it.

To run against a real Postgres (staging or production), set `DATABASE_URL` to
the RLS-restricted role and `DATABASE_ADMIN_URL` to the owner role. Leaving
both unset uses the embedded database.

The browser app does not read `.env`. It bakes `VITE_API_URL` into the bundle
at build time, and a production build refuses to run without it. See
[`docs/PHASE-8.md`](./docs/PHASE-8.md).

## Licence

[MIT](./LICENSE)
