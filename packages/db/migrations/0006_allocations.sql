-- ===========================================================================
-- Salesperson allocation.
--
-- A salesperson sells only from birds the farm handed them. Allocating birds
-- does not change the batch's live count: the birds stay alive until a sale
-- records that they left. The allocation balance is therefore derived:
--
--   remaining = allocated - sold - returned
--
-- Sales and returns are ordinary immutable events, so two phones cannot
-- disagree about how many birds a salesperson still has.
-- ===========================================================================

create table sales_allocations (
  id                  uuid primary key,
  farm_id             uuid not null references farms(id) on delete cascade,
  batch_id            uuid not null references batches(id) on delete restrict,
  -- The person who may sell these birds.
  salesperson_id      uuid not null references users(id) on delete restrict,
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
  deleted_at          timestamptz
);

-- Unsold birds coming back from a salesperson. A return restores the
-- allocation's remainder; it never adds birds to the batch, because the birds
-- were never removed from the flock when they were allocated.
create table bird_returns (
  id                  uuid primary key,
  farm_id             uuid not null references farms(id) on delete cascade,
  allocation_id       uuid not null references sales_allocations(id) on delete restrict,
  count               integer not null check (count > 0),
  reason              text,
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

-- A sale may name the allocation it came from. Walk-in sales recorded by the
-- owner or manager have no allocation and stay valid.
alter table bird_sales
  add column allocation_id uuid references sales_allocations(id) on delete restrict;

-- Feed handed over with the birds is an ordinary store issue, tagged with the
-- allocation so the phone can show how much went out with each salesperson.
-- Feed on hand stays derived from stock movements; there is no second balance.
alter table stock_movements
  add column allocation_id uuid references sales_allocations(id) on delete restrict;

create index sales_allocations_farm_seq_idx on sales_allocations (farm_id, change_seq);
create index sales_allocations_batch_idx on sales_allocations (batch_id);
create index sales_allocations_salesperson_idx on sales_allocations (salesperson_id);
create index bird_returns_farm_seq_idx on bird_returns (farm_id, change_seq);
create index bird_returns_allocation_idx on bird_returns (allocation_id);
create index bird_sales_allocation_idx on bird_sales (allocation_id);
create index stock_movements_allocation_idx on stock_movements (allocation_id);

create trigger sales_allocations_touch before insert or update on sales_allocations
  for each row execute function farmatics_touch();
create trigger bird_returns_touch before insert or update on bird_returns
  for each row execute function farmatics_touch();

do $$
declare
  table_name text;
  tables text[] := array['sales_allocations', 'bird_returns'];
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
  raise notice 'Skipping part of the allocation grants: %', sqlerrm;
end
$$;
