import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { Link } from 'react-router-dom';
import {
  expenseState,
  reminderIsDue,
  roundKes,
  roundKg,
  saleRevenueKes,
  sumKes,
  toDateOnly,
  vaccinationSchedule,
  type Role,
  type UserDto,
} from '@farmatics/shared';
import { ApiError, api } from '../api.js';
import { useAuth } from '../auth.js';
import { AppLayout } from '../components/AppLayout.js';
import { Alert, Badge, Button, Field } from '../components/ui.js';
import { SyncCard } from '../components/SyncCard.js';
import {
  allocationBalanceFor,
  balanceFor,
  feedAllocatedFor,
  onHandFor,
  toAllocations,
  toBatches,
  toExpenseApprovals,
  toExpenses,
  toMortality,
  toReturns,
  toSales,
  toStockItems,
  toStockMovements,
  toTransfers,
  toVaccinations,
  useFarmData,
} from '../local.js';
import { formatKes } from './FinancePage.js';

const ROLE_LABELS: Record<Role, string> = {
  owner: 'Farm owner',
  farm_manager: 'Farm manager',
  stock_keeper: 'Stock keeper',
  salesperson: 'Salesperson',
};

const ASSIGNABLE_ROLES: Role[] = ['stock_keeper', 'salesperson', 'farm_manager'];

const permissionLabel = (permission: string) =>
  permission.replaceAll('_', ' ').replace(/^\w/, (c) => c.toUpperCase());

export function DashboardPage() {
  const { user, farm, permissions, refresh } = useAuth();
  const isManager = permissions.includes('manage_accounts');

  const { data } = useFarmData();
  const batches = toBatches(data.batches);
  const mortality = toMortality(data.mortality_events);
  const sales = toSales(data.bird_sales);
  const transfers = toTransfers(data.bird_transfers);
  const vaccinations = toVaccinations(data.vaccination_events);
  const stockItems = toStockItems(data.stock_items);
  const movements = toStockMovements(data.stock_movements);
  const returns = toReturns(data.bird_returns);

  const myAllocations = toAllocations(data.sales_allocations).filter(
    (allocation) => allocation.salespersonId === user?.id,
  );
  const allocationRemaining = myAllocations.reduce(
    (total, allocation) =>
      total + allocationBalanceFor(allocation, sales, returns).remaining,
    0,
  );
  const allocationFeedKg = myAllocations.reduce(
    (total, allocation) => total + feedAllocatedFor(allocation.id, movements),
    0,
  );

  const today = toDateOnly(new Date());
  const liveBirds = batches.reduce(
    (total, batch) => total + balanceFor(batch, mortality, sales, transfers).live,
    0,
  );
  const feedOnHand = roundKg(
    stockItems.reduce((total, item) => total + onHandFor(item.id, movements), 0),
  );
  const pendingVaccinations = batches.reduce((total, batch) => {
    const done = new Set(
      vaccinations.filter((event) => event.batchId === batch.id).map((event) => event.day),
    );
    return (
      total +
      vaccinationSchedule(batch.arrivalDate).filter(
        (dose) => !done.has(dose.day) && reminderIsDue(dose, today),
      ).length
    );
  }, 0);

  // Money is derived the same way as bird counts: priced sales in, approved
  // expenses out. Nothing reads a stored balance.
  const expenses = toExpenses(data.expenses);
  const approvals = toExpenseApprovals(data.expense_approvals);
  const month = today.slice(0, 7);
  const monthRevenue = sumKes(
    sales
      .filter((sale) => sale.recordedAt.slice(0, 7) === month)
      .map((sale) => saleRevenueKes(sale))
      .filter((value): value is number => value !== null),
  );
  const monthSpend = sumKes(
    expenses
      .filter(
        (expense) =>
          expense.recordedAt.slice(0, 7) === month &&
          expenseState(expense.id, approvals) === 'approved',
      )
      .map((expense) => expense.amountKes),
  );
  const monthNet = roundKes(monthRevenue - monthSpend);
  const pendingExpenses = expenses.filter(
    (expense) => expenseState(expense.id, approvals) === 'pending',
  ).length;

  const canSeeFinance =
    permissions.includes('view_finance') || permissions.includes('record_expense');

  const [employees, setEmployees] = useState<UserDto[]>([]);
  const [listError, setListError] = useState<string | null>(null);
  const [loadingList, setLoadingList] = useState(false);
  const [showForm, setShowForm] = useState(false);

  const [form, setForm] = useState({
    name: '',
    phone: '',
    username: '',
    role: 'stock_keeper' as Role,
  });
  const [formError, setFormError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [tempPin, setTempPin] = useState<{ username: string; pin: string } | null>(null);

  const loadEmployees = useCallback(async () => {
    setLoadingList(true);
    setListError(null);
    try {
      setEmployees(await api.listEmployees());
    } catch (caught) {
      setListError(caught instanceof ApiError ? caught.message : 'Could not load the team.');
    } finally {
      setLoadingList(false);
    }
  }, []);

  useEffect(() => {
    if (isManager) void loadEmployees();
  }, [isManager, loadEmployees]);

  if (!user) return null;

  async function createEmployee(event: FormEvent) {
    event.preventDefault();
    setCreating(true);
    setFormError(null);

    try {
      const created = await api.createEmployee(form);
      setTempPin({ username: form.username, pin: created.tempPin });
      setForm({ name: '', phone: '', username: '', role: 'stock_keeper' });
      setShowForm(false);
      await loadEmployees();
    } catch (caught) {
      setFormError(caught instanceof ApiError ? caught.message : 'Could not create the account.');
    } finally {
      setCreating(false);
    }
  }

  async function toggleStatus(employee: UserDto) {
    const next = employee.status === 'active' ? 'suspended' : 'active';
    try {
      const updated = await api.setEmployeeStatus(employee.id, next);
      setEmployees((current) =>
        current.map((item) => (item.id === updated.id ? updated : item)),
      );
    } catch (caught) {
      setListError(caught instanceof ApiError ? caught.message : 'Could not change the account.');
    }
  }

  async function unlock(employee: UserDto) {
    try {
      await api.unlockEmployee(employee.id);
      setListError(null);
    } catch (caught) {
      setListError(caught instanceof ApiError ? caught.message : 'Could not unlock the account.');
    }
  }

  return (
    <AppLayout
      title={`Good to see you, ${user.name.split(' ')[0]}`}
      subtitle={`${ROLE_LABELS[user.role]} · ${user.phone}`}
    >
        {user.mustChangePin && (
          <ChangePinCard mustProvideCurrent onChanged={() => void refresh()} />
        )}

        <section className="card">
          <div className="card-head">
            <h2 className="card-title">Today on the farm</h2>
            <Link to="/poultry">Open poultry</Link>
          </div>
          <div className="card-body">
            <div className="status-grid">
              <div>
                <div className="status-label">Batches</div>
                <div className="status-value">{batches.length}</div>
              </div>
              <div>
                <div className="status-label">Birds alive</div>
                <div className="status-value">{liveBirds}</div>
              </div>
              <div>
                <div className="status-label">Feed on hand</div>
                <div className="status-value">{feedOnHand} kg</div>
              </div>
              <div>
                <div className="status-label">Vaccinations to do</div>
                <div className="status-value">{pendingVaccinations}</div>
              </div>
            </div>
            <div className="sync-actions">
              <Link className="btn btn--ghost" to="/poultry">
                Batches and reminders
              </Link>
              {permissions.some((permission) =>
                ['manage_setup', 'receive_stock', 'reserve_feed', 'record_feeding'].includes(
                  permission,
                ),
              ) && (
                <Link className="btn btn--ghost" to="/store">
                  Feed store
                </Link>
              )}
            </div>
          </div>
        </section>

        {user.role === 'salesperson' && myAllocations.length > 0 && (
          <section className="card">
            <div className="card-head">
              <h2 className="card-title">Your allocation</h2>
              <Link to="/sales">Open sales</Link>
            </div>
            <div className="card-body">
              <div className="status-grid">
                <div>
                  <div className="status-label">Birds left to sell</div>
                  <div className="status-value">{allocationRemaining}</div>
                </div>
                <div>
                  <div className="status-label">Allocations</div>
                  <div className="status-value">{myAllocations.length}</div>
                </div>
                {allocationFeedKg > 0 && (
                  <div>
                    <div className="status-label">Feed with you</div>
                    <div className="status-value">{allocationFeedKg} kg</div>
                  </div>
                )}
              </div>
              <p className="muted">
                Sales are recorded against these birds. Unsold birds can be returned to the farm.
              </p>
            </div>
          </section>
        )}

        {canSeeFinance && (
          <section className="card">
            <div className="card-head">
              <h2 className="card-title">Money this month</h2>
              <Link to="/finance">Open finance</Link>
            </div>
            <div className="card-body">
              <div className="status-grid">
                <div>
                  <div className="status-label">In from sales</div>
                  <div className="status-value">{formatKes(monthRevenue)}</div>
                </div>
                <div>
                  <div className="status-label">Out on expenses</div>
                  <div className="status-value">{formatKes(monthSpend)}</div>
                </div>
                <div>
                  <div className="status-label">Net</div>
                  <div className="status-value money--strong">{formatKes(monthNet)}</div>
                </div>
              </div>
              <p className="muted">
                Only approved expenses are counted, and sales without a price are left out.
                {pendingExpenses > 0 &&
                  ` ${pendingExpenses} expense${pendingExpenses === 1 ? ' is' : 's are'} still waiting for a decision.`}
              </p>
            </div>
          </section>
        )}

        <section className="card">
          <div className="card-head">
            <h2 className="card-title">Your access</h2>
            <Badge tone="green">{ROLE_LABELS[user.role]}</Badge>
          </div>
          <div className="card-body">
            <div className="chips">
              {permissions.map((permission) => (
                <span className="chip" key={permission}>
                  {permissionLabel(permission)}
                </span>
              ))}
            </div>
            <p className="muted">
              With a PIN set, this phone keeps working for {farm?.offlineDaysAllowed ?? 14} days
              without internet. Currency: {farm?.currency ?? 'KES'}.
            </p>
          </div>
        </section>

        <SyncCard />

        {isManager && (
          <section className="card">
            <div className="card-head">
              <h2 className="card-title">Team</h2>
              <Button variant="ghost" onClick={() => setShowForm((open) => !open)}>
                {showForm ? 'Cancel' : 'Add employee'}
              </Button>
            </div>

            <div className="card-body">
              {tempPin && (
                <Alert tone="success">
                  <strong>Temporary PIN for {tempPin.username}:</strong>{' '}
                  <span className="mono pin">{tempPin.pin}</span>
                  <br />
                  Write it down now. It is shown once and must be changed at first sign-in.
                  <div className="pin-actions">
                    <Button
                      variant="ghost"
                      onClick={() => void navigator.clipboard?.writeText(tempPin.pin)}
                    >
                      Copy PIN
                    </Button>
                    <Button variant="ghost" onClick={() => setTempPin(null)}>
                      Dismiss
                    </Button>
                  </div>
                </Alert>
              )}

              {formError && <Alert tone="error">{formError}</Alert>}

              {showForm && (
                <form className="form form--inline" onSubmit={createEmployee} noValidate>
                  <Field
                    label="Full name"
                    value={form.name}
                    onChange={(event) =>
                      setForm((current) => ({ ...current, name: event.target.value }))
                    }
                    placeholder="e.g. Joseph Mwangi"
                    required
                  />
                  <Field
                    label="Phone number"
                    type="tel"
                    inputMode="tel"
                    value={form.phone}
                    onChange={(event) =>
                      setForm((current) => ({ ...current, phone: event.target.value }))
                    }
                    placeholder="0712 345 678"
                    required
                  />
                  <Field
                    label="Username"
                    value={form.username}
                    onChange={(event) =>
                      setForm((current) => ({
                        ...current,
                        username: event.target.value.toLowerCase(),
                      }))
                    }
                    placeholder="e.g. joseph"
                    hint="Used with a PIN to sign in."
                    required
                  />
                  <div className="field">
                    <label className="field-label" htmlFor="employee-role">
                      Role
                    </label>
                    <select
                      id="employee-role"
                      className="input"
                      value={form.role}
                      onChange={(event) =>
                        setForm((current) => ({
                          ...current,
                          role: event.target.value as Role,
                        }))
                      }
                    >
                      {ASSIGNABLE_ROLES.map((role) => (
                        <option key={role} value={role}>
                          {ROLE_LABELS[role]}
                        </option>
                      ))}
                    </select>
                  </div>
                  <Button type="submit" loading={creating}>
                    Create account
                  </Button>
                </form>
              )}

              {listError && <Alert tone="error">{listError}</Alert>}
              {loadingList && employees.length === 0 && <p className="muted">Loading team…</p>}

              {employees.length === 0 && !loadingList ? (
                <p className="muted">
                  No employees yet. Add your stock keeper and salespeople so they can sign in on
                  their phones.
                </p>
              ) : (
                <ul className="list">
                  {employees.map((employee) => (
                    <li className="list-item" key={employee.id}>
                      <div>
                        <div className="list-title">
                          {employee.name}{' '}
                          {employee.status === 'suspended' && <Badge tone="red">Suspended</Badge>}
                          {employee.mustChangePin && <Badge tone="amber">PIN not set</Badge>}
                        </div>
                        <div className="list-sub">
                          {ROLE_LABELS[employee.role]} · @{employee.username} · {employee.phone}
                        </div>
                      </div>
                      <div className="list-actions">
                        <Button variant="ghost" onClick={() => void unlock(employee)}>
                          Unlock
                        </Button>
                        <Button variant="ghost" onClick={() => void toggleStatus(employee)}>
                          {employee.status === 'active' ? 'Suspend' : 'Reactivate'}
                        </Button>
                      </div>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </section>
        )}

        {!user.mustChangePin && (
          <ChangePinCard mustProvideCurrent={false} onChanged={() => void refresh()} />
        )}
    </AppLayout>
  );
}

function ChangePinCard({
  mustProvideCurrent,
  onChanged,
}: {
  mustProvideCurrent: boolean;
  onChanged: () => void;
}) {
  const [currentPin, setCurrentPin] = useState('');
  const [newPin, setNewPin] = useState('');
  const [confirmPin, setConfirmPin] = useState('');
  const [message, setMessage] = useState<{ tone: 'success' | 'error'; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const { rememberPin } = useAuth();

  async function onSubmit(event: FormEvent) {
    event.preventDefault();
    setMessage(null);

    if (newPin !== confirmPin) {
      setMessage({ tone: 'error', text: 'The two new PINs do not match.' });
      return;
    }

    setBusy(true);
    try {
      await api.changePin(mustProvideCurrent ? currentPin : undefined, newPin);
      // Keep a local verifier so this PIN also unlocks the app with no signal.
      await rememberPin(newPin).catch(() => {});
      setCurrentPin('');
      setNewPin('');
      setConfirmPin('');
      setMessage({ tone: 'success', text: 'PIN updated.' });
      onChanged();
    } catch (caught) {
      setMessage({
        tone: 'error',
        text: caught instanceof ApiError ? caught.message : 'Could not change the PIN.',
      });
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="card">
      <div className="card-head">
        <h2 className="card-title">{mustProvideCurrent ? 'Set your PIN' : 'Change your PIN'}</h2>
        {mustProvideCurrent && <Badge tone="amber">Required</Badge>}
      </div>
      <div className="card-body">
        <p className="muted">
          {mustProvideCurrent
            ? 'You signed in with a temporary PIN. Choose your own before you start work.'
            : 'Use a PIN you can remember. It unlocks the app on this phone without internet.'}
        </p>
        <form className="form form--inline" onSubmit={onSubmit} noValidate>
          {message && <Alert tone={message.tone}>{message.text}</Alert>}
          {mustProvideCurrent && (
            <Field
              label="Temporary PIN"
              type="password"
              inputMode="numeric"
              maxLength={6}
              value={currentPin}
              onChange={(event) => setCurrentPin(event.target.value.replace(/\D/g, ''))}
              required
            />
          )}
          <Field
            label="New PIN"
            type="password"
            inputMode="numeric"
            maxLength={6}
            hint="4 to 6 digits."
            value={newPin}
            onChange={(event) => setNewPin(event.target.value.replace(/\D/g, ''))}
            required
          />
          <Field
            label="Confirm new PIN"
            type="password"
            inputMode="numeric"
            maxLength={6}
            value={confirmPin}
            onChange={(event) => setConfirmPin(event.target.value.replace(/\D/g, ''))}
            required
          />
          <Button type="submit" loading={busy}>
            Save PIN
          </Button>
        </form>
      </div>
    </section>
  );
}
