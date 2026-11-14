import { useEffect, useState, type FormEvent, type ReactNode } from 'react';
import {
  allocationInputSchema,
  birdReturnInputSchema,
  saleInputSchema,
  stockMovementInputSchema,
  type UserDto,
} from '@farmatics/shared';
import type { NewRecord } from '@farmatics/sync';
import { api, ApiError } from '../api.js';
import { useAuth } from '../auth.js';
import { AppLayout } from '../components/AppLayout.js';
import { Alert, Badge, Button, Field } from '../components/ui.js';
import {
  allocationBalanceFor,
  feedAllocatedFor,
  toAllocations,
  toBatches,
  toReturns,
  toSales,
  toStockItems,
  toStockMovements,
  useFarmData,
  type SalesAllocation,
} from '../local.js';
import { saveAndConfirm } from '../save.js';
import { notify } from '../toast.js';
import { formatKes } from './FinancePage.js';
import { formatDate } from './PoultryPage.js';

/**
 * Salesperson allocation.
 *
 * The owner or farm manager gives birds to a salesperson; the salesperson sells
 * from that allocation and hands unsold birds back. All three are ordinary
 * queued writes, so the screen works in a shed with no signal. The balance is
 * derived from the events the phone already holds.
 */

type Action = 'allocate' | 'sell' | 'return' | null;

const TEAM_CACHE = 'farmatics.team';

function cachedTeam(): UserDto[] {
  try {
    const raw = localStorage.getItem(TEAM_CACHE);
    const parsed: unknown = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed) ? (parsed as UserDto[]) : [];
  } catch {
    return [];
  }
}

export function SalesPage() {
  const { user, can, online } = useAuth();
  const { data, loading } = useFarmData();

  const [action, setAction] = useState<Action>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [team, setTeam] = useState<UserDto[]>(cachedTeam);
  const [teamError, setTeamError] = useState<string | null>(null);

  const canAllocate = can('allocate_stock');
  const canSell = can('record_sale');
  const canReturn = can('record_return');
  const canFeed = can('record_feeding') || can('reserve_feed');

  const batches = toBatches(data.batches).filter((batch) => batch.status === 'active');
  const sales = toSales(data.bird_sales);
  const returns = toReturns(data.bird_returns);
  const stockItems = toStockItems(data.stock_items).filter((item) => item.active);
  const movements = toStockMovements(data.stock_movements);
  const allocations = toAllocations(data.sales_allocations).sort((left, right) =>
    right.recordedAt.localeCompare(left.recordedAt),
  );

  const isSalesperson = user?.role === 'salesperson';
  const visible = isSalesperson
    ? allocations.filter((allocation) => allocation.salespersonId === user?.id)
    : allocations;
  const open = visible.filter(
    (allocation) => allocationBalanceFor(allocation, sales, returns).remaining > 0,
  );

  useEffect(() => {
    if (!canAllocate || !online) return;
    let cancelled = false;

    void api
      .listEmployees()
      .then((employees) => {
        if (cancelled) return;
        setTeam(employees);
        setTeamError(null);
        try {
          localStorage.setItem(TEAM_CACHE, JSON.stringify(employees));
        } catch {
          // The cache is a convenience; a full disk must not break the screen.
        }
      })
      .catch((caught) => {
        if (!cancelled) {
          setTeamError(
            caught instanceof ApiError ? caught.message : 'Could not load the team.',
          );
        }
      });

    return () => {
      cancelled = true;
    };
  }, [canAllocate, online]);

  const salespeople = team.filter(
    (employee) => employee.role === 'salesperson' && employee.status === 'active',
  );

  function start(next: Exclude<Action, null>) {
    setError(null);
    setAction(next);
  }

  async function saveRecords(records: NewRecord[], message: string) {
    try {
      await saveAndConfirm(records, message, online);
      setError(null);
      setAction(null);
    } catch {
      const text = 'Could not save on this phone. Try again.';
      setError(text);
      notify(text, 'error');
    } finally {
      setBusy(false);
    }
  }

  async function save(table: string, payload: Record<string, unknown>, message: string) {
    await saveRecords([{ table, id: crypto.randomUUID(), data: payload }], message);
  }

  function fail(message: string) {
    setError(message);
    notify(message, 'error');
    setBusy(false);
  }

  const soldTotal = visible.reduce(
    (total, allocation) => total + allocationBalanceFor(allocation, sales, returns).sold,
    0,
  );

  return (
    <AppLayout title="Sales" subtitle="Birds with salespeople, and what is left to sell">
      {error && <Alert tone="error">{error}</Alert>}

      <section className="card">
        <div className="card-head">
          <h2 className="card-title">{isSalesperson ? 'My allocation' : 'Allocations'}</h2>
          <div className="chips">
            {canAllocate && (
              <Button
                variant="ghost"
                onClick={() => start('allocate')}
                disabled={batches.length === 0}
              >
                Allocate birds
              </Button>
            )}
            {canSell && open.length > 0 && (
              <Button variant="ghost" onClick={() => start('sell')}>
                Record sale
              </Button>
            )}
            {canReturn && open.length > 0 && (
              <Button variant="ghost" onClick={() => start('return')}>
                Return birds
              </Button>
            )}
          </div>
        </div>
        <div className="card-body">
          {loading ? (
            <p className="muted">Loading this phone’s records…</p>
          ) : visible.length === 0 ? (
            <p className="muted">
              {isSalesperson
                ? 'No birds have been allocated to you yet. Your farm manager will hand them over here.'
                : 'No allocations yet. Give a salesperson birds from a batch so they can sell.'}
            </p>
          ) : (
            <ul className="list">
              {visible.map((allocation) => (
                <AllocationRow
                  key={allocation.id}
                  allocation={allocation}
                  batchCode={
                    batches.find((batch) => batch.id === allocation.batchId)?.code ?? 'Batch'
                  }
                  salespersonName={
                    isSalesperson
                      ? (user?.name ?? 'You')
                      : (team.find((employee) => employee.id === allocation.salespersonId)?.name ??
                        'Salesperson')
                  }
                  balance={allocationBalanceFor(allocation, sales, returns)}
                  feedKg={feedAllocatedFor(allocation.id, movements)}
                />
              ))}
            </ul>
          )}

          {visible.length > 0 && (
            <p className="muted">
              {soldTotal} bird{soldTotal === 1 ? '' : 's'} sold from these allocations. Unsold birds
              stay in the batch until they are sold or returned.
            </p>
          )}

          {teamError && canAllocate && <Alert tone="warning">{teamError}</Alert>}
          {canAllocate && salespeople.length === 0 && (
            <p className="muted">
              Add a salesperson to the team first, then their name appears here when this phone
              has signal.
            </p>
          )}
        </div>
      </section>

      {action === 'allocate' && canAllocate && (
        <AllocateForm
          batches={batches}
          salespeople={salespeople}
          stockItems={stockItems}
          canFeed={canFeed}
          busy={busy}
          onCancel={() => setAction(null)}
          onSave={(payload) => {
            const recordedAt = new Date().toISOString();
            const allocationId = crypto.randomUUID();

            const parsed = allocationInputSchema.safeParse({
              batchId: payload.batchId,
              salespersonId: payload.salespersonId,
              count: payload.count,
              note: payload.note,
              recordedAt,
            });
            if (!parsed.success) {
              return fail(parsed.error.issues[0]?.message ?? 'Check the allocation.');
            }

            const records: NewRecord[] = [
              { table: 'sales_allocations', id: allocationId, data: parsed.data },
            ];

            // Feed leaves the store with the birds. It is an ordinary issue
            // tagged with the allocation and queued in the same transaction,
            // so the phone never sends one without the other.
            if (payload.feedKg !== undefined) {
              const feed = stockMovementInputSchema.safeParse({
                stockItemId: payload.stockItemId,
                kind: 'issue',
                quantityKg: payload.feedKg,
                batchId: parsed.data.batchId,
                allocationId,
                note: payload.note,
                recordedAt,
              });
              if (!feed.success) {
                return fail(feed.error.issues[0]?.message ?? 'Check the feed.');
              }
              records.push({
                table: 'stock_movements',
                id: crypto.randomUUID(),
                data: feed.data,
              });
            }

            setBusy(true);
            void saveRecords(
              records,
              payload.feedKg !== undefined
                ? 'Birds and feed allocated'
                : 'Birds allocated',
            );
          }}
        />
      )}

      {action === 'sell' && canSell && (
        <SellForm
          allocations={open}
          batches={batches}
          busy={busy}
          onCancel={() => setAction(null)}
          onSave={(payload) => {
            const parsed = saleInputSchema.safeParse({
              ...payload,
              recordedAt: new Date().toISOString(),
            });
            if (!parsed.success) {
              return fail(parsed.error.issues[0]?.message ?? 'Check the sale.');
            }
            setBusy(true);
            void save('bird_sales', parsed.data, 'Sale recorded');
          }}
        />
      )}

      {action === 'return' && canReturn && (
        <ReturnForm
          allocations={open}
          batches={batches}
          busy={busy}
          onCancel={() => setAction(null)}
          onSave={(payload) => {
            const parsed = birdReturnInputSchema.safeParse({
              ...payload,
              recordedAt: new Date().toISOString(),
            });
            if (!parsed.success) {
              return fail(parsed.error.issues[0]?.message ?? 'Check the return.');
            }
            setBusy(true);
            void save('bird_returns', parsed.data, 'Birds returned');
          }}
        />
      )}
    </AppLayout>
  );
}

function AllocationRow({
  allocation,
  batchCode,
  salespersonName,
  balance,
  feedKg,
}: {
  allocation: SalesAllocation;
  batchCode: string;
  salespersonName: string;
  balance: ReturnType<typeof allocationBalanceFor>;
  /** Feed handed over with these birds, derived from the store. */
  feedKg: number;
}) {
  return (
    <li className="list-item">
      <div>
        <div className="list-title">
          {batchCode} · {balance.remaining} left
          {allocation.dirty && <Badge tone="amber">Not sent</Badge>}
          <Badge tone={balance.remaining > 0 ? 'green' : 'neutral'}>
            {balance.remaining > 0 ? 'Open' : 'Settled'}
          </Badge>
        </div>
        <div className="list-sub">
          {salespersonName} · {balance.allocated} allocated · {balance.sold} sold ·{' '}
          {balance.returned} returned · {formatDate(allocation.recordedAt.slice(0, 10))}
          {feedKg > 0 && ` · ${feedKg} kg feed`}
          {allocation.note && ` · ${allocation.note}`}
        </div>
      </div>
      <div className="status-value">{balance.remaining}</div>
    </li>
  );
}

function FormCard({
  title,
  note,
  children,
  onCancel,
}: {
  title: string;
  note: string;
  children: ReactNode;
  onCancel: () => void;
}) {
  return (
    <section className="card">
      <div className="card-head">
        <h2 className="card-title">{title}</h2>
        <Button variant="ghost" type="button" onClick={onCancel}>
          Cancel
        </Button>
      </div>
      <div className="card-body">
        {children}
        <p className="muted">{note}</p>
      </div>
    </section>
  );
}

function AllocateForm({
  batches,
  salespeople,
  stockItems,
  canFeed,
  busy,
  onSave,
  onCancel,
}: {
  batches: ReturnType<typeof toBatches>;
  salespeople: UserDto[];
  stockItems: ReturnType<typeof toStockItems>;
  canFeed: boolean;
  busy: boolean;
  onSave: (payload: {
    batchId: string;
    salespersonId: string;
    count: number;
    note?: string;
    stockItemId?: string;
    feedKg?: number;
  }) => void;
  onCancel: () => void;
}) {
  const [batchId, setBatchId] = useState(batches[0]?.id ?? '');
  const [salespersonId, setSalespersonId] = useState(salespeople[0]?.id ?? '');
  const [count, setCount] = useState('');
  const [stockItemId, setStockItemId] = useState('');
  const [feedKg, setFeedKg] = useState('');
  const [note, setNote] = useState('');

  const feedWeight = feedKg.trim() ? Number(feedKg) : undefined;
  const feedIncomplete = feedWeight !== undefined && !stockItemId;

  return (
    <FormCard
      title="Allocate birds"
      note="Allocating does not change the batch count. The birds stay in the flock until the salesperson records a sale. Feed you hand over leaves the store now. You can allocate while offline once this phone has seen the team list."
      onCancel={onCancel}
    >
      <form
        className="form form--inline"
        onSubmit={(event: FormEvent) => {
          event.preventDefault();
          onSave({
            batchId,
            salespersonId,
            count: Number(count),
            note: note.trim() || undefined,
            stockItemId: feedWeight !== undefined ? stockItemId : undefined,
            feedKg: feedWeight,
          });
        }}
        noValidate
      >
        <div className="field">
          <label className="field-label" htmlFor="allocation-batch">
            Batch
          </label>
          <select
            id="allocation-batch"
            className="input"
            value={batchId}
            onChange={(event) => setBatchId(event.target.value)}
          >
            {batches.map((batch) => (
              <option key={batch.id} value={batch.id}>
                {batch.code}
              </option>
            ))}
          </select>
        </div>
        <div className="field">
          <label className="field-label" htmlFor="allocation-person">
            Salesperson
          </label>
          <select
            id="allocation-person"
            className="input"
            value={salespersonId}
            onChange={(event) => setSalespersonId(event.target.value)}
          >
            {salespeople.map((person) => (
              <option key={person.id} value={person.id}>
                {person.name}
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
        {canFeed && stockItems.length > 0 && (
          <div className="field">
            <label className="field-label" htmlFor="allocation-feed">
              Feed sent (kg, optional)
            </label>
            <div className="field-row">
              <select
                id="allocation-feed"
                className="input"
                value={stockItemId}
                onChange={(event) => setStockItemId(event.target.value)}
              >
                <option value="">No feed</option>
                {stockItems.map((item) => (
                  <option key={item.id} value={item.id}>
                    {item.name}
                  </option>
                ))}
              </select>
              <input
                className="input"
                type="number"
                inputMode="decimal"
                min={0}
                step="0.01"
                placeholder="kg"
                aria-label="Feed weight in kilograms"
                value={feedKg}
                onChange={(event) => setFeedKg(event.target.value)}
              />
            </div>
          </div>
        )}
        <Field
          label="Note"
          value={note}
          onChange={(event) => setNote(event.target.value)}
        />
        <Button
          type="submit"
          loading={busy}
          disabled={!batchId || !salespersonId || salespeople.length === 0 || feedIncomplete}
        >
          Allocate
        </Button>
      </form>
      {salespeople.length === 0 && (
        <p className="muted">
          No salespeople loaded. Connect to the internet once so this phone can cache the team.
        </p>
      )}
      {canFeed && stockItems.length === 0 && (
        <p className="muted">
          No feed is on this phone yet. Receive stock first if you want to send feed with the birds.
        </p>
      )}
      {feedIncomplete && (
        <p className="muted">Choose which feed went with the birds, or clear the weight.</p>
      )}
    </FormCard>
  );
}

function SellForm({
  allocations,
  batches,
  busy,
  onSave,
  onCancel,
}: {
  allocations: SalesAllocation[];
  batches: ReturnType<typeof toBatches>;
  busy: boolean;
  onSave: (payload: {
    batchId: string;
    allocationId: string;
    count: number;
    buyer?: string;
    note?: string;
    unitPriceKes?: number;
  }) => void;
  onCancel: () => void;
}) {
  const [allocationId, setAllocationId] = useState(allocations[0]?.id ?? '');
  const [count, setCount] = useState('');
  const [price, setPrice] = useState('');
  const [buyer, setBuyer] = useState('');
  const [note, setNote] = useState('');

  const allocation = allocations.find((item) => item.id === allocationId);
  const batch = batches.find((item) => item.id === allocation?.batchId);
  const total = Number(count) * Number(price);
  const showTotal = Number.isFinite(total) && total > 0;

  return (
    <FormCard
      title="Record sale from allocation"
      note="The sale is counted against the allocation and the batch. Leave the price empty only if it is not known yet."
      onCancel={onCancel}
    >
      <form
        className="form form--inline"
        onSubmit={(event: FormEvent) => {
          event.preventDefault();
          if (!allocation) return;
          onSave({
            batchId: allocation.batchId,
            allocationId: allocation.id,
            count: Number(count),
            buyer: buyer.trim() || undefined,
            note: note.trim() || undefined,
            unitPriceKes: price.trim() ? Number(price) : undefined,
          });
        }}
        noValidate
      >
        <div className="field">
          <label className="field-label" htmlFor="sale-allocation">
            Allocation
          </label>
          <select
            id="sale-allocation"
            className="input"
            value={allocationId}
            onChange={(event) => setAllocationId(event.target.value)}
          >
            {allocations.map((item) => (
              <option key={item.id} value={item.id}>
                {batches.find((batchItem) => batchItem.id === item.batchId)?.code ?? 'Batch'} ·
                allocated {item.count}
              </option>
            ))}
          </select>
        </div>
        <Field
          label={`Birds sold${batch ? ` from ${batch.code}` : ''}`}
          type="number"
          inputMode="numeric"
          min={1}
          value={count}
          onChange={(event) => setCount(event.target.value)}
          required
        />
        <Field
          label="Price per bird (KES)"
          type="number"
          inputMode="decimal"
          min={0}
          step="0.01"
          value={price}
          onChange={(event) => setPrice(event.target.value)}
          hint={showTotal ? `Total ${formatKes(total)}` : undefined}
        />
        <Field label="Buyer" value={buyer} onChange={(event) => setBuyer(event.target.value)} />
        <Field label="Note" value={note} onChange={(event) => setNote(event.target.value)} />
        <Button type="submit" loading={busy} disabled={!allocation}>
          Save sale
        </Button>
      </form>
    </FormCard>
  );
}

function ReturnForm({
  allocations,
  batches,
  busy,
  onSave,
  onCancel,
}: {
  allocations: SalesAllocation[];
  batches: ReturnType<typeof toBatches>;
  busy: boolean;
  onSave: (payload: { allocationId: string; count: number; reason?: string }) => void;
  onCancel: () => void;
}) {
  const [allocationId, setAllocationId] = useState(allocations[0]?.id ?? '');
  const [count, setCount] = useState('');
  const [reason, setReason] = useState('');

  return (
    <FormCard
      title="Return unsold birds"
      note="A return lifts the bird back off the allocation. It does not change the batch count, because the birds never left the flock."
      onCancel={onCancel}
    >
      <form
        className="form form--inline"
        onSubmit={(event: FormEvent) => {
          event.preventDefault();
          onSave({
            allocationId,
            count: Number(count),
            reason: reason.trim() || undefined,
          });
        }}
        noValidate
      >
        <div className="field">
          <label className="field-label" htmlFor="return-allocation">
            Allocation
          </label>
          <select
            id="return-allocation"
            className="input"
            value={allocationId}
            onChange={(event) => setAllocationId(event.target.value)}
          >
            {allocations.map((item) => (
              <option key={item.id} value={item.id}>
                {batches.find((batchItem) => batchItem.id === item.batchId)?.code ?? 'Batch'} ·
                allocated {item.count} · {formatDate(item.recordedAt.slice(0, 10))}
              </option>
            ))}
          </select>
        </div>
        <Field
          label="Birds returned"
          type="number"
          inputMode="numeric"
          min={1}
          value={count}
          onChange={(event) => setCount(event.target.value)}
          required
        />
        <Field
          label="Reason"
          value={reason}
          onChange={(event) => setReason(event.target.value)}
          placeholder="e.g. market closed"
        />
        <Button type="submit" loading={busy} disabled={!allocationId}>
          Save return
        </Button>
      </form>
    </FormCard>
  );
}
