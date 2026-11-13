# Farmatics

Farm and poultry management for D Ayo Farm. Offline-first: staff record work
on their phones whether or not there is signal, and the server reconciles when
they reconnect.

## Status

**Phase 1 foundation complete. Phase 2 poultry and feed built.** Accounts,
roles, devices, the sync engine and offline PIN unlock work end to end. Poultry
batches, mortality, transfers, sales, vaccinations and the feed store now sit on
that foundation.

| Area | State |
| --- | --- |
| Owner registration, OTP verification, sign-in | Working |
| Employee sub-accounts with temporary PIN | Working |
| Roles and permission model | Working |
| Farm isolation (row level security) | Working, tested |
| Change sequence for sync cursors | Working, tested |
| Sync engine (outbox push, pull by cursor) | Working, tested on two phones |
| Offline PIN unlock and offline day limit | Working |
| Installable PWA with app-shell cache | Working |
| Poultry batches, mortality, transfers, sales | Working, tested |
| Vaccination schedule and reminders | Working |
| Feed store in kilograms | Working, tested |
| Salesperson allocation, finance | Not started |

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

The seed also creates a demo house, a batch that arrived twenty days ago, and
750 kg of feed, so the poultry and store screens have real data on first
sign-in. The second vaccination is due on that batch, and its reminder is open.

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
  api/        Fastify API, auth, validation, sync push and pull
  web/        React + TypeScript app, installable as a PWA
packages/
  shared/     Zod schemas, DTOs, permissions, sync wire contract, poultry rules
  db/         Schema, migrations, database drivers, tenant helpers
  sync/       Dexie stores, outbox, sync client, offline session and PIN verifier
docs/
  ARCHITECTURE.md   How the pieces fit and why
  PHASE-1.md        Foundation: what is built, what is stubbed
  PHASE-2.md        Poultry and feed: rules, entities, screens, rejections
```

## Configuration

Copy `.env.example` to `.env` when you need to change a default. The app runs
without it.

To run against a real Postgres (staging or production), set `DATABASE_URL` to
the RLS-restricted role and `DATABASE_ADMIN_URL` to the owner role. Leaving
both unset uses the embedded database.

## Licence

[MIT](./LICENSE)
