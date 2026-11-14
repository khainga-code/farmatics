import { Link } from 'react-router-dom';
import { reminderIsDue, roundKg, toDateOnly, vaccinationSchedule } from '@farmatics/shared';
import { useAuth } from '../auth.js';
import { AppLayout } from '../components/AppLayout.js';
import { ROLE_LABELS } from '../labels.js';
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
import {
  canSeeFinance as canSeeFinanceFor,
  monthMoney,
  pendingExpenseCount,
} from '../money.js';
import { formatKes } from './FinancePage.js';

export function DashboardPage() {
  const { user, permissions } = useAuth();

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
  const month = monthMoney(sales, expenses, approvals, today);
  const pendingExpenses = pendingExpenseCount(expenses, approvals);

  const canSeeFinance = canSeeFinanceFor(permissions);

  if (!user) return null;

  return (
    <AppLayout
      title={`Good to see you, ${user.name.split(' ')[0]}`}
      subtitle={`${ROLE_LABELS[user.role]} · ${user.phone}`}
    >
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
                  <div className="status-value">{formatKes(month.revenueKes)}</div>
                </div>
                <div>
                  <div className="status-label">Out on expenses</div>
                  <div className="status-value">{formatKes(month.spendKes)}</div>
                </div>
                <div>
                  <div className="status-label">Net</div>
                  <div className="status-value money--strong">{formatKes(month.netKes)}</div>
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

    </AppLayout>
  );
}
