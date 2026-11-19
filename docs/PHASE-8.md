# Phase 8 - Going live

Phases 1 to 7 built the product. Phase 8 makes it safe to run outside a
developer's machine: the API gets a container image, the dangerous defaults
that were fine in development now refuse to start in production, and this file
is the runbook for the first real deploy.

There are no new tables, endpoints or screens.

## What runs where

```
phone / browser
      |
      |  https
      v
Cloudflare Workers           static assets from apps/web/dist
      |
      |  https, CORS
      v
API container                Node 22, Fastify, one instance
      |
      v
Postgres                     owner role + farmatics_app (RLS)
```

The browser app and the API are separate origins. The app calls
`$VITE_API_URL/api/v1/...`, and the API answers only origins listed in
`CORS_ORIGINS`.

The embedded PGlite database stays a development tool. It is a filesystem
database on one machine: replacing the machine loses the farm, and two API
processes cannot share it.

## What changed in this phase

| Change | Why |
| --- | --- |
| Production requires `CORS_ORIGINS` and rejects anything but `https` | A localhost default would deploy an app whose sign-in is blocked by CORS |
| Demo seeding exits when `NODE_ENV=production` | `pnpm seed` creates an owner with a published password |
| Boot warns on the embedded database and the stub SMS sender | Both are silent data or delivery failures in production |
| `apps/web` production build fails without a valid `VITE_API_URL` | The URL is baked into the bundle; a missing value ships an app that cannot reach the server |
| `apps/api/Dockerfile` | The API runs the same way on any container host |

## Before the first deploy

### 1. Create the database and both roles

Use the provider's owner or admin login for `DATABASE_ADMIN_URL`. The API
runtime uses the restricted login for `DATABASE_URL`.

Create the runtime role **before** running migrations, with the same password
you will put in `DATABASE_URL`:

```sql
create role farmatics_app login password '<strong password>'
  nosuperuser nocreatedb nocreaterole nobypassrls;
```

This ordering matters. `0001_init.sql` only creates `farmatics_app` when it
does not exist, and the login it creates carries the development password
`local_dev_password`. When the role already exists, migrations leave its
password alone and only grant it table access.

If the admin login cannot create roles, migrations log a notice and skip the
grants, and the API then fails on its first query. Create the role with the
provider's console first.

Point `DATABASE_URL` at `farmatics_app`, not the owner. When both URLs are the
same the API warns at boot, because then row level security is not enforced.

### 2. Set the API environment

| Variable | Required | Value |
| --- | --- | --- |
| `NODE_ENV` | yes | `production` |
| `CORS_ORIGINS` | yes | The browser origin, for example `https://farmatics.<account>.workers.dev`; comma separated for more than one, `https` only |
| `JWT_SECRET` | yes | 32+ random characters, generated for production |
| `DATABASE_URL` | yes | `postgres://farmatics_app:...@host/db` (add `?sslmode=require` if the host requires TLS) |
| `DATABASE_ADMIN_URL` | yes | The owner login, same database |
| `SMS_PROVIDER` | yes | `africastalking`; `stub` only logs the code |
| `AFRICASTALKING_USERNAME`, `AFRICASTALKING_API_KEY` | with the provider | Credentials for the SMS account |
| `AFRICASTALKING_SENDER_ID` | no | Approved sender name |
| `AUTO_MIGRATE` | no | `true` applies migrations at boot instead of a separate step |
| `PORT` | no | `4000` by default; most hosts inject their own |
| `ACCESS_TOKEN_TTL_MINUTES`, `REFRESH_TOKEN_TTL_DAYS`, `OTP_TTL_MINUTES` | no | 15, 30 and 10 by default |

All API secrets belong in the host's environment settings, never in a
committed file.

### 3. Apply migrations

Build the image first, then run the migration command from the same image so
the SQL files match the code being deployed:

```bash
docker build -t farmatics-api .

docker run --rm --env-file .env.production farmatics-api \
  pnpm --filter @farmatics/db migrate
```

Migrations are forward-only and recorded in `farmatics_meta.migrations`. Run
them before starting the new image. A migration that drops or renames a column
must deploy in two steps - one release that stops using it, then a later one
that removes it.

### 4. Start the API

```bash
docker run -d --name farmatics-api --restart unless-stopped \
  -p 4000:4000 --env-file .env.production farmatics-api
```

The image has a health check that calls `/health`. Put it behind HTTPS at a
hostname such as `api.farm.example.com`; the browser will not call a plain
`http` API from a deployed PWA.

Run **one** instance. The per-account sign-in limiter lives in process memory,
so a second instance would give an attacker a second set of attempts.

## Deploying the web app

The Workers project runs at the repository root with no build command:

| Setting | Value |
| --- | --- |
| Root directory | `/` |
| Build command | none |
| Deploy command | `npx wrangler deploy` |

The root `wrangler.jsonc` uploads `apps/web/dist`, and the root `postinstall`
hook builds the app when `WORKERS_CI=1` is set. `VITE_API_URL` must be
available to that build:

- Add `VITE_API_URL=https://api.farm.example.com` to the project's Build
  variables, without a trailing slash.
- If build variables do not reach the install step, add
  `pnpm --filter @farmatics/web build` as the project's build command instead.
  Build commands always receive Build variables, and the second build then
  replaces the one from install.

The build now stops with an explicit message when `VITE_API_URL` is missing,
not `https`, or ends in a slash, rather than deploying a PWA that cannot sign
in.

The Worker's origin (workers.dev or a custom domain) goes into the API's
`CORS_ORIGINS`, and the API is restarted after that change. A custom domain
means two origins if the workers.dev address stays enabled.

## First-run checklist

1. `GET https://api.farm.example.com/health` returns `"driver": "postgres"`.
2. `GET https://api.farm.example.com/health/db` returns `{"status":"ok"}`.
3. A preflight from the web origin is allowed:
   `curl -i -X OPTIONS https://api.farm.example.com/api/v1/auth/login -H "Origin: https://farmatics.<account>.workers.dev" -H "Access-Control-Request-Method: POST"`
   returns `access-control-allow-origin`.
4. Register the owner on the deployed site and confirm the one-time code
   arrives by SMS.
5. Verify the phone, sign in, create a house and a batch.
6. Sign in on a second phone and confirm a sale written on one appears on the
   other.
7. Install the PWA, then reload with the phone in airplane mode and unlock
   with the PIN.
8. Deploy a trivial web change and confirm the phone picks up the new shell
   after a reload; the service worker name changes with the build.

Do not run `pnpm seed` against production. It exits when `NODE_ENV` is
`production`; the first owner is created by registering.

## Operations

- **Backups.** A nightly `pg_dump` of the database, kept off the database host,
  with a restore tried before launch. The embedded database has no backup
  story.
- **Logs.** Fastify logs JSON and redacts authorization headers, passwords and
  PINs. Keep the API logs; the stub SMS sender writes codes there, which is
  another reason it must not be used in production.
- **New employees.** The owner creates the account and hands over the temporary
  PIN in person; no SMS is involved.
- **More than one API instance** needs the limiter moved to a shared store
  first. It is the only in-memory state that matters across requests.

## Rollback

- **Web:** roll back to the previous deployment in the Cloudflare project, or
  revert the commit and redeploy. The service worker installs the older shell
  from the older build.
- **API:** run the previous image tag. Tag images with the commit, for example
  `farmatics-api:633e09a`, so the previous one still exists locally.
- **Database:** migrations are not reversed. Keep each release compatible with
  the schema before and after its migration; restore a dump only as a last
  resort.

## Verification

```
pnpm typecheck                     5 packages
apps/api config tests              4 tests: https-only origins, missing CORS, dev default
apps/web tests                     44 tests
web build without VITE_API_URL     fails with the build message
web build with VITE_API_URL        production bundle and generated service worker
pnpm seed with NODE_ENV=production exits with the refusal message
```

The Docker image was not built here: Docker is not installed on this machine.
The Dockerfile is a straight workspace install plus `pnpm --filter
@farmatics/api start`; build it once on the deploy host before the first
launch.

## Still open

- No hosting account, database or SMS account is wired into this repository.
  The values above are the contract, not the credentials.
- The Africa's Talking sender is still untested against a live account.
- There is no shared limiter store, so the API runs as one instance.
- No automated backup, uptime alert or log drain is configured.
- Feed cost in batch margin and weight recording were built in Phase 9.
- Goat and cattle management was added in Phase 10: a batch now carries a
  species and reuses the same event model.
