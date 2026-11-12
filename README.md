# Farmatics

Farm and poultry management for D Ayo Farm. Offline-first: staff record work
on their phones whether or not there is signal, and the server reconciles when
they reconnect.

## Status

**Phase 1 foundation complete.** Accounts, roles, devices, the sync engine and
offline PIN unlock work end to end. The next phase builds the farm modules on
top of this base.

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
| Module screens (poultry, store, sales, finance) | Not started |

## Offline behaviour

Every save writes to the phone's local database first and queues an outbox
entry in the same transaction. When the phone has signal the outbox is pushed
and the farm's changes are pulled by cursor. Record ids are generated on the
phone, so a retried push cannot double-count.

With no signal the app opens from the saved session and asks for the PIN. It
keeps working for fourteen offline days; after that it asks for a fresh sign-in.
Writes recorded offline stay queued and are sent when the API is reachable
again.

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
  shared/     Zod schemas, DTOs, permissions, sync wire contract, phone rules
  db/         Schema, migrations, database drivers, tenant helpers
  sync/       Dexie stores, outbox, sync client, offline session and PIN verifier
docs/
  ARCHITECTURE.md   How the pieces fit and why
  PHASE-1.md        What is built, what is stubbed, what is next
```

## Configuration

Copy `.env.example` to `.env` when you need to change a default. The app runs
without it.

To run against a real Postgres (staging or production), set `DATABASE_URL` to
the RLS-restricted role and `DATABASE_ADMIN_URL` to the owner role. Leaving
both unset uses the embedded database.

## Licence

[MIT](./LICENSE)
