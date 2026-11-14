# Architecture

The plan asks for eleven modules that all work offline. This document records
the decisions that make that possible, and the reasoning behind each, so they
are not quietly revisited later.

## Shape

One repository, five packages:

```
apps/web        React + Vite. Owner and staff share one codebase.
apps/api        Fastify. Owns validation, permissions and every write.
packages/db     Schema, migrations, two database drivers, tenant helpers.
packages/shared Zod schemas, DTOs, permission vocabulary, sync contract, phone rules.
packages/sync   Dexie stores, outbox, sync client, offline session and PIN verifier.
```

`packages/shared` is the contract. A form in the browser and a route on the
server validate the same input with the same schema, so a rule cannot drift
between them. Types for API payloads live there too, so renaming a field breaks
the build in both places rather than at runtime.

## Tenancy

Every business row carries `farm_id`. Isolation is enforced twice:

1. **Row level security.** Each table has a policy comparing `farm_id` to
   `current_setting('app.farm_id')`, which the API sets per transaction. The
   API connects as `farmatics_app`, which is not the table owner and holds no
   `BYPASSRLS`, so the policies actually apply.
2. **Explicit filters.** Queries also carry `where farm_id = $1`. RLS is the
   safety net; the filter is the intent, and it means a query is still correct
   under a connection that bypasses RLS.

Two connections exist on purpose:

- `app` (`DATABASE_URL`) is restricted and used for farm data.
- `admin` (`DATABASE_ADMIN_URL`) is the owner and is used only by migrations,
  the audit writer, and the auth module. Sign-in has to find a user by phone
  before a farm is known, which RLS cannot express, so auth runs elevated and
  filters explicitly.

`packages/db/test/db.test.ts` proves the policies by switching to
`farmatics_app` with `set local role` and attempting to read and write across
tenants.

## Sync

Writes land on the phone first. A save writes the local record and its outbox
entry in one IndexedDB transaction, so a crash cannot leave a record that will
never be pushed. Record ids are generated on the phone (`crypto.randomUUID`),
which is what makes retries safe: the server sees the same id again rather than
a second record.

The cycle is push, then pull:

- **Push** sends up to 200 records. Each is handled on its own, so one invalid
  record does not fail the batch. Insert is `on conflict (id) do nothing`; the
  server then looks the row up inside the caller's farm to decide whether the
  result is `duplicate` or `id_conflict`. A row that already exists keeps its
  original `change_seq`, so the record is only counted once.
- **Pull** reads `where change_seq > cursor order by change_seq limit n + 1`.
  The extra row tells the client whether more work remains without a second
  query. The cursor never moves backwards on an empty page. A table may declare
  `readPermissions`; when it does, the pull skips it for a caller who holds none
  of them. The cash book uses this so expenses never reach a stock keeper's
  phone. When a member's rights change, the client pushes outstanding work,
  clears its records and cursor, and pulls the farm again with the new
  permissions; the outbox is never dropped.

The phone and the server share the wire contract in `packages/shared`, so a
field cannot be renamed on one side only. `cursors` and `changeSeq` travel as
strings because they are bigint values that would lose precision in JavaScript
numbers.

Ordering is what makes pull safe. The schema trigger takes
`pg_advisory_xact_lock` on the farm id before taking a value from the global
sequence, so two writes to the same farm commit in sequence order. Without that
lock a pull could commit-skip a row and lose it forever.

Deletes are soft (`deleted_at`), so a phone that was offline during a delete
still learns about it. `created_at` and `updated_at` are stamped by the same
trigger, never by the client.

Each device keeps its own cursor in `device_sync_state`. Two phones therefore
pull independently, and a phone that has been away for a week does not affect
the other.

`probes` remains as a development entity and is still used by the sync card's
test button. The real modules use the same path: `houses`, `batches`,
`mortality_events`, `bird_transfers`, `bird_sales`, `sales_allocations`,
`bird_returns`, `vaccination_events`, `stock_items`, `stock_movements`,
`expenses` and `expense_approvals`. Each
entity in `apps/api/src/sync/entities.ts` validates its own fields, declares the
permissions that may write it and, where needed, the permissions that may pull
it, and re-checks business rules inside the same
tenant transaction - for example that a sale is on or after day 22, that a
mortality record cannot take a batch below zero birds, or that an expense has
only one approval. An approval is its own append-only record rather than a flag
on the expense, so the expense an offline phone pushed is never edited beneath
it.

The phone's outbox carries a monotonic `order`, so a house is pushed before the
batch that points at it even when both were created offline minutes apart.

## Authentication

- Passwords and PINs are hashed with scrypt (`N=16384`, per-hash salt,
  parameters stored with the hash so they can be raised later).
- Access tokens are HS256 JWTs carrying `sub`, `farm`, `role`, `perms`, `sid`
  and `dev`. They are short lived and stateless.
- Refresh tokens are random, stored only as a hash, and rotate on every use.
  A token replayed after thirty seconds stops working. Inside that window it
  is accepted, because the likeliest reason to see it is a phone whose reply
  was lost, and there is no way to tell that apart from a replay. The window
  is the smallest that still survives a slow mobile network.
- Lockout is five attempts. The owner waits fifteen minutes; staff stay locked
  until the owner unlocks them, which the dashboard supports.
- Every sign-in, account change and approval appends to `audit_log`.

The JWT claim shape is deliberate: it is what the offline session bundle
stores on the phone, so the device can check permissions with no server call.

## Offline session

A sign-in copies the user, farm, permissions and device id into IndexedDB. The
PIN is verified locally with PBKDF2-SHA256 (210,000 iterations, per-device
salt). That verifier gates the user interface only: it proves the person
holding the phone is the one who signed in. It is not an authentication
credential, and every server call is still checked against the live account.

The saved copy carries the time it was last confirmed online. After fourteen
days without contact, the phone refuses to unlock and asks for a password or
PIN sign-in. Refreshing the session online preserves the verifier, so staff do
not have to choose a new PIN every time the app talks to the server.

Two rules matter for correctness:

- The verifier is written when the PIN is set or changed, not when the session
  is restored. A restored session must not overwrite the PIN the user chose.
- Work never waits for the network. The lock screen unlocks with the local
  verifier, and the outbox drains whenever the API is reachable.

The app shell is cached by a small service worker (`apps/web/public/sw.js`).
Navigation is network-first with a cached fallback; API responses are never
cached. In development the proxy is disabled if you need to simulate an
offline phone, because the browser itself cannot drop the connection.

## Local database

Development runs embedded Postgres (PGlite, real Postgres compiled to WASM)
because it gives the same SQL, RLS, plpgsql and advisory locks as production
with no server to install. `packages/db` hides the difference behind a small
`Db` interface with two implementations.

Production sets `DATABASE_URL` and uses the standard `postgres` driver against
Neon or any Postgres. Nothing above the driver layer changes.

## Testing

| Layer | Where | Covers |
| --- | --- | --- |
| Shared rules | `packages/shared/test` | Phone normalisation, permission resolution, wire schemas, batch day math, sale gate, vaccination schedule, balances, money rounding, approval state, mortality windows and vaccination compliance |
| Database | `packages/db/test` | RLS across tenants, change sequence ordering, finance constraints, sale price checks, SQL splitting |
| Offline engine | `packages/sync/test` | Atomic save, outbox ordering, push and pull, retry, permission-change reset, lock and unlock |
| API | `apps/api/test` | Account flow over HTTP, sync push and pull, cross-tenant attempts, pull access by permission |
| Poultry and feed | `apps/api/test/poultry.test.ts` | Houses, batches, sale gate, vaccinations, transfers, stock in kg, tenant boundaries |
| Finance | `apps/api/test/finance.test.ts` | Expense permissions, one decision per expense, priced and unpriced sales, tenant boundaries |
| Allocation | `apps/api/test/allocations.test.ts` | Own-allocation sales, walk-in sales, over-allocation, returns, feed issued with the birds, cross-farm ids |
| Pull access | `apps/api/test/pull-access.test.ts` | Which roles receive expenses, approvals and sale prices |
| Two phones | `apps/api/test/two-phone.test.ts` | Both phones offline, both write, both reconnect |

API tests drive the real Fastify app against an in-memory Postgres, so routes,
validation, hashing and SQL all execute. Only the SMS sender is stubbed.

The two-phone test runs two real Dexie databases against two real clients and
the real API server. It covers the case the plan cares about most: both phones
offline, both write, then both reconnect. It also simulates a lost
acknowledgement and checks that the retry reports `duplicate` rather than
creating a second record.

The embedded database is memory hungry. `apps/api/vitest.config.ts` disables
file parallelism, and `pnpm test` runs one package at a time, because two
embedded instances can exhaust the Node heap on a small machine.

## Deliberate omissions

These are known and intentional for now:

- Refresh tokens live in `localStorage`. This is acceptable for the pilot but
  should move to an httpOnly cookie, or be paired with device binding, before
  real farm data is on the system. Two tabs refreshing at the same moment can
  still race; a phone runs one tab, so this is a desktop concern.
- The thirty-second refresh grace window accepts a rotated token briefly. It is
  a deliberate trade against lost responses, not an oversight.
- `pnpm start` runs the API through `tsx` rather than a compiled bundle.
- Rate limiting is per IP. Per-account throttling is a Phase 6 item.
- The SMS sender for Africa's Talking is written but untested until an account
  is provisioned.
- The app-shell service worker is hand-written and has no build-time revision
  manifest yet; a cache-busting strategy is a Phase 6 item.
