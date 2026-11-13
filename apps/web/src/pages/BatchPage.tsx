import { useState, type FormEvent, type ReactNode } from 'react';
import { Link, Navigate, useParams } from 'react-router-dom';
import {
  batchDay,
  canSellOn,
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
} from '@farmatics/shared';
import { useAuth } from '../auth.js';
import { AppLayout } from '../components/AppLayout.js';
import { Alert, Badge, Button, Field } from '../components/ui.js';
import {
  balanceFor,
  feedUsedBy,
  onHandFor,
  toBatches,
  toHouses,
  toMortality,
  toSales,
  toStockItems,
  toStockMovements,
  toTransfers,
  toVaccinations,
  useFarmData,
} from '../local.js';
import { syncClient } from '../offline.js';
import { formatDate } from './PoultryPage.js';

type Action = 'mortality' | 'transfer' | 'sale' | 'vaccination' | 'feed' | null;

interface HistoryRow {
  id: string;
  at: string;
  title: string;
  detail: string;
  tone: 'neutral' | 'green' | 'amber' | 'red';
}

export function BatchPage() {
  const { batchId } = useParams<{ batchId: string }>();
  const { can, online } = useAuth();
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
  const transfers = toTransfers(data.bird_transfers);
  const vaccinations = toVaccinations(data.vaccination_events);
  const stockItems = toStockItems(data.stock_items);
  const movements = toStockMovements(data.stock_movements);

  const balance = balanceFor(batch, mortality, sales, transfers);
  const today = toDateOnly(new Date());
  const day = Math.max(batchDay(batch.arrivalDate, today), 1);
  const sellable = canSellOn(batch.arrivalDate, today);
  const feedUsed = feedUsedBy(batch.id, movements);

  const schedule = vaccinationSchedule(batch.arrivalDate);
  const doneDays = new Set(
    vaccinations.filter((event) => event.batchId === batch.id).map((event) => event.day),
  );

  const history: HistoryRow[] = [
    ...mortality
      .filter((event) => event.batchId === batch.id)
      .map((event) => ({
        id: event.id,
        at: event.recordedAt,
        title: `Mortality: ${event.count} birds`,
        detail: event.cause ?? 'No cause recorded',
        tone: 'red' as const,
      })),
    ...sales
      .filter((event) => event.batchId === batch.id)
      .map((event) => ({
        id: event.id,
        at: event.recordedAt,
        title: `Sale: ${event.count} birds`,
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
            ? `Transferred out: ${event.count} birds`
            : `Transferred in: ${event.count} birds`,
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
  ].sort((left, right) => right.at.localeCompare(left.at));

  async function save(table: string, payload: Record<string, unknown>) {
    try {
      await syncClient.saveRecord(table, crypto.randomUUID(), payload);
      if (online) await syncClient.sync();
      setAction(null);
    } finally {
      setBusy(false);
    }
  }

  function fail(message: string) {
    setError(message);
    setBusy(false);
  }

  return (
    <AppLayout
      title={batch.code}
      subtitle={`${house?.name ?? 'House'} · arrived ${formatDate(batch.arrivalDate)}`}
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
            {batch.dirty && <Badge tone="amber">Not sent</Badge>}
            {batch.status === 'closed' && <Badge>Closed</Badge>}
          </div>
        </div>
        <div className="card-body">
          <div className="status-grid">
            <Stat label="Birds alive" value={balance.live} />
            <Stat label="Arrived" value={balance.initial} />
            <Stat label="Mortality" value={balance.mortality} />
            <Stat label="Sold" value={balance.sold} />
            <Stat label="Transferred" value={balance.transferredOut} />
            <Stat label="Feed used" value={`${feedUsed} kg`} />
          </div>
          {sellable ? (
            <Alert tone="success">
              Brooding finished. Birds from this batch may be sold from{' '}
              {formatDate(saleOpensOn(batch.arrivalDate))}.
            </Alert>
          ) : (
            <Alert tone="info">
              Brooding until {formatDate(saleOpensOn(batch.arrivalDate))} (day 22). Sales recorded
              before then will be refused.
            </Alert>
          )}
        </div>
      </section>

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
                      <Badge tone={state === 'done' ? 'green' : state === 'overdue' ? 'red' : 'amber'}>
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
                      <Button
                        variant="ghost"
                        onClick={() => {
                          setError(null);
                          setAction('vaccination');
                        }}
                      >
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

      <section className="card">
        <div className="card-head">
          <h2 className="card-title">Record work</h2>
        </div>
        <div className="card-body">
          <div className="sync-actions">
            {can('record_mortality') && (
              <Button variant="ghost" onClick={() => setAction('mortality')}>
                Mortality
              </Button>
            )}
            {can('record_transfer') && (
              <Button variant="ghost" onClick={() => setAction('transfer')}>
                Transfer birds
              </Button>
            )}
            {can('record_sale') && (
              <Button variant="ghost" onClick={() => setAction('sale')} disabled={!sellable}>
                Record sale
              </Button>
            )}
            {(can('reserve_feed') || can('record_feeding')) && stockItems.length > 0 && (
              <Button variant="ghost" onClick={() => setAction('feed')}>
                Issue feed
              </Button>
            )}
          </div>
          {action === 'mortality' && (
            <MortalityForm
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
                  await save('mortality_events', parsed.data);
                } catch {
                  fail('Could not save on this phone. Try again.');
                }
              }}
              busy={busy}
            />
          )}
          {action === 'transfer' && (
            <TransferForm
              batches={batches.filter((item) => item.id !== batch.id)}
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
                  await save('bird_transfers', parsed.data);
                } catch {
                  fail('Could not save on this phone. Try again.');
                }
              }}
            />
          )}
          {action === 'sale' && (
            <SaleForm
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
                  await save('bird_sales', parsed.data);
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
                  await save('vaccination_events', parsed.data);
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
                  await save('stock_movements', parsed.data);
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
  onSave,
  onCancel,
  busy,
}: {
  onSave: (payload: { count: number; cause?: string }) => void;
  onCancel: () => void;
  busy: boolean;
}) {
  const [count, setCount] = useState('');
  const [cause, setCause] = useState('');

  return (
    <FormShell title="Record mortality" onCancel={onCancel}>
      <form
        className="form form--inline"
        onSubmit={(event: FormEvent) => {
          event.preventDefault();
          onSave({ count: Number(count), cause: cause.trim() || undefined });
        }}
        noValidate
      >
        <Field
          label="Birds lost"
          type="number"
          inputMode="numeric"
          min={1}
          value={count}
          onChange={(event) => setCount(event.target.value)}
          required
        />
        <Field
          label="Cause"
          value={cause}
          onChange={(event) => setCause(event.target.value)}
          placeholder="e.g. Heat"
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
  onSave,
  onCancel,
  busy,
}: {
  batches: ReturnType<typeof toBatches>;
  onSave: (payload: { toBatchId: string; count: number; note?: string }) => void;
  onCancel: () => void;
  busy: boolean;
}) {
  const [toBatchId, setToBatchId] = useState(batches[0]?.id ?? '');
  const [count, setCount] = useState('');
  const [note, setNote] = useState('');

  return (
    <FormShell title="Transfer birds" onCancel={onCancel}>
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
          label="Birds"
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
        <p className="muted">Add another batch first, then birds can be moved into it.</p>
      )}
    </FormShell>
  );
}

function SaleForm({
  onSave,
  onCancel,
  busy,
}: {
  onSave: (payload: { count: number; buyer?: string; note?: string }) => void;
  onCancel: () => void;
  busy: boolean;
}) {
  const [count, setCount] = useState('');
  const [buyer, setBuyer] = useState('');
  const [note, setNote] = useState('');

  return (
    <FormShell title="Record sale" onCancel={onCancel}>
      <form
        className="form form--inline"
        onSubmit={(event: FormEvent) => {
          event.preventDefault();
          onSave({
            count: Number(count),
            buyer: buyer.trim() || undefined,
            note: note.trim() || undefined,
          });
        }}
        noValidate
      >
        <Field
          label="Birds sold"
          type="number"
          inputMode="numeric"
          min={1}
          value={count}
          onChange={(event) => setCount(event.target.value)}
          required
        />
        <Field label="Buyer" value={buyer} onChange={(event) => setBuyer(event.target.value)} />
        <Field label="Note" value={note} onChange={(event) => setNote(event.target.value)} />
        <Button type="submit" loading={busy}>
          Save
        </Button>
      </form>
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
