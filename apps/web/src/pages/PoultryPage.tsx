import { useState, type FormEvent } from 'react';
import { Link } from 'react-router-dom';
import {
  batchDay,
  batchInputSchema,
  canSellOn,
  houseInputSchema,
  reminderIsDue,
  saleOpensOn,
  toDateOnly,
  vaccinationSchedule,
  vaccinationState,
} from '@farmatics/shared';
import type { NewRecord } from '@farmatics/sync';
import { useAuth } from '../auth.js';
import { AppLayout } from '../components/AppLayout.js';
import { Alert, Badge, Button, Field } from '../components/ui.js';
import {
  balanceFor,
  toBatches,
  toHouses,
  toMortality,
  toSales,
  toTransfers,
  toVaccinations,
  useFarmData,
} from '../local.js';
import { saveAndConfirm } from '../save.js';
import { notify } from '../toast.js';

export function formatDate(dateOnly: string): string {
  if (!dateOnly) return '';
  const date = new Date(`${dateOnly}T00:00:00`);
  return Number.isNaN(date.getTime()) ? dateOnly : date.toLocaleDateString();
}

export function PoultryPage() {
  const { can, online } = useAuth();
  const { data, loading } = useFarmData();
  const canSetup = can('manage_setup');
  const [showForm, setShowForm] = useState(false);

  const houses = toHouses(data.houses);
  const batches = toBatches(data.batches).sort((left, right) =>
    right.arrivalDate.localeCompare(left.arrivalDate),
  );
  const mortality = toMortality(data.mortality_events);
  const sales = toSales(data.bird_sales);
  const transfers = toTransfers(data.bird_transfers);
  const vaccinations = toVaccinations(data.vaccination_events);

  const today = toDateOnly(new Date());

  const reminders = batches.flatMap((batch) =>
    vaccinationSchedule(batch.arrivalDate)
      .filter((dose) => !isDone(vaccinations, batch.id, dose.day))
      .filter((dose) => reminderIsDue(dose, today))
      .map((dose) => ({ batch, dose, state: vaccinationState(dose, today, false) })),
  );

  return (
    <AppLayout
      title="Poultry"
      subtitle="Batches, mortality, transfers and vaccinations"
      actions={
        canSetup && (
          <Button variant="ghost" onClick={() => setShowForm((open) => !open)}>
            {showForm ? 'Cancel' : 'New batch'}
          </Button>
        )
      }
    >
      {showForm && canSetup && (
        <NewBatchCard
          houses={houses}
          existingCodes={batches.map((batch) => batch.code)}
          online={online}
          onDone={() => setShowForm(false)}
        />
      )}

      {reminders.length > 0 && (
        <section className="card">
          <div className="card-head">
            <h2 className="card-title">Vaccination reminders</h2>
            <Badge tone="amber">{reminders.length}</Badge>
          </div>
          <div className="card-body">
            <ul className="list">
              {reminders.map(({ batch, dose, state }) => (
                <li className="list-item" key={`${batch.id}-${dose.day}`}>
                  <div>
                    <div className="list-title">
                      <Link to={`/poultry/${batch.id}`}>{batch.code}</Link>
                      <Badge tone={state === 'overdue' ? 'red' : 'amber'}>
                        {dose.label}
                      </Badge>
                    </div>
                    <div className="list-sub">
                      {state === 'overdue' ? 'Was due' : 'Due'} {formatDate(dose.dueOn)} · reminder
                      opened {formatDate(dose.remindOn)}
                    </div>
                  </div>
                </li>
              ))}
            </ul>
          </div>
        </section>
      )}

      <section className="card">
        <div className="card-head">
          <h2 className="card-title">Batches</h2>
          <Badge>{batches.length}</Badge>
        </div>
        <div className="card-body">
          {loading ? (
            <p className="muted">Loading this phone’s records…</p>
          ) : batches.length === 0 ? (
            <p className="muted">
              No batches yet.{' '}
              {canSetup
                ? 'Add the first house and batch to start counting from arrival day.'
                : 'Your farm manager will set one up.'}
            </p>
          ) : (
            <ul className="list">
              {batches.map((batch) => {
                const balance = balanceFor(batch, mortality, sales, transfers);
                const house = houses.find((item) => item.id === batch.houseId);
                const day = batchDay(batch.arrivalDate, today);
                const sellable = canSellOn(batch.arrivalDate, today);
                return (
                  <li className="list-item" key={batch.id}>
                    <div>
                      <div className="list-title">
                        <Link to={`/poultry/${batch.id}`}>{batch.code}</Link>
                        {batch.dirty && <Badge tone="amber">Not sent</Badge>}
                        <Badge tone={sellable ? 'green' : 'neutral'}>
                          Day {Math.max(day, 1)}
                        </Badge>
                      </div>
                      <div className="list-sub">
                        {house?.name ?? 'Unknown house'} · {balance.live} birds ·{' '}
                        {sellable
                          ? 'ready to sell'
                          : `selling opens ${formatDate(saleOpensOn(batch.arrivalDate))}`}
                      </div>
                    </div>
                    <div className="list-actions">
                      <Link className="btn btn--ghost" to={`/poultry/${batch.id}`}>
                        Open
                      </Link>
                    </div>
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      </section>
    </AppLayout>
  );
}

function isDone(
  vaccinations: ReturnType<typeof toVaccinations>,
  batchId: string,
  day: number,
): boolean {
  return vaccinations.some((event) => event.batchId === batchId && event.day === day);
}

function NewBatchCard({
  houses,
  existingCodes,
  online,
  onDone,
}: {
  houses: ReturnType<typeof toHouses>;
  existingCodes: string[];
  online: boolean;
  onDone: () => void;
}) {
  const [form, setForm] = useState({
    houseId: houses[0]?.id ?? '',
    newHouse: '',
    code: '',
    breed: '',
    arrivalDate: toDateOnly(new Date()),
    initialCount: '100',
  });
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function onSubmit(event: FormEvent) {
    event.preventDefault();
    setError(null);

    const code = form.code.trim();
    if (existingCodes.some((existing) => existing.toLowerCase() === code.toLowerCase())) {
      setError('Another batch already uses that code.');
      return;
    }

    setBusy(true);
    try {
      let houseId = form.houseId;
      const records: NewRecord[] = [];

      if (form.newHouse.trim()) {
        const house = houseInputSchema.safeParse({ name: form.newHouse });
        if (!house.success) {
          setError(house.error.issues[0]?.message ?? 'Give the house a name.');
          return;
        }
        houseId = crypto.randomUUID();
        records.push({ table: 'houses', id: houseId, data: house.data });
      }

      if (!houseId) {
        setError('Choose a house, or name a new one.');
        return;
      }

      const parsed = batchInputSchema.safeParse({
        houseId,
        code,
        breed: form.breed.trim() || undefined,
        arrivalDate: form.arrivalDate,
        initialCount: Number(form.initialCount),
      });
      if (!parsed.success) {
        setError(parsed.error.issues[0]?.message ?? 'Check the batch details.');
        return;
      }

      records.push({ table: 'batches', id: crypto.randomUUID(), data: parsed.data });
      await saveAndConfirm(records, 'Batch saved', online);
      onDone();
    } catch {
      const text = 'Could not save the batch on this phone. Try again.';
      setError(text);
      notify(text, 'error');
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="card">
      <div className="card-head">
        <h2 className="card-title">New batch</h2>
        <Badge>Day 1 is the arrival date</Badge>
      </div>
      <div className="card-body">
        {error && <Alert tone="error">{error}</Alert>}
        <form className="form form--inline" onSubmit={onSubmit} noValidate>
          <div className="field">
            <label className="field-label" htmlFor="batch-house">
              House
            </label>
            <select
              id="batch-house"
              className="input"
              value={form.houseId}
              onChange={(event) =>
                setForm((current) => ({ ...current, houseId: event.target.value }))
              }
            >
              <option value="">Choose a house…</option>
              {houses.map((house) => (
                <option key={house.id} value={house.id}>
                  {house.name}
                </option>
              ))}
            </select>
          </div>
          <Field
            label="Or new house name"
            value={form.newHouse}
            onChange={(event) =>
              setForm((current) => ({ ...current, newHouse: event.target.value }))
            }
            placeholder="e.g. House 2"
            hint="Leave empty to use a house above."
          />
          <Field
            label="Batch code"
            value={form.code}
            onChange={(event) => setForm((current) => ({ ...current, code: event.target.value }))}
            placeholder="e.g. B-2026-01"
            required
          />
          <Field
            label="Breed"
            value={form.breed}
            onChange={(event) => setForm((current) => ({ ...current, breed: event.target.value }))}
            placeholder="e.g. Ross 308"
          />
          <Field
            label="Arrival date"
            type="date"
            value={form.arrivalDate}
            onChange={(event) =>
              setForm((current) => ({ ...current, arrivalDate: event.target.value }))
            }
            required
          />
          <Field
            label="Birds on arrival"
            type="number"
            inputMode="numeric"
            min={1}
            value={form.initialCount}
            onChange={(event) =>
              setForm((current) => ({ ...current, initialCount: event.target.value }))
            }
            required
          />
          <Button type="submit" loading={busy}>
            Save batch
          </Button>
        </form>
        <p className="muted">
          Vaccinations fall on day 12 and day 21. Reminders open three days before each.
        </p>
      </div>
    </section>
  );
}
