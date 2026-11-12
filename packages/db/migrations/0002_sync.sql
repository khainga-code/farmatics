-- ===========================================================================
-- Sync: the first synced entity.
--
-- `probes` is deliberately a throwaway entity. It exists to prove the sync
-- mechanics - idempotent push, cursor pull, tenant scoping - before real
-- modules depend on them. It is replaced by poultry, store and sales tables
-- as those modules land.
--
-- Idempotency: the primary key IS the id the phone generated, so a retried
-- outbox entry conflicts with itself and is reported as a duplicate instead
-- of being counted twice.
-- ===========================================================================

create table probes (
  id                  uuid primary key,
  farm_id             uuid not null references farms(id) on delete cascade,
  label               text not null,
  value               integer not null,
  -- When the event happened, according to the phone.
  recorded_at         timestamptz not null,
  recorded_by         uuid not null references users(id) on delete restrict,
  -- When the phone said it happened vs when the server saw it. A large gap
  -- means the phone clock is wrong, which the owner should see.
  client_time         timestamptz not null,
  server_time         timestamptz not null default now(),
  clock_skew_seconds  integer not null default 0,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),
  change_seq          bigint not null default nextval('change_seq_seq'),
  deleted_at          timestamptz
);

create index probes_farm_seq_idx on probes (farm_id, change_seq);

create trigger probes_touch before insert or update on probes
  for each row execute function farmatics_touch();

alter table probes enable row level security;

create policy probes_tenant on probes
  using (farm_id = current_farm_id())
  with check (farm_id = current_farm_id());

do $$
begin
  if exists (select 1 from pg_roles where rolname = 'farmatics_app') then
    grant select, insert, update, delete on probes to farmatics_app;
  end if;
exception when others then
  raise notice 'Skipping grants for probes: %', sqlerrm;
end
$$;
