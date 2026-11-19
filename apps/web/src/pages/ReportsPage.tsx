import { useEffect, useMemo, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { SPECIES_LABELS } from '@farmatics/shared';
import { api } from '../api.js';
import { useAuth } from '../auth.js';
import { AppLayout } from '../components/AppLayout.js';
import { TrendBars } from '../components/TrendBars.js';
import { Alert, Badge, Button } from '../components/ui.js';
import { reportFilename, toCsv, type CsvColumn } from '../csv.js';
import { downloadCsv } from '../download.js';
import {
  toAllocations,
  toBatches,
  toExpenseApprovals,
  toExpenses,
  toHouses,
  toMortality,
  toReturns,
  toSales,
  toStockMovements,
  toTransfers,
  toWeights,
  useFarmData,
} from '../local.js';
import { canSeeFinance } from '../money.js';
import {
  buildFarmReport,
  PERIOD_KEYS,
  PERIOD_LABELS,
  periodFor,
  type BatchReportRow,
  type PeriodKey,
  type SalespersonReportRow,
} from '../reports.js';
import { cachedTeam, cacheTeam } from '../team.js';
import { formatKes } from './FinancePage.js';
import { formatDate } from './PoultryPage.js';

/**
 * Reports for the chosen period, built from the records already on this phone.
 * Nothing here asks the network for a figure, so the screen is as useful in a
 * shed as it is in the office. Money sections follow the same permission as the
 * cash book; the calculation is skipped entirely when it is hidden.
 */

function isPeriodKey(value: string | null): value is PeriodKey {
  return value !== null && (PERIOD_KEYS as readonly string[]).includes(value);
}

function formatCount(value: number): string {
  return value.toLocaleString();
}

function formatPercent(value: number | null): string {
  return value === null ? '—' : `${value}%`;
}

function Stat({
  label,
  value,
  sub,
  strong = false,
}: {
  label: string;
  value: string;
  sub?: string;
  strong?: boolean;
}) {
  return (
    <div>
      <div className="status-label">{label}</div>
      <div className={strong ? 'status-value money--strong' : 'status-value'}>{value}</div>
      {sub && <div className="status-label">{sub}</div>}
    </div>
  );
}

export function ReportsPage() {
  const { permissions, online, farm } = useAuth();
  const { data, loading } = useFarmData();
  const [params, setParams] = useSearchParams();
  const [team, setTeam] = useState(cachedTeam);

  const rawPeriod = params.get('period');
  const periodKey: PeriodKey = isPeriodKey(rawPeriod) ? rawPeriod : 'thisMonth';
  const period = useMemo(() => periodFor(periodKey), [periodKey]);
  const includeFinance = canSeeFinance(permissions);

  useEffect(() => {
    if (!online) return;
    let cancelled = false;

    void api
      .listEmployees()
      .then((employees) => {
        if (cancelled) return;
        setTeam(employees);
        cacheTeam(employees);
      })
      .catch(() => {
        // Names fall back to "Salesperson"; the report itself is local.
      });

    return () => {
      cancelled = true;
    };
  }, [online]);

  const report = useMemo(
    () =>
      buildFarmReport(
        {
          batches: toBatches(data.batches),
          houses: toHouses(data.houses),
          mortality: toMortality(data.mortality_events),
          transfers: toTransfers(data.bird_transfers),
          sales: toSales(data.bird_sales),
          allocations: toAllocations(data.sales_allocations),
          returns: toReturns(data.bird_returns),
          movements: toStockMovements(data.stock_movements),
          weights: toWeights(data.batch_weights),
          expenses: toExpenses(data.expenses),
          approvals: toExpenseApprovals(data.expense_approvals),
          team,
        },
        period,
        { includeFinance },
      ),
    [data, period, includeFinance, team],
  );

  function choosePeriod(next: PeriodKey) {
    const updated = new URLSearchParams(params);
    updated.set('period', next);
    setParams(updated, { replace: true });
  }

  function download<T>(kind: string, columns: readonly CsvColumn<T>[], rows: readonly T[]) {
    downloadCsv(reportFilename(kind, period.startDay, period.endDay), toCsv(columns, rows));
  }

  function downloadBatches() {
    const columns: Array<CsvColumn<BatchReportRow>> = [
      { header: 'Batch', value: (row) => row.code },
      { header: 'Species', value: (row) => SPECIES_LABELS[row.species] },
      { header: 'House', value: (row) => row.houseName },
      { header: 'Arrived', value: (row) => row.arrivalDate },
      { header: 'Status', value: (row) => row.status },
      { header: 'Live', value: (row) => row.live },
      { header: 'Deaths', value: (row) => row.mortality },
      { header: 'Mortality %', value: (row) => row.mortalityRatePct ?? '' },
      { header: 'Sold', value: (row) => row.sold },
      { header: 'Unpriced sales', value: (row) => row.unpricedSales },
      { header: 'Feed kg', value: (row) => row.feedUsedKg },
      { header: 'Feed per animal kg', value: (row) => row.feedPerBirdKg ?? '' },
      { header: 'Avg weight kg', value: (row) => row.avgWeightKg ?? '' },
    ];
    if (report.finance) {
      columns.push(
        { header: 'Revenue KES', value: (row) => row.revenueKes ?? '' },
        { header: 'Expenses KES', value: (row) => row.expensesKes ?? '' },
        { header: 'Feed cost KES', value: (row) => row.feedCostKes ?? '' },
        { header: 'Uncosted feed kg', value: (row) => row.uncostedFeedKg },
        { header: 'Margin KES', value: (row) => row.marginKes ?? '' },
      );
    }
    download('batch-performance', columns, report.batches);
  }

  function downloadSalespeople() {
    const columns: Array<CsvColumn<SalespersonReportRow>> = [
      { header: 'Salesperson', value: (row) => row.name },
      { header: 'Handovers', value: (row) => row.handovers },
      { header: 'Animals allocated', value: (row) => row.allocated },
      { header: 'Sold', value: (row) => row.sold },
      { header: 'Returned', value: (row) => row.returned },
      { header: 'Still out', value: (row) => row.stillOut },
      { header: 'Feed kg', value: (row) => row.feedKg },
      { header: 'Feed per animal kg', value: (row) => row.feedPerBirdSoldKg ?? '' },
    ];
    if (report.finance) {
      columns.push({ header: 'Revenue KES', value: (row) => row.revenueKes ?? '' });
    }
    download('salespeople', columns, report.salespeople);
  }

  const hasWork =
    report.batches.length > 0 ||
    report.salespeople.length > 0 ||
    report.summary.birdsSold > 0 ||
    report.summary.mortalityCount > 0 ||
    report.summary.feedUsedKg > 0;

  return (
    <AppLayout
      title="Reports"
      subtitle={`${period.label} · ${farm?.name ?? 'This farm'}`}
      actions={
        <div className="reports-toolbar no-print">
          <div className="period-picker" role="group" aria-label="Report period">
            {PERIOD_KEYS.map((key) => (
              <button
                key={key}
                type="button"
                className={
                  key === periodKey ? 'period-option period-option--active' : 'period-option'
                }
                aria-pressed={key === periodKey}
                onClick={() => choosePeriod(key)}
              >
                {PERIOD_LABELS[key]}
              </button>
            ))}
          </div>
          <Button variant="ghost" onClick={() => window.print()}>
            Print
          </Button>
        </div>
      }
    >
      <div className="print-only report-print-meta">
        <strong>{farm?.name ?? 'Farm reports'}</strong>
        <span>
          {period.label} · {formatDate(period.startDay)} – {formatDate(period.endDay)}
        </span>
      </div>

      {loading ? (
        <p className="muted">Loading this phone’s records…</p>
      ) : (
        <>
          {!hasWork && (
            <Alert tone="info">
              No batches, sales or feed have been recorded on this phone yet. The report fills
              in as work is saved.
            </Alert>
          )}

          <section className="card">
            <div className="card-head">
              <h2 className="card-title">{period.label}</h2>
              <Badge>
                {period.startDay} → {period.endDay}
              </Badge>
            </div>
            <div className="card-body">
              <div className="status-grid">
                <Stat label="Animals sold" value={formatCount(report.summary.birdsSold)} />
                <Stat
                  label="Deaths"
                  value={formatCount(report.summary.mortalityCount)}
                  sub={`${formatPercent(report.summary.mortalityRatePct)} of animals at risk`}
                />
                <Stat label="Feed used" value={`${report.summary.feedUsedKg} kg`} />
                {report.finance && (
                  <>
                    <Stat label="Money in" value={formatKes(report.finance.revenueKes)} />
                    <Stat label="Money out" value={formatKes(report.finance.spendKes)} />
                    <Stat label="Net" value={formatKes(report.finance.netKes)} strong />
                  </>
                )}
              </div>
              {report.finance && report.summary.unpricedSales > 0 && (
                <Alert tone="warning">
                  {report.summary.unpricedSales} sale
                  {report.summary.unpricedSales === 1 ? ' has' : 's have'} no price and{' '}
                  {report.summary.unpricedSales === 1 ? 'is' : 'are'} not counted in revenue.
                </Alert>
              )}
            </div>
          </section>

          <section className="card">
            <div className="card-head">
              <h2 className="card-title">Batch performance</h2>
              <div className="head-actions no-print">
                <Button
                  variant="ghost"
                  onClick={downloadBatches}
                  disabled={report.batches.length === 0}
                >
                  CSV
                </Button>
              </div>
            </div>
            <div className="card-body">
              {report.batches.length === 0 ? (
                <p className="muted">No batches in this period.</p>
              ) : (
                <div className="report-table-wrap">
                  <table className="report-table">
                    <thead>
                      <tr>
                        <th scope="col">Batch</th>
                        <th scope="col">House</th>
                        <th scope="col">Live</th>
                        <th scope="col">Deaths</th>
                        <th scope="col">Sold</th>
                        <th scope="col">Feed</th>
                        <th scope="col">kg/animal</th>
                        <th scope="col">Avg wt</th>
                        {report.finance && (
                          <>
                            <th scope="col">In</th>
                            <th scope="col">Out</th>
                            <th scope="col">Feed cost</th>
                            <th scope="col">Margin</th>
                          </>
                        )}
                      </tr>
                    </thead>
                    <tbody>
                      {report.batches.map((row) => (
                        <tr
                          key={row.batchId}
                          className={row.status === 'active' ? undefined : 'report-row--closed'}
                        >
                          <td>
                            <div className="report-cell-title">
                              {row.code}
                              {row.status !== 'active' && <Badge>Closed</Badge>}
                            </div>
                            <div className="list-sub">
                              {SPECIES_LABELS[row.species]} · Arrived {formatDate(row.arrivalDate)}
                            </div>
                          </td>
                          <td>{row.houseName}</td>
                          <td className="num">{formatCount(row.live)}</td>
                          <td className="num">
                            {formatCount(row.mortality)}
                            {row.mortalityRatePct !== null && (
                              <span className="list-sub"> ({row.mortalityRatePct}%)</span>
                            )}
                          </td>
                          <td className="num">
                            {formatCount(row.sold)}
                            {row.unpricedSales > 0 && (
                              <span className="list-sub"> ({row.unpricedSales} unpriced)</span>
                            )}
                          </td>
                          <td className="num">{row.feedUsedKg} kg</td>
                          <td className="num">{row.feedPerBirdKg ?? '—'}</td>
                          <td className="num">
                            {row.avgWeightKg === null ? '—' : `${row.avgWeightKg} kg`}
                          </td>
                          {report.finance && (
                            <>
                              <td className="num">
                                {row.revenueKes === null ? '—' : formatKes(row.revenueKes)}
                              </td>
                              <td className="num">
                                {row.expensesKes === null ? '—' : formatKes(row.expensesKes)}
                              </td>
                              <td className="num">
                                {row.feedCostKes === null ? '—' : formatKes(row.feedCostKes)}
                                {row.uncostedFeedKg > 0 && (
                                  <span className="list-sub">
                                    {' '}
                                    ({row.uncostedFeedKg} kg unpriced)
                                  </span>
                                )}
                              </td>
                              <td className="num">
                                {row.marginKes === null ? '—' : formatKes(row.marginKes)}
                              </td>
                            </>
                          )}
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
              <p className="muted">
                Live animals is where the farm stands now. Deaths, sales, feed and weight cover
                the chosen period. Margin subtracts approved expenses and feed cost from priced
                sales.
              </p>
            </div>
          </section>

          <section className="card">
            <div className="card-head">
              <h2 className="card-title">Mortality</h2>
              <div className="head-actions no-print">
                <Badge tone={report.mortality.total > 0 ? 'red' : 'neutral'}>
                  {formatCount(report.mortality.total)} deaths
                </Badge>
                <Button
                  variant="ghost"
                  onClick={() =>
                    download('mortality-by-cause', [
                      { header: 'Cause', value: (row) => row.label },
                      { header: 'Deaths', value: (row) => row.birds },
                    ], report.mortality.byCause)
                  }
                  disabled={report.mortality.byCause.length === 0}
                >
                  CSV
                </Button>
              </div>
            </div>
            <div className="card-body">
              {report.mortality.byCause.length === 0 ? (
                <p className="muted">No deaths recorded in this period.</p>
              ) : (
                <div className="chips">
                  {report.mortality.byCause.map((row) => (
                    <span className="chip" key={row.category ?? 'uncategorised'}>
                      {row.label} · {formatCount(row.birds)}
                    </span>
                  ))}
                </div>
              )}

              {report.mortality.byBatch.length > 0 && (
                <div className="report-table-wrap">
                  <table className="report-table">
                    <thead>
                      <tr>
                        <th scope="col">Batch</th>
                        <th scope="col">Deaths</th>
                        <th scope="col">Rate</th>
                      </tr>
                    </thead>
                    <tbody>
                      {report.mortality.byBatch.map((row) => (
                        <tr key={row.batchId}>
                          <td>{row.code}</td>
                          <td className="num">{formatCount(row.birds)}</td>
                          <td className="num">{formatPercent(row.mortalityRatePct)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
          </section>

          {report.finance && (
            <section className="card">
              <div className="card-head">
                <h2 className="card-title">Money in and out</h2>
                <div className="head-actions no-print">
                  <Badge>KES</Badge>
                  <Button
                    variant="ghost"
                    onClick={() =>
                      download('expenses-by-category', [
                        { header: 'Category', value: (row) => row.label },
                        { header: 'KES', value: (row) => row.totalKes },
                      ], report.finance?.byCategory ?? [])
                    }
                    disabled={(report.finance?.byCategory.length ?? 0) === 0}
                  >
                    CSV
                  </Button>
                </div>
              </div>
              <div className="card-body">
                <TrendBars buckets={report.finance.trend} />

                {report.finance.byCategory.length === 0 ? (
                  <p className="muted">No approved expenses in this period.</p>
                ) : (
                  <div className="report-table-wrap">
                    <table className="report-table">
                      <thead>
                        <tr>
                          <th scope="col">Category</th>
                          <th scope="col">Approved spend</th>
                        </tr>
                      </thead>
                      <tbody>
                        {report.finance.byCategory.map((row) => (
                          <tr key={row.category}>
                            <td>{row.label}</td>
                            <td className="num">{formatKes(row.totalKes)}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}

                {report.finance.pendingCount > 0 && (
                  <p className="muted">
                    {report.finance.pendingCount} expense
                    {report.finance.pendingCount === 1 ? '' : 's'} still waiting for a decision;
                    not counted yet.
                  </p>
                )}
                <p className="muted">Only approved expenses count as money out.</p>
                <p className="muted">
                  This is the cash book. Batch margin goes further and also subtracts the cost
                  of feed issued, valued from delivery prices.
                </p>
              </div>
            </section>
          )}

          <section className="card">
            <div className="card-head">
              <h2 className="card-title">Salespeople</h2>
              <div className="head-actions no-print">
                <Button
                  variant="ghost"
                  onClick={downloadSalespeople}
                  disabled={report.salespeople.length === 0}
                >
                  CSV
                </Button>
              </div>
            </div>
            <div className="card-body">
              {report.salespeople.length === 0 ? (
                <p className="muted">No allocations or sales in this period.</p>
              ) : (
                <div className="report-table-wrap">
                  <table className="report-table">
                    <thead>
                      <tr>
                        <th scope="col">Salesperson</th>
                        <th scope="col">Handovers</th>
                        <th scope="col">Animals out</th>
                        <th scope="col">Sold</th>
                        <th scope="col">Returned</th>
                        <th scope="col">Still out</th>
                        <th scope="col">Feed</th>
                        <th scope="col">kg/animal</th>
                        {report.finance && <th scope="col">Revenue</th>}
                      </tr>
                    </thead>
                    <tbody>
                      {report.salespeople.map((row) => (
                        <tr key={row.salespersonId}>
                          <td>
                            <div className="report-cell-title">{row.name}</div>
                            {row.unpricedSales > 0 && (
                              <div className="list-sub">
                                {row.unpricedSales} unpriced sale
                                {row.unpricedSales === 1 ? '' : 's'}
                              </div>
                            )}
                          </td>
                          <td className="num">{formatCount(row.handovers)}</td>
                          <td className="num">{formatCount(row.allocated)}</td>
                          <td className="num">{formatCount(row.sold)}</td>
                          <td className="num">{formatCount(row.returned)}</td>
                          <td className="num">{formatCount(row.stillOut)}</td>
                          <td className="num">{row.feedKg} kg</td>
                          <td className="num">{row.feedPerBirdSoldKg ?? '—'}</td>
                          {report.finance && (
                            <td className="num">
                              {row.revenueKes === null ? '—' : formatKes(row.revenueKes)}
                            </td>
                          )}
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
              <p className="muted">
                Handovers and sales cover the period. “Still out” is the animals each person may
                still sell now.
              </p>
            </div>
          </section>
        </>
      )}
    </AppLayout>
  );
}
