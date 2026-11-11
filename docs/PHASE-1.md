# Phase 1 — Foundation

The gate from the build plan:

> An owner registers a farm and creates an employee. That employee signs in on
> a phone online and offline. A test record syncs from two phones.

Two of those three sentences are met. The third needs the sync engine, which
is the next piece of work.

## Tickets

| # | Ticket | State |
| --- | --- | --- |
| 1 | Monorepo scaffold | Done — pnpm workspaces, Turborepo, shared TS config |
| 2 | Schema v1 + RLS | Done — 11 tables, policies, change sequence, triggers |
| 3 | Auth: owner | Done — register, OTP, login, refresh rotation, lockout |
| 4 | Auth: employee | Done — create with temp PIN, PIN sign-in, forced change, suspend, unlock |
| 5 | Offline session bundle | Not started |
| 6 | Sync engine | Not started |
| 7 | Sync UI chrome | Not started |
| 8 | Two-phone test harness | Not started |

## Evidence

```
packages/shared  18 tests   phone normalisation, permission resolution
packages/db       9 tests   RLS isolation, change sequence, SQL splitting
apps/api         19 tests   account flows over HTTP, cross-tenant attempts
```

Notable cases that would otherwise be assumptions:

- The runtime role cannot read another farm's rows even when querying by id.
- The runtime role cannot insert a row belonging to another farm.
- With no farm context set, the runtime role sees nothing.
- The runtime role is denied `sessions` and `otp_codes` outright.
- `change_seq` increases monotonically, so a pull cursor cannot skip a row.
- A replayed refresh token is rejected.
- Five wrong passwords lock the account.
- One farm cannot list, suspend or unlock another farm's employees.
- Suspending an employee revokes their live sessions immediately.

## Verified by hand

Walked through in a browser against the running app:

1. Register "D Ayo Farm" with an owner → verify the six-digit code.
2. Land on the owner dashboard: 18 permissions, 14 offline days, KES.
3. Create an employee → temporary PIN shown once, marked "PIN not set".
4. Sign in as that employee on a second tab → sees 8 stock-keeper permissions
   and no team management.
5. Change the PIN → the "Required" badge clears.

## Bugs found and fixed during that run

- **Refresh race.** Two concurrent refreshes rotated the same token; the loser
  cleared the session the winner had just created. Fixed with a single
  in-flight refresh and a guard that only clears tokens if they were not
  already replaced. `apps/web/src/api.ts`.
- Inline PIN form labels were misaligned when a field had a hint. Fixed in
  `apps/web/src/styles.css`.

## What is stubbed

| Item | Status | Needed for |
| --- | --- | --- |
| SMS delivery | Stub logs the code; the API returns it in development | Real registration |
| Africa's Talking sender | Written, untested until credentials exist | Production |
| Offline PIN unlock | Not built | The gate |
| Sync push/pull | Schema ready, no endpoints | The gate |
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

## Next

1. Offline session bundle: signed claims cached on the device, PIN unlock with
   no network, offline-day limit.
2. Sync engine on one throwaway entity: Dexie store, outbox, push with
   idempotency, pull by cursor, accepted/flagged/rejected.
3. The two-phone harness, including the case the plan cares about most: both
   phones offline, both write, both reconnect, nothing lost or doubled.
