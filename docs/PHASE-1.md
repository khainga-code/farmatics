# Phase 1 — Foundation

The gate from the build plan:

> An owner registers a farm and creates an employee. That employee signs in on
> a phone online and offline. A test record syncs from two phones.

All three sentences are met. The evidence is below.

## Tickets

| # | Ticket | State |
| --- | --- | --- |
| 1 | Monorepo scaffold | Done — pnpm workspaces, Turborepo, shared TS config |
| 2 | Schema v1 + RLS | Done — 11 tables, policies, change sequence, triggers |
| 3 | Auth: owner | Done — register, OTP, login, refresh rotation, lockout |
| 4 | Auth: employee | Done — create with temp PIN, PIN sign-in, forced change, suspend, unlock |
| 5 | Offline session bundle | Done — Dexie session copy, PBKDF2 PIN verifier, 14-day limit, lock screen |
| 6 | Sync engine | Done — outbox, idempotent push, cursor pull, per-record rejection |
| 7 | Sync UI chrome | Done — pending count, last sync, attention list, manual sync |
| 8 | Two-phone test harness | Done — two Dexie databases against the real API and database |

## Evidence

```
packages/shared  18 tests   phone normalisation, permission resolution, wire schemas
packages/db       9 tests   RLS isolation, change sequence, SQL splitting
packages/sync    14 tests   atomic save, push, pull, retry, lock and unlock
apps/api         34 tests   account flows, sync push and pull, two-phone scenarios
```

75 tests in total. Notable cases that would otherwise be assumptions:

- The runtime role cannot read or insert another farm's rows.
- With no farm context set, the runtime role sees nothing.
- `change_seq` increases monotonically, so a pull cursor cannot skip a row.
- A replayed refresh token is rejected, but a token reused within thirty
  seconds is accepted: that is a phone retrying a reply it never received.
- Five wrong passwords lock the account.
- One farm cannot list, suspend or unlock another farm's employees.
- A pushed record is accepted once; replaying the same id reports `duplicate`
  and still returns the original `changeSeq`.
- One bad record in a batch is rejected on its own; the rest are accepted.
- A record claiming another farm's id is rejected, and server-stamped
  ownership always wins.
- Two phones that both write offline then reconnect converge, with nothing
  lost and nothing doubled, including when one ack is lost.
- Pull is per device: each phone keeps its own cursor.
- A phone cannot pull another farm's changes.

## Verified by hand

Walked through in a browser against the running app:

1. Register "D Ayo Farm" with an owner → verify the six-digit code.
2. Land on the owner dashboard: 18 permissions, 14 offline days, KES.
3. Create an employee → temporary PIN shown once, marked "PIN not set".
4. Sign in as that employee with the PIN → forced PIN change, then the
   dashboard shows 8 stock-keeper permissions and no team management.
5. Record a test entry → it appears under "saved on this phone", syncs, and the
   pending count returns to zero.
6. Make the API unreachable and reload → the app opens on the lock screen,
   explains that work is saved locally, and unlocks with the PIN.
7. Record an entry while offline → it stays queued; restore the API → the
   entry reaches the server on the next sync.

## Bugs found and fixed during those runs

- **Refresh race.** Two concurrent refreshes rotated the same token; the loser
  cleared the session the winner had just created. Fixed with a single
  in-flight refresh and a guard that only clears tokens if they were not
  already replaced. `apps/web/src/api.ts`.
- **A server error signed the phone out.** When the refresh call failed with a
  5xx or a proxy error, the client discarded the saved session, so an offline
  phone could no longer be unlocked. Only a definitive 4xx now clears tokens.
  `apps/web/src/api.ts`.
- **Lost rotation reply ended the session.** If the response carrying a new
  refresh token never arrived, the old token was already dead and the phone
  had to sign in again. The server now accepts a just-rotated token for thirty
  seconds, which covers a retry without weakening replay protection beyond a
  short window. `apps/api/src/auth/service.ts`, migration
  `0003_refresh_rotation_grace.sql`.
- **Parallel test runs crashed.** Two embedded Postgres instances in one run
  could exhaust the Node heap. `pnpm test` now runs packages one at a time.
- Inline PIN form labels were misaligned when a field had a hint. Fixed in
  `apps/web/src/styles.css`.

## What is stubbed

| Item | Status | Needed for |
| --- | --- | --- |
| SMS delivery | Stub logs the code; the API returns it in development | Real registration |
| Africa's Talking sender | Written, untested until credentials exist | Production |
| Sync entities | Only the throwaway `probes` entity exists | The real modules |
| Reports, modules | Not started | Phases 2–5 |

## Decisions I made that the client should confirm

These were open in the plan; a reasonable default was chosen so work could
start. Each is cheap to change now, expensive later.

1. **Phone numbers are unique across the whole system**, not per farm. This is
   what lets sign-in resolve the farm without asking for a farm code, and it
   matches "one farm per login". Usernames are likewise global.
2. **Role defaults live in code, not the database.** The `permissions` table
   stores only per-user overrides, so the phone and the server cannot disagree
   about what a role may do.
3. **Approval permissions belong to the owner only** until the client says who
   may approve discounts, stock adjustments and expenses.
4. **Staff lockout is permanent until the owner unlocks**, matching the plan.
   The owner's own lockout expires after fifteen minutes.
5. **Owner sign-up requires a six-digit code even in development**, but the
   code is returned by the API so the flow is testable without SMS.
6. **The offline window is fourteen days.** After that the phone asks for a
   password or PIN sign-in before it will unlock again.
7. **Four modules are still unconfirmed** and are marked open: goat and cattle
   management, vaccination and mortality monitoring, salesperson allocation,
   and finance. No schema or screens have been built for them.

## Next

1. Client confirmation on the four open modules.
2. Replace the `probes` entity with the real module tables, starting with the
   poultry and store flows.
3. Build the module screens on the shared offline and sync foundation.
