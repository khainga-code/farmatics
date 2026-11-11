# Architecture

The plan asks for eleven modules that all work offline. This document records
the decisions that make that possible, and the reasoning behind each, so they
are not quietly revisited later.

## Shape

One repository, four packages:

```
apps/web      React + Vite. Owner and staff share one codebase.
apps/api      Fastify. Owns validation, permissions and every write.
packages/db   Schema, migrations, two database drivers, tenant helpers.
packages/shared  Zod schemas, DTOs, permission vocabulary, phone rules.
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

## Sync readiness

The sync engine is not built yet, but the schema is shaped for it:

- **`change_seq`** is assigned from one sequence on every write. Pull is
  `where change_seq > cursor order by change_seq`.
- **Ordering is guaranteed per farm.** The trigger takes
  `pg_advisory_xact_lock` on the farm id before taking a sequence value, so two
  writes to the same farm commit in sequence order. Without that lock, a pull
  could commit-skip a row and lose it.
- **Deletes are soft** (`deleted_at`), so a phone that was offline during a
  delete still learns about it.
- **Every record is stamped with `created_at` and `updated_at`** by the same
  trigger, never by the client.

Still to add when the engine lands: a `UNIQUE (farm_id, client_id)` constraint
on every event table so a retried outbox entry cannot double-count, and a
server-side `device_sync_state` cursor. The table for the latter exists.

## Authentication

- Passwords and PINs are hashed with scrypt (`N=16384`, per-hash salt,
  parameters stored with the hash so they can be raised later).
- Access tokens are HS256 JWTs carrying `sub`, `farm`, `role`, `perms`, `sid`
  and `dev`. They are short lived and stateless.
- Refresh tokens are random, stored only as a hash, and rotate on every use. A
  replayed token stops working.
- Lockout is five attempts. The owner waits fifteen minutes; staff stay locked
  until the owner unlocks them, which the dashboard supports.
- Every sign-in, account change and approval appends to `audit_log`.

The JWT claim shape is deliberate: it is what the offline session bundle will
store on the phone, so the device can check permissions with no server call.

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
| Shared rules | `packages/shared/test` | Phone normalisation, permission resolution |
| Database | `packages/db/test` | RLS across tenants, change sequence ordering, SQL splitting |
| API | `apps/api/test` | The full account flow over HTTP, including cross-tenant attempts |

API tests drive the real Fastify app against an in-memory Postgres, so routes,
validation, hashing and SQL all execute. Only the SMS sender is stubbed.

## Deliberate omissions

These are known and intentional for now:

- Refresh tokens live in `localStorage`. This is acceptable for the pilot but
  should move to an httpOnly cookie, or be paired with device binding, before
  real farm data is on the system.
- `pnpm start` runs the API through `tsx` rather than a compiled bundle.
- Rate limiting is per IP. Per-account throttling is a Phase 6 item.
- The SMS sender for Africa's Talking is written but untested until an account
  is provisioned.
