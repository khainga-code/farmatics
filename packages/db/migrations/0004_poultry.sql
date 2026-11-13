-- ===========================================================================
-- Poultry and feed.
--
-- Counts are events, balances are derived. A batch starts at arrival; every
-- mortality, transfer, sale and vaccination is one immutable row. Nothing in
-- this schema stores "birds alive" or "feed on hand", because a stored balance
-- is a balance two phones can disagree about.
--
-- The same sync model as `probes`: the primary key is the id the phone made,
-- `change_seq` is assigned by the farmatics_touch trigger under the per-farm
-- advisory lock, and deletes are soft.
-- ===========================================================================

create table houses (
  id                  uuid primary key,
  farm_id             uuid not null references farms(id) on delete cascade,
  name                text not null,
  note                text,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),
  change_seq          bigint not null default nextval('change_seq_seq'),
  deleted_at          timestamptz
);

create table batches (
  id                  uuid primary key,
  farm_id             uuid not null references farms(id) on delete cascade,
  house_id            uuid not null references houses(id) on delete restrict,
  code                text not null,
  breed               text,
  -- Day 1 of the batch. Sale opens on day 22, vaccinations on days 12 and 21.
  arrival_date        date not null,
  initial_count       integer not null check (initial_count > 0),
  status              text not null default 'active' check (status in ('active', 'closed')),
  closed_at           timestamptz,
  note                text,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),
  change_seq          bigint not null default nextval('change_seq_seq'),
  deleted_at          timestamptz
);

create table mortality_events (
  id                  uuid primary key,
  farm_id             uuid not null references farms(id) on delete cascade,
  batch_id            uuid not null references batches(id) on delete restrict,
  count               integer not null check (count > 0),
  cause               text,
  recorded_at         timestamptz not null,
  recorded_by         uuid not null references users(id) on delete restrict,
  client_time         timestamptz,
  server_time         timestamptz not null default now(),
  clock_skew_seconds  integer not null default 0,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),
  change_seq          bigint not null default nextval('change_seq_seq'),
  deleted_at          timestamptz
);

create table bird_transfers (
  id                  uuid primary key,
  farm_id             uuid not null references farms(id) on delete cascade,
  from_batch_id       uuid not null references batches(id) on delete restrict,
  to_batch_id         uuid not null references batches(id) on delete restrict,
  count               integer not null check (count > 0),
  note                text,
  recorded_at         timestamptz not null,
  recorded_by         uuid not null references users(id) on delete restrict,
  client_time         timestamptz,
  server_time         timestamptz not null default now(),
  clock_skew_seconds  integer not null default 0,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),
  change_seq          bigint not null default nextval('change_seq_seq'),
  deleted_at          timestamptz,
  constraint bird_transfers_two_batches check (from_batch_id <> to_batch_id)
);

create table bird_sales (
  id                  uuid primary key,
  farm_id             uuid not null references farms(id) on delete cascade,
  batch_id            uuid not null references batches(id) on delete restrict,
  count               integer not null check (count > 0),
  buyer               text,
  note                text,
  recorded_at         timestamptz not null,
  recorded_by         uuid not null references users(id) on delete restrict,
  client_time         timestamptz,
  server_time         timestamptz not null default now(),
  clock_skew_seconds  integer not null default 0,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),
  change_seq          bigint not null default nextval('change_seq_seq'),
  deleted_at          timestamptz
);

create table vaccination_events (
  id                  uuid primary key,
  farm_id             uuid not null references farms(id) on delete cascade,
  batch_id            uuid not null references batches(id) on delete restrict,
  -- The scheduled dose this event completes: day 12 or day 21.
  day                 integer not null check (day in (12, 21)),
  note                text,
  recorded_at         timestamptz not null,
  recorded_by         uuid not null references users(id) on delete restrict,
  client_time         timestamptz,
  server_time         timestamptz not null default now(),
  clock_skew_seconds  integer not null default 0,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),
  change_seq          bigint not null default nextval('change_seq_seq'),
  deleted_at          timestamptz
);

create table stock_items (
  id                  uuid primary key,
  farm_id             uuid not null references farms(id) on delete cascade,
  name                text not null,
  category            text not null default 'feed' check (category in ('feed')),
  -- Feed is recorded in kilograms, as the farm asked.
  unit                text not null default 'kg' check (unit = 'kg'),
  reorder_level_kg    numeric(12, 2) check (reorder_level_kg >= 0),
  active              boolean not null default true,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),
  change_seq          bigint not null default nextval('change_seq_seq'),
  deleted_at          timestamptz
);

create table stock_movements (
  id                  uuid primary key,
  farm_id             uuid not null references farms(id) on delete cascade,
  stock_item_id       uuid not null references stock_items(id) on delete restrict,
  -- Receipts add, issues subtract, adjustments carry their own sign.
  kind                text not null check (kind in ('receipt', 'issue', 'adjustment')),
  quantity_kg         numeric(12, 2) not null check (quantity_kg <> 0),
  batch_id            uuid references batches(id) on delete restrict,
  note                text,
  recorded_at         timestamptz not null,
  recorded_by         uuid not null references users(id) on delete restrict,
  client_time         timestamptz,
  server_time         timestamptz not null default now(),
  clock_skew_seconds  integer not null default 0,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),
  change_seq          bigint not null default nextval('change_seq_seq'),
  deleted_at          timestamptz,
  constraint stock_movements_positive check (kind = 'adjustment' or quantity_kg > 0),
  constraint stock_movements_issue_has_batch check (kind <> 'issue' or batch_id is not null)
);

create index houses_farm_seq_idx on houses (farm_id, change_seq);
create index batches_farm_seq_idx on batches (farm_id, change_seq);
create index batches_house_idx on batches (farm_id, house_id);
create index mortality_events_farm_seq_idx on mortality_events (farm_id, change_seq);
create index mortality_events_batch_idx on mortality_events (batch_id);
create index bird_transfers_farm_seq_idx on bird_transfers (farm_id, change_seq);
create index bird_transfers_from_idx on bird_transfers (from_batch_id);
create index bird_transfers_to_idx on bird_transfers (to_batch_id);
create index bird_sales_farm_seq_idx on bird_sales (farm_id, change_seq);
create index bird_sales_batch_idx on bird_sales (batch_id);
create index vaccination_events_farm_seq_idx on vaccination_events (farm_id, change_seq);
create index vaccination_events_batch_idx on vaccination_events (batch_id);
create index stock_items_farm_seq_idx on stock_items (farm_id, change_seq);
create index stock_movements_farm_seq_idx on stock_movements (farm_id, change_seq);
create index stock_movements_item_idx on stock_movements (stock_item_id);

-- A batch code is how the farm talks about a flock, so it must not repeat
-- inside one farm while the batch is alive.
create unique index batches_code_unique on batches (farm_id, lower(code))
  where deleted_at is null;

create trigger houses_touch before insert or update on houses
  for each row execute function farmatics_touch();
create trigger batches_touch before insert or update on batches
  for each row execute function farmatics_touch();
create trigger mortality_events_touch before insert or update on mortality_events
  for each row execute function farmatics_touch();
create trigger bird_transfers_touch before insert or update on bird_transfers
  for each row execute function farmatics_touch();
create trigger bird_sales_touch before insert or update on bird_sales
  for each row execute function farmatics_touch();
create trigger vaccination_events_touch before insert or update on vaccination_events
  for each row execute function farmatics_touch();
create trigger stock_items_touch before insert or update on stock_items
  for each row execute function farmatics_touch();
create trigger stock_movements_touch before insert or update on stock_movements
  for each row execute function farmatics_touch();

-- Tenancy is applied to every new table in one place, so a table cannot be
-- added later without a policy by accident.
do $$
declare
  table_name text;
  tables text[] := array[
    'houses', 'batches', 'mortality_events', 'bird_transfers', 'bird_sales',
    'vaccination_events', 'stock_items', 'stock_movements'
  ];
begin
  foreach table_name in array tables loop
    execute format('alter table %I enable row level security', table_name);
    execute format(
      'create policy %I on %I using (farm_id = current_farm_id()) with check (farm_id = current_farm_id())',
      table_name || '_tenant',
      table_name
    );

    if exists (select 1 from pg_roles where rolname = 'farmatics_app') then
      execute format(
        'grant select, insert, update, delete on %I to farmatics_app',
        table_name
      );
    end if;
  end loop;
exception when others then
  raise notice 'Skipping part of the poultry grants: %', sqlerrm;
end
$$;
