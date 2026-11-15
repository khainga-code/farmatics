# Phase 6 - Hardening

Phase 6 closes the two gaps left in the pilot: sign-in attempts were only
limited per IP address, and the app shell was cached under a hand-written name
with no link to the build that wrote it.

## Per-account sign-in limits

The HTTP rate limit still counts requests per IP. It is now backed by a second
limiter that counts attempts per account, so rotating IP addresses does not buy
an attacker more guesses.

| Route | Key | Attempts | Window |
| --- | --- | --- | --- |
| `POST /auth/register` | phone | 3 | 1 hour |
| `POST /auth/verify` | phone | 10 | 15 minutes |
| `POST /auth/login` | phone | 10 | 15 minutes |
| `POST /auth/staff-login` | username | 10 | 15 minutes |

The window slides: an attempt counts for its full window and then falls out.
A rejected attempt is not recorded, so hammering a blocked key does not extend
its block. A successful password or PIN sign-in clears the key, so earlier
typos do not follow a person around once they are in.

A blocked request answers `429` with code `rate_limited` and a `retryAfter`
detail in seconds. The message is the same whether or not the account exists.

This sits alongside the existing account lockout: five wrong passwords or PINs
still lock the account, and the throttle covers the window around it, including
attempts spread across many addresses.

The limiter is an in-process sliding window. That matches the single API
process the pilot runs. Running more than one API instance needs a shared store
behind the same interface; the module notes this.

## Revisioned app shell

`public/sw.js` is gone. The worker is generated during `vite build` from
`apps/web/tools/sw.ts`:

- Every hashed file in the bundle, plus the built `index.html`, feeds an
  FNV-1a build id. The id becomes the cache name
  (`farmatics-shell-<id>`).
- The precache list is the shell files and every built asset, so a new worker
  installs the whole app before it takes over.
- Activation deletes every cache whose name is not the current one. A phone
  cannot keep serving assets from an older build.
- Registration uses `updateViaCache: 'none'`, so the browser always revalidates
  `sw.js` rather than trusting an HTTP-cached copy.
- Navigation stays network-first with `/index.html` as the offline fallback;
  API calls are never cached.

Because the cache name is derived from the build, two deploys with different
assets always produce a new worker, and a deploy that changes nothing produces
the same one.

## Verification

```
packages/shared   59 tests
packages/sync     17 tests
apps/web          11 tests   includes 4 service-worker revision tests
apps/api          7 throttle tests: the window, the reset, and the route wiring
typecheck          shared, db, sync, api, web
build              web production bundle containing a generated sw.js
```

The HTTP test in `auth.test.ts` makes three registration attempts against one
number from three different IPs, then a fourth from a new address, and confirms
it is refused. A different number from that last address then registers,
proving the limit follows the account and not the address.

That file cannot run on the development machine used for this phase: PGlite
fails to allocate its buffers (`RangeError: Array buffer allocation failed`),
as in Phases 3 to 5. CI runs the API suites serially on a standard runner. The
seven throttle tests use a bare Fastify instance and run locally.

CI also checks that `apps/web/dist/sw.js` exists after the production build, so
the generated worker cannot silently drop out of the bundle.

## Still open

- Refresh tokens still live in `localStorage`; moving them to an httpOnly
  cookie or binding them to the device is not built. The thirty-second rotation
  grace window is deliberate and unchanged.
- The account limiter is per process, as above.
- The SMS sender for Africa's Talking is written but has not run against a real
  account.
- Goat and cattle management remain unbuilt. Reports were built in Phase 7.
