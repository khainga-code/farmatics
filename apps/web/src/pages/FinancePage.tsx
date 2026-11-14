import { useState, type FormEvent } from 'react';
import {
  EXPENSE_CATEGORIES,
  EXPENSE_CATEGORY_LABELS,
  EXPENSE_METHODS,
  EXPENSE_METHOD_LABELS,
  expenseInputSchema,
  expenseState,
  toDateOnly,
  type ExpenseCategory,
  type ExpenseMethod,
} from '@farmatics/shared';
import { useAuth } from '../auth.js';
import { AppLayout } from '../components/AppLayout.js';
import { Alert, Badge, Button, Field } from '../components/ui.js';
import {
  toBatches,
  toExpenseApprovals,
  toExpenses,
  toSales,
  useFarmData,
  type Expense,
} from '../local.js';
import { dayMoney, monthMoney } from '../money.js';
import { syncClient } from '../offline.js';

/**
 * The cash book.
 *
 * Cash only, so there are no invoices to chase: revenue is priced sales and
 * spend is approved expenses. Both sides are derived from events, and an
 * unpriced sale is reported instead of silently counting as zero.
 */
export function FinancePage() {
  const { can, online } = useAuth();
  const { data, loading } = useFarmData();

  const [showForm, setShowForm] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);

  const expenses = toExpenses(data.expenses).sort((left, right) =>
    right.recordedAt.localeCompare(left.recordedAt),
  );
  const approvals = toExpenseApprovals(data.expense_approvals);
  const sales = toSales(data.bird_sales);
  const batches = toBatches(data.batches);

  const canRecord = can('record_expense');
  const canApprove = can('approve_expense');

  const today = toDateOnly(new Date());
  const month = monthMoney(sales, expenses, approvals, today);
  const day = dayMoney(sales, expenses, approvals, today);
  const monthRevenue = month.revenueKes;
  const monthSpend = month.spendKes;
  const monthNet = month.netKes;
  const todayRevenue = day.revenueKes;
  const todaySpend = day.spendKes;

  const pending = expenses.filter(
    (expense) => expenseState(expense.id, approvals) === 'pending',
  );
  const unpriced = month.unpricedSales;

  async function decide(expense: Expense, decision: 'approved' | 'rejected') {
    setError(null);
    setBusyId(expense.id);
    try {
      await syncClient.saveRecord('expense_approvals', crypto.randomUUID(), {
        expenseId: expense.id,
        decision,
        recordedAt: new Date().toISOString(),
      });
      if (online) await syncClient.sync();
    } catch {
      setError('Could not save the decision on this phone. Try again.');
    } finally {
      setBusyId(null);
    }
  }

  return (
    <AppLayout
      title="Finance"
      subtitle="Cash in, cash out and what each batch earned"
      actions={
        canRecord && (
          <Button variant="ghost" onClick={() => setShowForm((open) => !open)}>
            {showForm ? 'Cancel' : 'Record expense'}
          </Button>
        )
      }
    >
      {error && <Alert tone="error">{error}</Alert>}

      {showForm && canRecord && (
        <ExpenseForm
          batches={batches}
          online={online}
          onDone={() => setShowForm(false)}
        />
      )}

      <section className="card">
        <div className="card-head">
          <h2 className="card-title">Cash book</h2>
          <Badge>KES</Badge>
        </div>
        <div className="card-body">
          <div className="status-grid">
            <Money label="Today in" value={todayRevenue} />
            <Money label="Today out" value={todaySpend} />
            <Money label="Today net" value={day.netKes} strong />
            <Money label="This month in" value={monthRevenue} />
            <Money label="This month out" value={monthSpend} />
            <Money label="This month net" value={month.netKes} strong />
          </div>
          {loading && <p className="muted">Loading this phone’s records…</p>}
          {unpriced > 0 && (
            <Alert tone="warning">
              {unpriced} sale{unpriced === 1 ? '' : 's'} this month {unpriced === 1 ? 'has' : 'have'}{' '}
              no price and {unpriced === 1 ? 'is' : 'are'} not counted in revenue.
            </Alert>
          )}
          {pending.length > 0 && (
            <p className="muted">
              {pending.length} expense{pending.length === 1 ? '' : 's'} waiting for a decision.
            </p>
          )}
        </div>
      </section>

      {canApprove && pending.length > 0 && (
        <section className="card">
          <div className="card-head">
            <h2 className="card-title">Awaiting approval</h2>
            <Badge tone="amber">{pending.length}</Badge>
          </div>
          <div className="card-body">
            <ul className="list">
              {pending.map((expense) => (
                <li className="list-item" key={expense.id}>
                  <div>
                    <div className="list-title">
                      {EXPENSE_CATEGORY_LABELS[expense.category]} ·{' '}
                      {formatKes(expense.amountKes)}
                      {expense.dirty && <Badge tone="amber">Not sent</Badge>}
                    </div>
                    <div className="list-sub">
                      {expense.paidTo ?? 'No payee'} · {formatWhen(expense.recordedAt)}
                      {expense.batchId &&
                        ` · ${batches.find((batch) => batch.id === expense.batchId)?.code ?? 'batch'}`}
                    </div>
                  </div>
                  <div className="list-actions">
                    <Button
                      variant="ghost"
                      loading={busyId === expense.id}
                      onClick={() => void decide(expense, 'approved')}
                    >
                      Approve
                    </Button>
                    <Button
                      variant="ghost"
                      loading={busyId === expense.id}
                      onClick={() => void decide(expense, 'rejected')}
                    >
                      Reject
                    </Button>
                  </div>
                </li>
              ))}
            </ul>
          </div>
        </section>
      )}

      <section className="card">
        <div className="card-head">
          <h2 className="card-title">Expenses</h2>
          <Badge>{expenses.length}</Badge>
        </div>
        <div className="card-body">
          {expenses.length === 0 ? (
            <p className="muted">No expenses recorded yet.</p>
          ) : (
            <ul className="list">
              {expenses.slice(0, 60).map((expense) => {
                const state = expenseState(expense.id, approvals);
                const batch = batches.find((item) => item.id === expense.batchId);
                return (
                  <li className="list-item" key={expense.id}>
                    <div>
                      <div className="list-title">
                        {EXPENSE_CATEGORY_LABELS[expense.category]} ·{' '}
                        {formatKes(expense.amountKes)}
                        {expense.dirty && <Badge tone="amber">Not sent</Badge>}
                        <Badge
                          tone={
                            state === 'approved' ? 'green' : state === 'rejected' ? 'red' : 'amber'
                          }
                        >
                          {state}
                        </Badge>
                      </div>
                      <div className="list-sub">
                        {expense.paidTo ?? 'No payee'} · {EXPENSE_METHOD_LABELS[expense.method]} ·{' '}
                        {formatWhen(expense.recordedAt)}
                        {batch && ` · ${batch.code}`}
                      </div>
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

function Money({ label, value, strong = false }: { label: string; value: number; strong?: boolean }) {
  return (
    <div>
      <div className="status-label">{label}</div>
      <div className={strong ? 'status-value money--strong' : 'status-value'}>
        {formatKes(value)}
      </div>
    </div>
  );
}

export function formatKes(value: number): string {
  return `KES ${value.toLocaleString(undefined, {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;
}

function formatWhen(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? value
    : date.toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' });
}

function ExpenseForm({
  batches,
  online,
  onDone,
}: {
  batches: ReturnType<typeof toBatches>;
  online: boolean;
  onDone: () => void;
}) {
  const [form, setForm] = useState({
    category: 'feed' as ExpenseCategory,
    amount: '',
    paidTo: '',
    method: 'cash' as ExpenseMethod,
    batchId: '',
    date: toDateOnly(new Date()),
    note: '',
  });
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function onSubmit(event: FormEvent) {
    event.preventDefault();
    setError(null);

    const parsed = expenseInputSchema.safeParse({
      category: form.category,
      amountKes: Number(form.amount),
      paidTo: form.paidTo.trim() || undefined,
      method: form.method,
      batchId: form.batchId || undefined,
      note: form.note.trim() || undefined,
      recordedAt: new Date(`${form.date}T12:00:00`).toISOString(),
    });
    if (!parsed.success) {
      setError(parsed.error.issues[0]?.message ?? 'Check the expense.');
      return;
    }

    setBusy(true);
    try {
      await syncClient.saveRecord('expenses', crypto.randomUUID(), parsed.data);
      if (online) await syncClient.sync();
      onDone();
    } catch {
      setError('Could not save the expense on this phone. Try again.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="card">
      <div className="card-head">
        <h2 className="card-title">Record expense</h2>
        <Badge>Cash only</Badge>
      </div>
      <div className="card-body">
        {error && <Alert tone="error">{error}</Alert>}
        <form className="form form--inline" onSubmit={onSubmit} noValidate>
          <div className="field">
            <label className="field-label" htmlFor="expense-category">
              Category
            </label>
            <select
              id="expense-category"
              className="input"
              value={form.category}
              onChange={(event) =>
                setForm((current) => ({
                  ...current,
                  category: event.target.value as ExpenseCategory,
                }))
              }
            >
              {EXPENSE_CATEGORIES.map((category) => (
                <option key={category} value={category}>
                  {EXPENSE_CATEGORY_LABELS[category]}
                </option>
              ))}
            </select>
          </div>
          <Field
            label="Amount (KES)"
            type="number"
            inputMode="decimal"
            min={0.01}
            step="0.01"
            value={form.amount}
            onChange={(event) =>
              setForm((current) => ({ ...current, amount: event.target.value }))
            }
            required
          />
          <Field
            label="Paid to"
            value={form.paidTo}
            onChange={(event) =>
              setForm((current) => ({ ...current, paidTo: event.target.value }))
            }
            placeholder="e.g. Kenya Feeds"
          />
          <div className="field">
            <label className="field-label" htmlFor="expense-method">
              Method
            </label>
            <select
              id="expense-method"
              className="input"
              value={form.method}
              onChange={(event) =>
                setForm((current) => ({
                  ...current,
                  method: event.target.value as ExpenseMethod,
                }))
              }
            >
              {EXPENSE_METHODS.map((method) => (
                <option key={method} value={method}>
                  {EXPENSE_METHOD_LABELS[method]}
                </option>
              ))}
            </select>
          </div>
          <div className="field">
            <label className="field-label" htmlFor="expense-batch">
              Batch (optional)
            </label>
            <select
              id="expense-batch"
              className="input"
              value={form.batchId}
              onChange={(event) =>
                setForm((current) => ({ ...current, batchId: event.target.value }))
              }
            >
              <option value="">Farm overhead</option>
              {batches.map((batch) => (
                <option key={batch.id} value={batch.id}>
                  {batch.code}
                </option>
              ))}
            </select>
          </div>
          <Field
            label="Date"
            type="date"
            value={form.date}
            onChange={(event) => setForm((current) => ({ ...current, date: event.target.value }))}
            required
          />
          <Field
            label="Note"
            value={form.note}
            onChange={(event) => setForm((current) => ({ ...current, note: event.target.value }))}
          />
          <Button type="submit" loading={busy}>
            Save expense
          </Button>
        </form>
        <p className="muted">
          Tag an expense to a batch to include it in that batch’s margin. Untagged spending is farm
          overhead.
        </p>
      </div>
    </section>
  );
}
