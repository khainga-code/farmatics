import { useState, type FormEvent, type ReactNode } from 'react';
import {
  stockItemInputSchema,
  stockMovementInputSchema,
} from '@farmatics/shared';
import { useAuth } from '../auth.js';
import { AppLayout } from '../components/AppLayout.js';
import { Alert, Badge, Button, Field } from '../components/ui.js';
import {
  onHandFor,
  toBatches,
  toStockItems,
  toStockMovements,
  useFarmData,
  type StockItem,
} from '../local.js';
import { saveAndConfirm } from '../save.js';
import { notify } from '../toast.js';

type Action = 'receive' | 'issue' | 'adjust' | 'new-item' | null;

export function StorePage() {
  const { can, online } = useAuth();
  const { data, loading } = useFarmData();

  const [action, setAction] = useState<Action>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const items = toStockItems(data.stock_items).filter((item) => item.active);
  const movements = toStockMovements(data.stock_movements);
  const batches = toBatches(data.batches).filter((batch) => batch.status === 'active');

  const canReceive = can('receive_stock');
  const canIssue = can('reserve_feed') || can('record_feeding');
  const canAdjust = can('manage_setup');
  const canAddItem = can('manage_setup') || canReceive;

  function start(next: Exclude<Action, null>) {
    setError(null);
    setAction(next);
  }

  async function save(table: string, payload: Record<string, unknown>, message: string) {
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

  function fail(message: string) {
    setError(message);
    notify(message, 'error');
    setBusy(false);
  }

  return (
    <AppLayout title="Feed store" subtitle="Feed is counted in kilograms">
      {error && <Alert tone="error">{error}</Alert>}

      <section className="card">
        <div className="card-head">
          <h2 className="card-title">On hand</h2>
          <div className="chips">
            {canAddItem && (
              <Button variant="ghost" onClick={() => start('new-item')}>
                New feed
              </Button>
            )}
            {canReceive && (
              <Button variant="ghost" onClick={() => start('receive')}>
                Receive
              </Button>
            )}
            {canIssue && (
              <Button variant="ghost" onClick={() => start('issue')}>
                Issue
              </Button>
            )}
            {canAdjust && (
              <Button variant="ghost" onClick={() => start('adjust')}>
                Adjust
              </Button>
            )}
          </div>
        </div>
        <div className="card-body">
          {loading ? (
            <p className="muted">Loading this phone’s records…</p>
          ) : items.length === 0 ? (
            <p className="muted">
              No feed recorded yet. Add the feed you buy, then receive the first delivery.
            </p>
          ) : (
            <ul className="list">
              {items.map((item) => {
                const onHand = onHandFor(item.id, movements);
                const low = item.reorderLevelKg !== null && onHand <= item.reorderLevelKg;
                return (
                  <li className="list-item" key={item.id}>
                    <div>
                      <div className="list-title">
                        {item.name}
                        {item.dirty && <Badge tone="amber">Not sent</Badge>}
                        {onHand < 0 && <Badge tone="red">Below zero</Badge>}
                        {low && onHand >= 0 && <Badge tone="amber">Reorder</Badge>}
                      </div>
                      <div className="list-sub">
                        {item.reorderLevelKg !== null
                          ? `Reorder at ${item.reorderLevelKg} kg`
                          : 'No reorder level set'}
                      </div>
                    </div>
                    <div className="status-value">{onHand} kg</div>
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      </section>

      {action === 'new-item' && (
        <NewItemForm
          busy={busy}
          onCancel={() => setAction(null)}
          onSave={async (payload) => {
            const parsed = stockItemInputSchema.safeParse(payload);
            if (!parsed.success) return fail(parsed.error.issues[0]?.message ?? 'Check the details.');
            setBusy(true);
            try {
              await save('stock_items', parsed.data, 'Feed added');
            } catch {
              fail('Could not save on this phone. Try again.');
            }
          }}
        />
      )}

      {action === 'receive' && (
        <MovementForm
          title="Receive feed"
          items={items}
          busy={busy}
          onCancel={() => setAction(null)}
          onSave={async (stockItemId, quantityKg, note) => {
            const parsed = stockMovementInputSchema.safeParse({
              stockItemId,
              kind: 'receipt',
              quantityKg,
              note: note || undefined,
              recordedAt: new Date().toISOString(),
            });
            if (!parsed.success) return fail(parsed.error.issues[0]?.message ?? 'Check the weight.');
            setBusy(true);
            try {
              await save('stock_movements', parsed.data, 'Delivery received');
            } catch {
              fail('Could not save on this phone. Try again.');
            }
          }}
        />
      )}

      {action === 'issue' && (
        <MovementForm
          title="Issue feed to a batch"
          items={items}
          busy={busy}
          onCancel={() => setAction(null)}
          onSave={async (stockItemId, quantityKg, note, batchId) => {
            const parsed = stockMovementInputSchema.safeParse({
              stockItemId,
              kind: 'issue',
              quantityKg,
              batchId,
              note: note || undefined,
              recordedAt: new Date().toISOString(),
            });
            if (!parsed.success) return fail(parsed.error.issues[0]?.message ?? 'Check the weight.');
            setBusy(true);
            try {
              await save('stock_movements', parsed.data, 'Feed issued');
            } catch {
              fail('Could not save on this phone. Try again.');
            }
          }}
          batches={batches}
        />
      )}

      {action === 'adjust' && (
        <MovementForm
          title="Adjust stock"
          items={items}
          busy={busy}
          onCancel={() => setAction(null)}
          allowNegative
          onSave={async (stockItemId, quantityKg, note) => {
            const parsed = stockMovementInputSchema.safeParse({
              stockItemId,
              kind: 'adjustment',
              quantityKg,
              note: note || undefined,
              recordedAt: new Date().toISOString(),
            });
            if (!parsed.success) return fail(parsed.error.issues[0]?.message ?? 'Check the weight.');
            setBusy(true);
            try {
              await save('stock_movements', parsed.data, 'Stock adjusted');
            } catch {
              fail('Could not save on this phone. Try again.');
            }
          }}
        />
      )}
    </AppLayout>
  );
}

function FormCard({
  title,
  children,
  onCancel,
}: {
  title: string;
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
      <div className="card-body">{children}</div>
    </section>
  );
}

function NewItemForm({
  onSave,
  onCancel,
  busy,
}: {
  onSave: (payload: { name: string; category: 'feed'; reorderLevelKg?: number }) => void;
  onCancel: () => void;
  busy: boolean;
}) {
  const [name, setName] = useState('');
  const [reorder, setReorder] = useState('');

  return (
    <FormCard title="New feed" onCancel={onCancel}>
      <form
        className="form form--inline"
        onSubmit={(event: FormEvent) => {
          event.preventDefault();
          onSave({
            name: name.trim(),
            category: 'feed',
            reorderLevelKg: reorder.trim() ? Number(reorder) : undefined,
          });
        }}
        noValidate
      >
        <Field
          label="Feed name"
          value={name}
          onChange={(event) => setName(event.target.value)}
          placeholder="e.g. Growers mash"
          required
        />
        <Field
          label="Reorder level (kg)"
          type="number"
          inputMode="decimal"
          min={0}
          step="0.01"
          value={reorder}
          onChange={(event) => setReorder(event.target.value)}
          hint="Warn when stock falls to this weight."
        />
        <Button type="submit" loading={busy}>
          Save
        </Button>
      </form>
    </FormCard>
  );
}

function MovementForm({
  title,
  items,
  batches = [],
  allowNegative = false,
  onSave,
  onCancel,
  busy,
}: {
  title: string;
  items: StockItem[];
  batches?: ReturnType<typeof toBatches>;
  allowNegative?: boolean;
  onSave: (
    stockItemId: string,
    quantityKg: number,
    note: string,
    batchId?: string,
  ) => void;
  onCancel: () => void;
  busy: boolean;
}) {
  const [stockItemId, setStockItemId] = useState(items[0]?.id ?? '');
  const [quantity, setQuantity] = useState('');
  const [note, setNote] = useState('');
  const [batchId, setBatchId] = useState(batches[0]?.id ?? '');

  return (
    <FormCard title={title} onCancel={onCancel}>
      <form
        className="form form--inline"
        onSubmit={(event: FormEvent) => {
          event.preventDefault();
          onSave(stockItemId, Number(quantity), note.trim(), batchId || undefined);
        }}
        noValidate
      >
        <div className="field">
          <label className="field-label" htmlFor="movement-item">
            Feed
          </label>
          <select
            id="movement-item"
            className="input"
            value={stockItemId}
            onChange={(event) => setStockItemId(event.target.value)}
          >
            {items.map((item) => (
              <option key={item.id} value={item.id}>
                {item.name}
              </option>
            ))}
          </select>
        </div>
        {batches.length > 0 && (
          <div className="field">
            <label className="field-label" htmlFor="movement-batch">
              Batch
            </label>
            <select
              id="movement-batch"
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
        )}
        <Field
          label="Weight (kg)"
          type="number"
          inputMode="decimal"
          step="0.01"
          min={allowNegative ? undefined : 0.01}
          value={quantity}
          onChange={(event) => setQuantity(event.target.value)}
          hint={allowNegative ? 'Use a negative number to write stock off.' : undefined}
          required
        />
        <Field label="Note" value={note} onChange={(event) => setNote(event.target.value)} />
        <Button type="submit" loading={busy} disabled={!stockItemId}>
          Save
        </Button>
      </form>
      {items.length === 0 && (
        <p className="muted">Add a feed first, then you can record deliveries and issues.</p>
      )}
    </FormCard>
  );
}
