import { useState, type FormEvent, type ReactNode } from 'react';
import { Link, Navigate, useParams } from 'react-router-dom';
import {
  MORTALITY_CAUSE_CATEGORIES,
  MORTALITY_CAUSE_LABELS,
  SPECIES_LABELS,
  animalWord,
  batchDay,
  batchFinance,
  canSellOn,
  feedCostKes,
  feedPerKgSoldKg,
  latestWeight,
  maxWeightKg,
  mortalityInputSchema,
  reminderIsDue,
  saleInputSchema,
  saleOpensOn,
  stockMovementInputSchema,
  toDateOnly,
  transferInputSchema,
  vaccinationInputSchema,
  vaccinationSchedule,
  vaccinationState,
  weightInputSchema,
  type MortalityCauseCategory,
  type Species,
} from '@farmatics/shared';
import { useAuth } from '../auth.js';
import { AppLayout } from '../components/AppLayout.js';
import { Alert, Badge, Button, Field } from '../components/ui.js';
import {
  allocationBalanceFor,
  balanceFor,
  feedUsedBy,
  onHandFor,
  toAllocations,
  toBatches,
  toExpenseApprovals,
  toExpenses,
  toHouses,
  toMortality,
  toReturns,
  toSales,
  toStockItems,
  toStockMovements,
  toTransfers,
  toVaccinations,
  toWeights,
  useFarmData,
} from '../local.js';
import { saveAndConfirm } from '../save.js';
import { notify } from '../toast.js';
import { formatKes } from './FinancePage.js';
import { formatDate } from './PoultryPage.js';

type Action = 'mortality' | 'transfer' | 'sale' | 'vaccination' | 'feed' | 'weight' | null;

interface HistoryRow {
  id: string;
  at: string;
  title: string;
  detail: string;
  tone: 'neutral' | 'green' | 'amber' | 'red';
}

export function BatchPage() {
  const { batchId } = useParams<{ batchId: string }>();
  const { user, can, online } = useAuth();
  const { data, loading } = useFarmData();

  const [action, setAction] = useState<Action>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const batches = toBatches(data.batches);
  const batch = batches.find((item) => item.id === batchId);

  if (loading) {
    return (
      <AppLayout title="Batch">
        <p className="muted">Loading this phone’s records…</p>
      </AppLayout>
    );
  }

  if (!batch) return <Navigate to="/poultry" replace />;

  const houses = toHouses(data.houses);
  const house = houses.find((item) => item.id === batch.houseId);
  const mortality = toMortality(data.mortality_events);
  const sales = toSales(data.bird_sales);
  const returns = toReturns(data.bird_returns);
  const transfers = toTransfers(data.bird_transfers);
  const vaccinations = toVaccinations(data.vaccination_events);
  const stockItems = toStockItems(data.stock_items);
  const movements = toStockMovements(data.stock_movements);
  const weights = toWeights(data.batch_weights).filter((sample) => sample.batchId === batch.id);

  const balance = balanceFor(batch, mortality, sales, transfers);
  const species = batch.species;
  const isPoultryBatch = species === 'poultry';
  const animal = (value: number) => animalWord(species, value);
  const feed = feedCostKes(
    movements.filter((movement) => movement.kind === 'issue' && movement.batchId === batch.id),
    movements,
  );
  const finance = batchFinance(
    batch.id,
    sales,
    toExpenses(data.expenses),
    toExpenseApprovals(data.expense_approvals),
    feed,
  );
  const today = toDateOnly(new Date());
  const day = Math.max(batchDay(batch.arrivalDate, today), 1);
  const sellable = canSellOn(batch.arrivalDate, today, species);
  const feedUsed = feedUsedBy(batch.id, movements);
  const latest = latestWeight(weights);
  const feedPerKgSold = latest
    ? feedPerKgSoldKg(feedUsed, balance.sold, latest.averageWeightKg)
    : null;

  // A salesperson sells from their own allocation; the owner and manager may
  // record a walk-in sale without one.
  const saleAllocations = toAllocations(data.sales_allocations)
    .filter((allocation) => allocation.batchId === batch.id)
    .filter(
      (allocation) => user?.role !== 'salesperson' || allocation.salespersonId === user?.id,
    )
    .map((allocation) => ({
      id: allocation.id,
      ...allocationBalanceFor(allocation, sales, returns),
    }))
    .filter((allocation) => allocation.remaining > 0);
  const saleNeedsAllocation = user?.role === 'salesperson';

  const schedule = isPoultryBatch ? vaccinationSchedule(batch.arrivalDate) : [];
  const doneDays = new Set(
    vaccinations.filter((event) => event.batchId === batch.id).map((event) => event.day),
  );
  const transferTargets = batches.filter(
    (item) => item.id !== batch.id && item.species === species,
  );

  const history: HistoryRow[] = [
    ...mortality
      .filter((event) => event.batchId === batch.id)
      .map((event) => ({
        id: event.id,
        at: event.recordedAt,
        title: `Mortality: ${event.count} ${animal(event.count)}`,
        detail:
          [
            event.causeCategory ? MORTALITY_CAUSE_LABELS[event.causeCategory] : null,
            event.cause,
          ]
            .filter(Boolean)
            .join(' · ') || 'No cause recorded',
        tone: 'red' as const,
      })),
    ...sales
      .filter((event) => event.batchId === batch.id)
      .map((event) => ({
        id: event.id,
        at: event.recordedAt,
        title: `Sale: ${event.count} ${animal(event.count)}`,
        detail: event.buyer ? `Buyer: ${event.buyer}` : 'No buyer recorded',
        tone: 'green' as const,
      })),
    ...transfers
      .filter((event) => event.fromBatchId === batch.id || event.toBatchId === batch.id)
      .map((event) => ({
        id: event.id,
        at: event.recordedAt,
        title:
          event.fromBatchId === batch.id
            ? `Transferred out: ${event.count} ${animal(event.count)}`
            : `Transferred in: ${event.count} ${animal(event.count)}`,
        detail:
          batches.find(
            (item) =>
              item.id ===
              (event.fromBatchId === batch.id ? event.toBatchId : event.fromBatchId),
          )?.code ?? 'Another batch',
        tone: 'neutral' as const,
      })),
    ...vaccinations
      .filter((event) => event.batchId === batch.id)
      .map((event) => ({
        id: event.id,
        at: event.recordedAt,
        title: `Vaccination (day ${event.day})`,
        detail: event.note ?? 'Recorded',
        tone: 'green' as const,
      })),
    ...movements
      .filter((movement) => movement.kind === 'issue' && movement.batchId === batch.id)
      .map((movement) => ({
        id: movement.id,
        at: movement.recordedAt,
        title: `Feed issued: ${movement.quantityKg} kg`,
        detail:
          stockItems.find((item) => item.id === movement.stockItemId)?.name ?? 'Feed',
        tone: 'neutral' as const,
      })),
    ...weights.map((sample) => ({
      id: sample.id,
      at: sample.recordedAt,
      title: `Weight check: ${sample.averageWeightKg} kg average`,
      detail: `${sample.sampleCount} ${animal(sample.sampleCount)} weighed${
        sample.note ? ` · ${sample.note}` : ''
      }`,
      tone: 'neutral' as const,
    })),
  ].sort((left, right) => right.at.localeCompare(left.at));

  async function save(
    table: string,
    payload: Record<string, unknown>,
    message: string,
  ) {
    try {
      await saveAndConfirm(
        [{ table, id: crypto.randomUUID(), data: payload }],
        message,
        online,
      );
      setError(null);
      setAction(null);
    } finally {
      setBusy(false);
    }
  }

  function start(next: Exclude<Action, null>) {
    setError(null);
    setAction(next);
  }

  function fail(message: string) {
    setError(message);
    notify(message, 'error');
    setBusy(false);
  }

  return (
    <AppLayout
      title={batch.code}
      subtitle={`${SPECIES_LABELS[species]} · ${house?.name ?? 'House'} · arrived ${formatDate(batch.arrivalDate)}`}
      actions={
        <Link className="btn btn--ghost" to="/poultry">
          Back to batches
        </Link>
      }
    >
      {error && <Alert tone="error">{error}</Alert>}

      <section className="card">
        <div className="card-head">
          <h2 className="card-title">This batch</h2>
          <div className="chips">
            <Badge tone={sellable ? 'green' : 'neutral'}>Day {day}</Badge>
            <Badge>{SPECIES_LABELS[species]}</Badge>
            {batch.dirty && <Badge tone="amber">Not sent</Badge>}
            {batch.status === 'closed' && <Badge>Closed</Badge>}
          </div>
        </div>
        <div className="card-body">
          <div className="status-grid">
            <Stat label="Animals alive" value={balance.live} />
            <Stat label="Arrived" value={balance.initial} />
            <Stat label="Mortality" value={balance.mortality} />
            <Stat label="Sold" value={balance.sold} />
            <Stat label="Transferred" value={balance.transferredOut} />
            <Stat label="Feed used" value={`${feedUsed} kg`} />
            <Stat
              label="Avg weight"
              value={latest ? `${latest.averageWeightKg} kg` : '—'}
            />
            <Stat
              label="Feed per kg sold"
              value={feedPerKgSold === null ? '—' : `${feedPerKgSold} kg`}
            />
          </div>
          {latest && (
            <p className="muted">
              Average weight from {latest.sampleCount} {animal(latest.sampleCount)} weighed{' '}
              {formatDate(latest.recordedAt.slice(0, 10))}. Feed per kg sold values every animal
              sold at that latest average.
            </p>
          )}
          {isPoultryBatch ? (
            sellable ? (
              <Alert tone="success">
                Brooding finished. Birds from this batch may be sold from{' '}
                {formatDate(saleOpensOn(batch.arrivalDate))}.
              </Alert>
            ) : (
              <Alert tone="info">
                Brooding until {formatDate(saleOpensOn(batch.arrivalDate))} (day 22). Sales
                recorded before then will be refused.
              </Alert>
            )
          ) : (
            <Alert tone="success">
              No brooding period. {SPECIES_LABELS[species]} may be sold from the arrival day.
            </Alert>
          )}
        </div>
      </section>

      {can('view_finance') && (
        <section className="card">
          <div className="card-head">
            <h2 className="card-title">Money for this batch</h2>
            <Badge>KES</Badge>
          </div>
          <div className="card-body">
            <div className="status-grid">
              <div>
                <div className="status-label">Revenue</div>
                <div className="status-value">{formatKes(finance.revenueKes)}</div>
              </div>
              <div>
                <div className="status-label">Direct costs</div>
                <div className="status-value">{formatKes(finance.expensesKes)}</div>
              </div>
              <div>
                <div className="status-label">Feed cost</div>
                <div className="status-value">{formatKes(finance.feedCostKes)}</div>
              </div>
              <div>
                <div className="status-label">Margin</div>
                <div className="status-value money--strong">
                  {formatKes(finance.marginKes)}
                </div>
              </div>
            </div>
            {finance.unpricedSales > 0 && (
              <Alert tone="warning">
                {finance.unpricedSales} sale
                {finance.unpricedSales === 1 ? ' has' : 's have'} no price and{' '}
                {finance.unpricedSales === 1 ? 'is' : 'are'} not counted in revenue.
              </Alert>
            )}
            {finance.uncostedFeedKg > 0 && (
              <Alert tone="warning">
                {finance.uncostedFeedKg} kg of the feed issued to this batch has no delivery
                price, so that cost is missing from the margin. Add the price when receiving
                feed in the store.
              </Alert>
            )}
            <p className="muted">
              Direct costs are approved expenses tagged to this batch. Feed cost values issued
              feed at its average delivery price; record a feed purchase as a priced delivery,
              not also as a feed expense, or it will count twice.
            </p>
          </div>
        </section>
      )}

      {isPoultryBatch && (
        <section className="card">
          <div className="card-head">
            <h2 className="card-title">Vaccinations</h2>
          </div>
          <div className="card-body">
            <ul className="list">
              {schedule.map((dose) => {
                const done = doneDays.has(dose.day);
                const state = vaccinationState(dose, today, done);
                return (
                  <li className="list-item" key={dose.day}>
                    <div>
                      <div className="list-title">
                        {dose.label}
                        <Badge
                          tone={state === 'done' ? 'green' : state === 'overdue' ? 'red' : 'amber'}
                        >
                          {state === 'done' ? 'Done' : state}
                        </Badge>
                      </div>
                      <div className="list-sub">
                        Due {formatDate(dose.dueOn)}
                        {!done && reminderIsDue(dose, today) && ' · reminder is open'}
                      </div>
                    </div>
                    {!done && can('record_vaccination') && (
                      <div className="list-actions">
                        <Button variant="ghost" onClick={() => start('vaccination')}>
                          Record
                        </Button>
                      </div>
                    )}
                  </li>
                );
              })}
            </ul>
          </div>
        </section>
      )}

      <section className="card">
        <div className="card-head">
          <h2 className="card-title">Record work</h2>
        </div>
        <div className="card-body">
          <div className="sync-actions">
            {can('record_mortality') && (
              <Button variant="ghost" onClick={() => start('mortality')}>
                Mortality
              </Button>
            )}
            {can('record_transfer') && (
              <Button
                variant="ghost"
                onClick={() => start('transfer')}
                disabled={transferTargets.length === 0}
              >
                Transfer animals
              </Button>
            )}
            {can('record_sale') && (
              <Button
                variant="ghost"
                onClick={() => start('sale')}
                disabled={!sellable || (saleNeedsAllocation && saleAllocations.length === 0)}
              >
                Record sale
              </Button>
            )}
            {(can('reserve_feed') || can('record_feeding')) && stockItems.length > 0 && (
              <Button variant="ghost" onClick={() => start('feed')}>
                Issue feed
              </Button>
            )}
            {can('record_growth') && (
              <Button variant="ghost" onClick={() => start('weight')}>
                Record weight
              </Button>
            )}
          </div>
          {action === 'mortality' && (
            <MortalityForm
              species={species}
              onCancel={() => setAction(null)}
              onSave={async (payload) => {
                const parsed = mortalityInputSchema.safeParse({
                  batchId: batch.id,
                  ...payload,
                  recordedAt: new Date().toISOString(),
                });
                if (!parsed.success) return fail(parsed.error.issues[0]?.message ?? 'Check the entry.');
                setBusy(true);
                try {
                  await save('mortality_events', parsed.data, 'Mortality recorded');
                } catch {
                  fail('Could not save on this phone. Try again.');
                }
              }}
              busy={busy}
            />
          )}
          {action === 'transfer' && (
            <TransferForm
              batches={transferTargets}
              species={species}
              onCancel={() => setAction(null)}
              busy={busy}
              onSave={async (payload) => {
                const parsed = transferInputSchema.safeParse({
                  fromBatchId: batch.id,
                  ...payload,
                  recordedAt: new Date().toISOString(),
                });
                if (!parsed.success) return fail(parsed.error.issues[0]?.message ?? 'Check the entry.');
                setBusy(true);
                try {
                  await save('bird_transfers', parsed.data, 'Transfer recorded');
                } catch {
                  fail('Could not save on this phone. Try again.');
                }
              }}
            />
          )}
          {action === 'sale' && (
            <SaleForm
              allocations={saleAllocations}
              allocationRequired={saleNeedsAllocation}
              species={species}
              onCancel={() => setAction(null)}
              busy={busy}
              onSave={async (payload) => {
                const parsed = saleInputSchema.safeParse({
                  batchId: batch.id,
                  ...payload,
                  recordedAt: new Date().toISOString(),
                });
                if (!parsed.success) return fail(parsed.error.issues[0]?.message ?? 'Check the entry.');
                setBusy(true);
                try {
                  await save('bird_sales', parsed.data, 'Sale recorded');
                } catch {
                  fail('Could not save on this phone. Try again.');
                }
              }}
            />
          )}
          {action === 'vaccination' && (
            <VaccinationForm
              doses={schedule.filter((dose) => !doneDays.has(dose.day))}
              onCancel={() => setAction(null)}
              busy={busy}
              onSave={async (day) => {
                const parsed = vaccinationInputSchema.safeParse({
                  batchId: batch.id,
                  day: day as 12 | 21,
                  recordedAt: new Date().toISOString(),
                });
                if (!parsed.success) return fail(parsed.error.issues[0]?.message ?? 'Check the entry.');
                setBusy(true);
                try {
                  await save('vaccination_events', parsed.data, 'Vaccination recorded');
                } catch {
                  fail('Could not save on this phone. Try again.');
                }
              }}
            />
          )}
          {action === 'feed' && (
            <FeedForm
              items={stockItems.map((item) => ({
                ...item,
                onHand: onHandFor(item.id, movements),
              }))}
              onCancel={() => setAction(null)}
              busy={busy}
              onSave={async (payload) => {
                const parsed = stockMovementInputSchema.safeParse({
                  kind: 'issue',
                  batchId: batch.id,
                  ...payload,
                  recordedAt: new Date().toISOString(),
                });
                if (!parsed.success) return fail(parsed.error.issues[0]?.message ?? 'Check the entry.');
                setBusy(true);
                try {
                  await save('stock_movements', parsed.data, 'Feed issued');
                } catch {
                  fail('Could not save on this phone. Try again.');
                }
              }}
            />
          )}
          {action === 'weight' && (
            <WeightForm
              last={latest}
              species={species}
              onCancel={() => setAction(null)}
              busy={busy}
              onSave={async (payload) => {
                const parsed = weightInputSchema.safeParse({
                  batchId: batch.id,
                  ...payload,
                  recordedAt: new Date().toISOString(),
                });
                if (!parsed.success) return fail(parsed.error.issues[0]?.message ?? 'Check the entry.');
                setBusy(true);
                try {
                  await save('batch_weights', parsed.data, 'Weight recorded');
                } catch {
                  fail('Could not save on this phone. Try again.');
                }
              }}
            />
          )}
        </div>
      </section>

      <section className="card">
        <div className="card-head">
          <h2 className="card-title">History</h2>
          <Badge>{history.length}</Badge>
        </div>
        <div className="card-body">
          {history.length === 0 ? (
            <p className="muted">Nothing recorded for this batch yet.</p>
          ) : (
            <ul className="list">
              {history.map((row) => (
                <li className="list-item" key={row.id}>
                  <div>
                    <div className="list-title">
                      {row.title}
                      {row.tone !== 'neutral' && <Badge tone={row.tone}>recorded</Badge>}
                    </div>
                    <div className="list-sub">{row.detail}</div>
                  </div>
                  <div className="list-sub">{formatWhen(row.at)}</div>
                </li>
              ))}
            </ul>
          )}
        </div>
      </section>
    </AppLayout>
  );
}

function Stat({ label, value }: { label: string; value: string | number }) {
  return (
    <div>
      <div className="status-label">{label}</div>
      <div className="status-value">{value}</div>
    </div>
  );
}

function formatWhen(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? value
    : date.toLocaleDateString(undefined, { day: 'numeric', month: 'short' });
}

function FormShell({
  title,
  children,
  onCancel,
}: {
  title: string;
  children: ReactNode;
  onCancel: () => void;
}) {
  return (
    <div className="record-form">
      <div className="card-head card-head--flat">
        <h3 className="card-title">{title}</h3>
        <Button variant="ghost" type="button" onClick={onCancel}>
          Cancel
        </Button>
      </div>
      {children}
    </div>
  );
}

function MortalityForm({
  species,
  onSave,
  onCancel,
  busy,
}: {
  species: Species;
  onSave: (payload: {
    count: number;
    cause?: string;
    causeCategory?: MortalityCauseCategory;
  }) => void;
  onCancel: () => void;
  busy: boolean;
}) {
  const [count, setCount] = useState('');
  const [cause, setCause] = useState('');
  const [category, setCategory] = useState<MortalityCauseCategory | ''>('');

  return (
    <FormShell title="Record mortality" onCancel={onCancel}>
      <form
        className="form form--inline"
        onSubmit={(event: FormEvent) => {
          event.preventDefault();
          onSave({
            count: Number(count),
            cause: cause.trim() || undefined,
            causeCategory: category || undefined,
          });
        }}
        noValidate
      >
        <Field
          label={`${SPECIES_LABELS[species]} lost`}
          type="number"
          inputMode="numeric"
          min={1}
          value={count}
          onChange={(event) => setCount(event.target.value)}
          required
        />
        <div className="field">
          <label className="field-label" htmlFor="mortality-category">
            What happened
          </label>
          <select
            id="mortality-category"
            className="input"
            value={category}
            onChange={(event) =>
              setCategory(event.target.value as MortalityCauseCategory | '')
            }
          >
            <option value="">Not sure</option>
            {MORTALITY_CAUSE_CATEGORIES.map((item) => (
              <option key={item} value={item}>
                {MORTALITY_CAUSE_LABELS[item]}
              </option>
            ))}
          </select>
        </div>
        <Field
          label="Detail (optional)"
          value={cause}
          onChange={(event) => setCause(event.target.value)}
          placeholder="e.g. Gumboro suspected"
        />
        <Button type="submit" loading={busy}>
          Save
        </Button>
      </form>
    </FormShell>
  );
}

function TransferForm({
  batches,
  species,
  onSave,
  onCancel,
  busy,
}: {
  batches: ReturnType<typeof toBatches>;
  species: Species;
  onSave: (payload: { toBatchId: string; count: number; note?: string }) => void;
  onCancel: () => void;
  busy: boolean;
}) {
  const [toBatchId, setToBatchId] = useState(batches[0]?.id ?? '');
  const [count, setCount] = useState('');
  const [note, setNote] = useState('');

  return (
    <FormShell title={`Transfer ${animalWord(species, 2)}`} onCancel={onCancel}>
      <form
        className="form form--inline"
        onSubmit={(event: FormEvent) => {
          event.preventDefault();
          onSave({ toBatchId, count: Number(count), note: note.trim() || undefined });
        }}
        noValidate
      >
        <div className="field">
          <label className="field-label" htmlFor="transfer-to">
            Receiving batch
          </label>
          <select
            id="transfer-to"
            className="input"
            value={toBatchId}
            onChange={(event) => setToBatchId(event.target.value)}
          >
            {batches.map((item) => (
              <option key={item.id} value={item.id}>
                {item.code}
              </option>
            ))}
          </select>
        </div>
        <Field
          label="Animals"
          type="number"
          inputMode="numeric"
          min={1}
          value={count}
          onChange={(event) => setCount(event.target.value)}
          required
        />
        <Field label="Note" value={note} onChange={(event) => setNote(event.target.value)} />
        <Button type="submit" loading={busy} disabled={!toBatchId}>
          Save
        </Button>
      </form>
      {batches.length === 0 && (
        <p className="muted">
          Add another batch of the same species first, then animals can be moved into it.
        </p>
      )}
    </FormShell>
  );
}

interface SaleAllocationOption {
  id: string;
  remaining: number;
}

function SaleForm({
  allocations = [],
  allocationRequired = false,
  species,
  onSave,
  onCancel,
  busy,
}: {
  allocations?: SaleAllocationOption[];
  allocationRequired?: boolean;
  species: Species;
  onSave: (payload: {
    count: number;
    buyer?: string;
    note?: string;
    unitPriceKes?: number;
    allocationId?: string;
  }) => void;
  onCancel: () => void;
  busy: boolean;
}) {
  const [allocationId, setAllocationId] = useState(allocations[0]?.id ?? '');
  const [count, setCount] = useState('');
  const [price, setPrice] = useState('');
  const [buyer, setBuyer] = useState('');
  const [note, setNote] = useState('');

  const total = Number(count) * Number(price);
  const showTotal = Number.isFinite(total) && total > 0;
  const missingAllocation = allocationRequired && !allocationId;

  return (
    <FormShell title="Record sale" onCancel={onCancel}>
      <form
        className="form form--inline"
        onSubmit={(event: FormEvent) => {
          event.preventDefault();
          if (missingAllocation) return;
          onSave({
            count: Number(count),
            buyer: buyer.trim() || undefined,
            note: note.trim() || undefined,
            unitPriceKes: price.trim() ? Number(price) : undefined,
            allocationId: allocationRequired ? allocationId : undefined,
          });
        }}
        noValidate
      >
        {allocationRequired && (
          <div className="field">
            <label className="field-label" htmlFor="sale-form-allocation">
              Allocated animals
            </label>
            <select
              id="sale-form-allocation"
              className="input"
              value={allocationId}
              onChange={(event) => setAllocationId(event.target.value)}
            >
              {allocations.map((allocation) => (
                <option key={allocation.id} value={allocation.id}>
                  {allocation.remaining} left
                </option>
              ))}
            </select>
          </div>
        )}
        <Field
          label={`${SPECIES_LABELS[species]} sold`}
          type="number"
          inputMode="numeric"
          min={1}
          value={count}
          onChange={(event) => setCount(event.target.value)}
          required
        />
        <Field
          label="Price per animal (KES)"
          type="number"
          inputMode="decimal"
          min={0}
          step="0.01"
          value={price}
          onChange={(event) => setPrice(event.target.value)}
          hint={showTotal ? `Total ${formatKes(total)}` : 'Leave empty only if the price is unknown.'}
        />
        <Field label="Buyer" value={buyer} onChange={(event) => setBuyer(event.target.value)} />
        <Field label="Note" value={note} onChange={(event) => setNote(event.target.value)} />
        <Button type="submit" loading={busy} disabled={missingAllocation}>
          Save
        </Button>
      </form>
      {missingAllocation && (
        <p className="muted">
          No animals are allocated to you on this batch. Ask the farm manager for an allocation on
          the Sales screen.
        </p>
      )}
    </FormShell>
  );
}

function VaccinationForm({
  doses,
  onSave,
  onCancel,
  busy,
}: {
  doses: ReturnType<typeof vaccinationSchedule>;
  onSave: (day: number) => void;
  onCancel: () => void;
  busy: boolean;
}) {
  const [day, setDay] = useState(doses[0]?.day ?? 12);

  return (
    <FormShell title="Record vaccination" onCancel={onCancel}>
      <form
        className="form form--inline"
        onSubmit={(event: FormEvent) => {
          event.preventDefault();
          onSave(day);
        }}
        noValidate
      >
        <div className="field">
          <label className="field-label" htmlFor="vaccination-day">
            Dose
          </label>
          <select
            id="vaccination-day"
            className="input"
            value={day}
            onChange={(event) => setDay(Number(event.target.value))}
          >
            {doses.map((dose) => (
              <option key={dose.day} value={dose.day}>
                {dose.label}
              </option>
            ))}
          </select>
        </div>
        <Button type="submit" loading={busy}>
          Save
        </Button>
      </form>
    </FormShell>
  );
}

function WeightForm({
  last,
  species,
  onSave,
  onCancel,
  busy,
}: {
  last: ReturnType<typeof latestWeight>;
  species: Species;
  onSave: (payload: { sampleCount: number; averageWeightKg: number; note?: string }) => void;
  onCancel: () => void;
  busy: boolean;
}) {
  const [sampleCount, setSampleCount] = useState('');
  const [averageWeight, setAverageWeight] = useState('');
  const [note, setNote] = useState('');

  return (
    <FormShell title="Record weight" onCancel={onCancel}>
      <form
        className="form form--inline"
        onSubmit={(event: FormEvent) => {
          event.preventDefault();
          onSave({
            sampleCount: Number(sampleCount),
            averageWeightKg: Number(averageWeight),
            note: note.trim() || undefined,
          });
        }}
        noValidate
      >
        <Field
          label="Animals weighed"
          type="number"
          inputMode="numeric"
          min={1}
          value={sampleCount}
          onChange={(event) => setSampleCount(event.target.value)}
          hint="The sample the average comes from."
          required
        />
        <Field
          label="Average weight (kg)"
          type="number"
          inputMode="decimal"
          min={0.01}
          max={maxWeightKg(species)}
          step="0.01"
          value={averageWeight}
          onChange={(event) => setAverageWeight(event.target.value)}
          hint={
            last
              ? `Last reading ${last.averageWeightKg} kg on ${formatDate(last.recordedAt.slice(0, 10))}`
              : `${SPECIES_LABELS[species]} are recorded up to ${maxWeightKg(species)} kg.`
          }
          required
        />
        <Field label="Note" value={note} onChange={(event) => setNote(event.target.value)} />
        <Button type="submit" loading={busy}>
          Save
        </Button>
      </form>
    </FormShell>
  );
}

function FeedForm({
  items,
  onSave,
  onCancel,
  busy,
}: {
  items: Array<{ id: string; name: string; onHand: number; unit: string }>;
  onSave: (payload: { stockItemId: string; quantityKg: number; note?: string }) => void;
  onCancel: () => void;
  busy: boolean;
}) {
  const [stockItemId, setStockItemId] = useState(items[0]?.id ?? '');
  const [quantity, setQuantity] = useState('');
  const [note, setNote] = useState('');
  const selected = items.find((item) => item.id === stockItemId);

  return (
    <FormShell title="Issue feed" onCancel={onCancel}>
      <form
        className="form form--inline"
        onSubmit={(event: FormEvent) => {
          event.preventDefault();
          onSave({
            stockItemId,
            quantityKg: Number(quantity),
            note: note.trim() || undefined,
          });
        }}
        noValidate
      >
        <div className="field">
          <label className="field-label" htmlFor="feed-item">
            Feed
          </label>
          <select
            id="feed-item"
            className="input"
            value={stockItemId}
            onChange={(event) => setStockItemId(event.target.value)}
          >
            {items.map((item) => (
              <option key={item.id} value={item.id}>
                {item.name} ({item.onHand} kg left)
              </option>
            ))}
          </select>
        </div>
        <Field
          label="Weight (kg)"
          type="number"
          inputMode="decimal"
          min={0.01}
          step="0.01"
          value={quantity}
          onChange={(event) => setQuantity(event.target.value)}
          hint={selected ? `${selected.onHand} kg on hand` : undefined}
          required
        />
        <Field label="Note" value={note} onChange={(event) => setNote(event.target.value)} />
        <Button type="submit" loading={busy} disabled={!stockItemId}>
          Save
        </Button>
      </form>
    </FormShell>
  );
}
