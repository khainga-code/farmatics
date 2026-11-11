-- ===========================================================================
-- Farmatics schema v1 - accounts, devices, sessions, audit.
--
-- Isolation model
--   Every business row carries farm_id. The API connects as `farmatics_app`,
--   which is NOT the table owner and holds no BYPASSRLS attribute, so the
--   policies below are enforced on every query. Migrations and the auth
--   module connect as the owner role, which bypasses RLS by design.
--
-- Sync model
--   Every synced row gets a change_seq from one sequence. The trigger takes
--   an advisory lock on the farm id first, so two writes to the same farm are
--   committed in change_seq order. That lets a phone resume a pull at a
--   cursor without ever missing or duplicating a row.
-- ===========================================================================

-- The runtime role. Skipped when the deploying user cannot create roles.
do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'farmatics_app') then
    begin
      create role farmatics_app login password 'local_dev_password'
        nosuperuser nocreatedb nocreaterole nobypassrls;
    exception when insufficient_privilege then
      raise notice 'Skipping farmatics_app role creation: %', sqlerrm;
    end;
  end if;
end
$$;

create sequence if not exists change_seq_seq;

-- ---------------------------------------------------------------------------
-- Helpers
-- ---------------------------------------------------------------------------

-- The farm the current request is acting for. Set per transaction by the API
-- with: select set_config('app.farm_id', $1, true)
create or replace function current_farm_id() returns uuid
language sql stable as $$
  select nullif(current_setting('app.farm_id', true), '')::uuid;
$$;

-- Assigns change_seq and maintains updated_at.
create or replace function farmatics_touch() returns trigger
language plpgsql as $$
declare
  fid uuid;
begin
  fid := nullif(to_jsonb(new) ->> 'farm_id', '')::uuid;

  -- farms is its own tenant, so it has no farm_id column.
  if fid is null then
    fid := nullif(to_jsonb(new) ->> 'id', '')::uuid;
  end if;

  if fid is not null then
    perform pg_advisory_xact_lock(hashtextextended(fid::text, 0));
  end if;

  new.change_seq := nextval('change_seq_seq');

  if TG_OP = 'UPDATE' and (to_jsonb(new) ? 'updated_at') then
    new.updated_at := now();
  end if;

  return new;
end
$$;

-- ---------------------------------------------------------------------------
-- Tenants
-- ---------------------------------------------------------------------------

create table farms (
  id                  uuid primary key default gen_random_uuid(),
  name                text not null,
  currency            text not null default 'KES',
  offline_days_allowed integer not null default 14
                      check (offline_days_allowed between 1 and 90),
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),
  change_seq          bigint not null default nextval('change_seq_seq'),
  deleted_at          timestamptz
);

-- ---------------------------------------------------------------------------
-- Accounts
-- ---------------------------------------------------------------------------

create table users (
  id                uuid primary key default gen_random_uuid(),
  farm_id           uuid not null references farms(id) on delete restrict,
  name              text not null,
  -- Globally unique: it is how sign-in finds the right farm without asking
  -- the user for a farm code. Matches the agreed "one farm per login".
  phone             text not null,
  -- Staff sign in with a username instead of a phone number.
  username          text,
  role              text not null
                    check (role in ('owner','farm_manager','stock_keeper','salesperson')),
  status            text not null default 'active'
                    check (status in ('active','suspended')),
  password_hash     text,
  pin_hash          text,
  must_change_pin   boolean not null default false,
  failed_attempts   integer not null default 0,
  locked_until      timestamptz,
  last_login_at     timestamptz,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),
  change_seq        bigint not null default nextval('change_seq_seq'),
  deleted_at        timestamptz
);

create unique index users_phone_key
  on users (phone)
  where deleted_at is null;

create unique index users_username_key
  on users (lower(username))
  where username is not null and deleted_at is null;

create index users_farm_idx on users (farm_id);

-- One row per registered phone, so a single phone can be cut off without
-- suspending the whole account.
create table devices (
  id             uuid primary key default gen_random_uuid(),
  farm_id        uuid not null references farms(id) on delete restrict,
  user_id        uuid not null references users(id) on delete cascade,
  label          text,
  platform       text,
  app_version    text,
  status         text not null default 'active'
                 check (status in ('active','blocked','revoked')),
  registered_at  timestamptz not null default now(),
  last_seen_at   timestamptz,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),
  change_seq     bigint not null default nextval('change_seq_seq'),
  deleted_at     timestamptz
);

create index devices_farm_idx on devices (farm_id, user_id);

-- Refresh tokens. Access tokens are short lived and never stored.
create table sessions (
  id                  uuid primary key default gen_random_uuid(),
  farm_id             uuid not null references farms(id) on delete cascade,
  user_id             uuid not null references users(id) on delete cascade,
  device_id           uuid references devices(id) on delete set null,
  refresh_token_hash  text not null,
  expires_at          timestamptz not null,
  revoked_at          timestamptz,
  user_agent          text,
  ip                  text,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),
  change_seq          bigint not null default nextval('change_seq_seq')
);

create unique index sessions_refresh_key on sessions (refresh_token_hash);
create index sessions_user_idx on sessions (user_id);

-- One-time codes. `payload` holds the hashed password and names for a pending
-- farm registration, so nothing sensitive is kept in plain text while the
-- owner waits for the SMS.
create table otp_codes (
  id           uuid primary key default gen_random_uuid(),
  farm_id      uuid references farms(id) on delete cascade,
  phone        text not null,
  purpose      text not null
               check (purpose in ('register','reset_password','reset_pin')),
  code_hash    text not null,
  payload      jsonb,
  attempts     integer not null default 0,
  expires_at   timestamptz not null,
  consumed_at  timestamptz,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  change_seq   bigint not null default nextval('change_seq_seq')
);

create index otp_codes_lookup_idx
  on otp_codes (phone, purpose, created_at desc)
  where consumed_at is null;

-- ---------------------------------------------------------------------------
-- Permissions
--
-- Role defaults live in @farmatics/shared so the phone and the server can
-- never drift. This table stores only per-user overrides.
-- ---------------------------------------------------------------------------

create table permissions (
  id          uuid primary key default gen_random_uuid(),
  farm_id     uuid not null references farms(id) on delete cascade,
  user_id     uuid not null references users(id) on delete cascade,
  permission  text not null,
  allowed     boolean not null,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  change_seq  bigint not null default nextval('change_seq_seq')
);

create unique index permissions_user_permission_key
  on permissions (user_id, permission);

-- ---------------------------------------------------------------------------
-- Audit
-- ---------------------------------------------------------------------------

create table audit_log (
  id            uuid primary key default gen_random_uuid(),
  farm_id       uuid not null references farms(id) on delete cascade,
  actor_user_id uuid references users(id) on delete set null,
  action        text not null,
  record_type   text,
  record_id     uuid,
  before        jsonb,
  after         jsonb,
  ip            text,
  user_agent    text,
  created_at    timestamptz not null default now(),
  change_seq    bigint not null default nextval('change_seq_seq')
);

create index audit_log_farm_time_idx on audit_log (farm_id, created_at desc);

-- ---------------------------------------------------------------------------
-- Sync bookkeeping (server side only; never sent to phones)
-- ---------------------------------------------------------------------------

create table device_sync_state (
  device_id      uuid primary key references devices(id) on delete cascade,
  farm_id        uuid not null references farms(id) on delete cascade,
  last_pull_seq  bigint not null default 0,
  last_push_at   timestamptz,
  updated_at     timestamptz not null default now()
);

-- ---------------------------------------------------------------------------
-- Triggers
-- ---------------------------------------------------------------------------

create trigger farms_touch before insert or update on farms
  for each row execute function farmatics_touch();
create trigger users_touch before insert or update on users
  for each row execute function farmatics_touch();
create trigger devices_touch before insert or update on devices
  for each row execute function farmatics_touch();
create trigger sessions_touch before insert or update on sessions
  for each row execute function farmatics_touch();
create trigger otp_codes_touch before insert or update on otp_codes
  for each row execute function farmatics_touch();
create trigger permissions_touch before insert or update on permissions
  for each row execute function farmatics_touch();
create trigger audit_log_touch before insert or update on audit_log
  for each row execute function farmatics_touch();

-- ---------------------------------------------------------------------------
-- Row level security
-- ---------------------------------------------------------------------------

alter table farms            enable row level security;
alter table users            enable row level security;
alter table devices          enable row level security;
alter table sessions         enable row level security;
alter table otp_codes        enable row level security;
alter table permissions      enable row level security;
alter table audit_log        enable row level security;
alter table device_sync_state enable row level security;

create policy farms_tenant on farms
  using (id = current_farm_id())
  with check (id = current_farm_id());

create policy users_tenant on users
  using (farm_id = current_farm_id())
  with check (farm_id = current_farm_id());

create policy devices_tenant on devices
  using (farm_id = current_farm_id())
  with check (farm_id = current_farm_id());

create policy permissions_tenant on permissions
  using (farm_id = current_farm_id())
  with check (farm_id = current_farm_id());

create policy audit_log_tenant on audit_log
  using (farm_id = current_farm_id())
  with check (farm_id = current_farm_id());

create policy device_sync_state_tenant on device_sync_state
  using (farm_id = current_farm_id())
  with check (farm_id = current_farm_id());

-- Sessions and one-time codes are reached only through the auth module on
-- the owner connection. The runtime role is denied outright rather than
-- scoped, because a sign-in query runs before a farm is known.
create policy sessions_admin_only on sessions
  using (false) with check (false);

create policy otp_codes_admin_only on otp_codes
  using (false) with check (false);

-- ---------------------------------------------------------------------------
-- Grants for the runtime role
-- ---------------------------------------------------------------------------

do $$
begin
  if exists (select 1 from pg_roles where rolname = 'farmatics_app') then
    grant usage on schema public to farmatics_app;
    grant select, insert, update, delete on all tables in schema public to farmatics_app;
    grant usage, select on all sequences in schema public to farmatics_app;
  end if;
exception when others then
  raise notice 'Skipping grants for farmatics_app: %', sqlerrm;
end
$$;
