-- ===========================================================================
-- Finance: cash in, cash out, and approvals.
--
-- The farm records cash only, so this is a cash book rather than an accounts
-- receivable ledger. A sale carries its price per bird; an expense carries the
-- amount paid. No table stores a running total - revenue, spend and margin are
-- derived from the events, exactly like bird counts and feed on hand.
--
-- Approvals are append-only too. Recording a decision never edits the expense,
-- so an offline phone that pushed the expense still sees the same row and can
-- pull the decision later.
-- ===========================================================================

-- Sales now carry a price. Older queued sales have no price and stay null;
-- reports exclude them instead of counting them as zero.
alter table bird_sales
  add column unit_price_kes numeric(12, 2)
    check (unit_price_kes is null or unit_price_kes >= 0);

create table expenses (
  id                  uuid primary key,
  farm_id             uuid not null references farms(id) on delete cascade,
  category            text not null check (category in (
                        'feed', 'chicks', 'labour', 'veterinary',
                        'transport', 'utilities', 'repairs', 'other'
                      )),
  amount_kes          numeric(14, 2) not null check (amount_kes > 0),
  paid_to             text,
  method              text not null default 'cash' check (method in ('cash', 'mpesa', 'bank', 'other')),
  -- Optional direct cost: an expense tagged to a batch reduces that batch's margin.
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
  deleted_at          timestamptz
);

create table expense_approvals (
  id                  uuid primary key,
  farm_id             uuid not null references farms(id) on delete cascade,
  expense_id          uuid not null references expenses(id) on delete restrict,
  decision            text not null check (decision in ('approved', 'rejected')),
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

create index expenses_farm_seq_idx on expenses (farm_id, change_seq);
create index expenses_batch_idx on expenses (batch_id);
create index expenses_category_idx on expenses (farm_id, category);
create index expense_approvals_farm_seq_idx on expense_approvals (farm_id, change_seq);
create index expense_approvals_expense_idx on expense_approvals (expense_id);

-- One decision per expense. A retried approval collides with itself and is
-- reported as a duplicate; a second, different decision is refused.
create unique index expense_approvals_one_decision on expense_approvals (expense_id)
  where deleted_at is null;

create trigger expenses_touch before insert or update on expenses
  for each row execute function farmatics_touch();
create trigger expense_approvals_touch before insert or update on expense_approvals
  for each row execute function farmatics_touch();

do $$
declare
  table_name text;
  tables text[] := array['expenses', 'expense_approvals'];
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
  raise notice 'Skipping part of the finance grants: %', sqlerrm;
end
$$;
