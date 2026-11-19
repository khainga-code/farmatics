-- ===========================================================================
-- Feed cost and growth.
--
-- Feed is bought by the kilogram, so a delivery may now say what it cost per
-- kilogram. The cost of feed issued to a batch is derived from those delivery
-- prices; no table stores a running cost or a batch's margin.
--
-- A weighing is an event like mortality: a sample of birds and the average
-- weight that sample came to. Growth and feed conversion are derived from the
-- weighings and the feed issues, never typed into a balance.
-- ===========================================================================

alter table stock_movements
  add column unit_cost_kes_per_kg numeric(12, 2)
    check (unit_cost_kes_per_kg is null or unit_cost_kes_per_kg >= 0);

-- Only a delivery buys feed, so only a delivery can carry its price. Issues and
-- adjustments inherit the cost through the feed's average delivery price.
alter table stock_movements
  add constraint stock_movements_cost_on_receipt
  check (unit_cost_kes_per_kg is null or kind = 'receipt');

create table batch_weights (
  id                  uuid primary key,
  farm_id             uuid not null references farms(id) on delete cascade,
  batch_id            uuid not null references batches(id) on delete restrict,
  -- Birds weighed and the average they came to. 100 kg is a guard against a
  -- decimal point in the wrong place, not a poultry weight limit.
  sample_count        integer not null check (sample_count > 0),
  average_weight_kg   numeric(8, 3) not null check (average_weight_kg > 0 and average_weight_kg <= 100),
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

create index stock_movements_item_cost_idx
  on stock_movements (stock_item_id)
  where kind = 'receipt' and unit_cost_kes_per_kg is not null;
create index batch_weights_farm_seq_idx on batch_weights (farm_id, change_seq);
create index batch_weights_batch_idx on batch_weights (batch_id);

create trigger batch_weights_touch before insert or update on batch_weights
  for each row execute function farmatics_touch();

do $$
begin
  execute 'alter table batch_weights enable row level security';
  execute 'create policy batch_weights_tenant on batch_weights
             using (farm_id = current_farm_id())
             with check (farm_id = current_farm_id())';

  if exists (select 1 from pg_roles where rolname = 'farmatics_app') then
    execute 'grant select, insert, update, delete on batch_weights to farmatics_app';
  end if;
exception when others then
  raise notice 'Skipping part of the growth grants: %', sqlerrm;
end
$$;
