import {
  addDays,
  allocationBalance,
  batchCounts,
  expensesByCategory,
  expenseState,
  EXPENSE_CATEGORY_LABELS,
  feedCostKes,
  groupMortalityByCause,
  latestWeight,
  roundKes,
  roundKg,
  saleRevenueKes,
  sumKes,
  toDateOnly,
  type CauseTotal,
  type ExpenseCategory,
} from '@farmatics/shared';
import type {
  Batch,
  BatchWeight,
  BirdReturn,
  BirdSale,
  BirdTransfer,
  Expense,
  ExpenseApproval,
  House,
  MortalityEvent,
  SalesAllocation,
  StockMovement,
} from './local.js';
import { rangeMoney } from './money.js';

/**
 * Reports built from the phone's own copy of the farm.
 *
 * Nothing is stored or fetched here: the screen already holds every event, and
 * this module turns a chosen period into the numbers an owner checks. Money is
 * only computed when the caller may see it, so a hidden section cannot leak a
 * figure into the DOM or a CSV.
 *
 * Conventions, matching the rest of the app:
 * - a period is an inclusive range of calendar days, grouped by the UTC day of
 *   each event's `recordedAt`;
 * - revenue counts priced sales only, and unpriced sales are reported, never
 *   treated as zero;
 * - spend counts approved expenses only;
 * - live birds is a snapshot now, while every other figure is period-scoped.
 */

export type PeriodKey = 'thisMonth' | 'last7' | 'last30' | 'last90';

export const PERIOD_KEYS: readonly PeriodKey[] = ['thisMonth', 'last7', 'last30', 'last90'];

export const PERIOD_LABELS: Record<PeriodKey, string> = {
  thisMonth: 'This month',
  last7: 'Last 7 days',
  last30: 'Last 30 days',
  last90: 'Last 90 days',
};

export interface ReportPeriod {
  key: PeriodKey;
  label: string;
  startDay: string;
  endDay: string;
}

export interface ReportTeamMember {
  id: string;
  name: string;
}

export interface ReportInput {
  batches: Batch[];
  houses: House[];
  mortality: MortalityEvent[];
  transfers: BirdTransfer[];
  sales: BirdSale[];
  allocations: SalesAllocation[];
  returns: BirdReturn[];
  movements: StockMovement[];
  weights: BatchWeight[];
  expenses: Expense[];
  approvals: ExpenseApproval[];
  team: ReadonlyArray<ReportTeamMember>;
}

export interface ReportSummary {
  birdsSold: number;
  mortalityCount: number;
  /** Deaths in the period as a share of the birds at risk when it began. */
  mortalityRatePct: number | null;
  feedUsedKg: number;
  /** Null when the caller may not see finance. */
  revenueKes: number | null;
  spendKes: number | null;
  netKes: number | null;
  unpricedSales: number;
}

export interface BatchReportRow {
  batchId: string;
  code: string;
  houseName: string;
  arrivalDate: string;
  status: string;
  live: number;
  mortality: number;
  mortalityRatePct: number | null;
  sold: number;
  feedUsedKg: number;
  feedPerBirdKg: number | null;
  /** Latest weighing on this phone, or null before the first one. */
  avgWeightKg: number | null;
  /** Feed issued in the period valued at its delivery price. */
  feedCostKes: number | null;
  /** Issued feed with no delivery price, whose cost is therefore missing. */
  uncostedFeedKg: number;
  revenueKes: number | null;
  expensesKes: number | null;
  marginKes: number | null;
  unpricedSales: number;
}

export interface MortalityBatchRow {
  batchId: string;
  code: string;
  birds: number;
  mortalityRatePct: number | null;
}

export interface TrendBucket {
  startDay: string;
  endDay: string;
  label: string;
  revenueKes: number;
  spendKes: number;
  netKes: number;
  unpricedSales: number;
}

export interface FinanceReport {
  revenueKes: number;
  spendKes: number;
  netKes: number;
  unpricedSales: number;
  pendingCount: number;
  byCategory: Array<{ category: ExpenseCategory; label: string; totalKes: number }>;
  trend: TrendBucket[];
}

export interface SalespersonReportRow {
  salespersonId: string;
  name: string;
  handovers: number;
  allocated: number;
  sold: number;
  returned: number;
  /** Feed issued in the period with their allocations. */
  feedKg: number;
  feedPerBirdSoldKg: number | null;
  /** Lifetime balance still with them now. */
  stillOut: number;
  revenueKes: number | null;
  unpricedSales: number;
}

export interface FarmReport {
  period: ReportPeriod;
  summary: ReportSummary;
  batches: BatchReportRow[];
  mortality: {
    total: number;
    byCause: CauseTotal[];
    byBatch: MortalityBatchRow[];
  };
  finance: FinanceReport | null;
  salespeople: SalespersonReportRow[];
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

function dayOf(recordedAt: string): string {
  return recordedAt.slice(0, 10);
}

function inDay(recordedAt: string, startDay: string, endDay: string): boolean {
  const day = dayOf(recordedAt);
  return day >= startDay && day <= endDay;
}

export function isInPeriod(recordedAt: string, period: ReportPeriod): boolean {
  return inDay(recordedAt, period.startDay, period.endDay);
}

export function periodFor(key: PeriodKey, today: string | Date = new Date()): ReportPeriod {
  const endDay = toDateOnly(today);
  const startDay =
    key === 'thisMonth'
      ? `${endDay.slice(0, 7)}-01`
      : key === 'last7'
        ? addDays(endDay, -6)
        : key === 'last30'
          ? addDays(endDay, -29)
          : addDays(endDay, -89);

  return { key, label: PERIOD_LABELS[key], startDay, endDay };
}

function dayLabel(day: string): string {
  const month = MONTHS[Number(day.slice(5, 7)) - 1] ?? '';
  return `${Number(day.slice(8, 10))} ${month}`.trim();
}

/** Daily for a week, week-commencing buckets for longer periods. */
function buildBuckets(period: ReportPeriod): Array<{ startDay: string; endDay: string }> {
  const buckets: Array<{ startDay: string; endDay: string }> = [];

  if (period.key === 'last7') {
    let day = period.startDay;
    while (day <= period.endDay) {
      buckets.push({ startDay: day, endDay: day });
      day = addDays(day, 1);
    }
    return buckets;
  }

  let start = period.startDay;
  while (start <= period.endDay) {
    const weekday = new Date(`${start}T00:00:00.000Z`).getUTCDay();
    const toSunday = (7 - weekday) % 7;
    const end = addDays(start, toSunday);
    buckets.push({ startDay: start, endDay: end > period.endDay ? period.endDay : end });
    start = addDays(buckets[buckets.length - 1]!.endDay, 1);
  }
  return buckets;
}

function ratePct(part: number, whole: number): number | null {
  if (!Number.isFinite(whole) || whole <= 0) return null;
  return Math.round((part / whole) * 10000) / 100;
}

function push<T>(map: Map<string, T[]>, key: string, value: T): void {
  const list = map.get(key);
  if (list) list.push(value);
  else map.set(key, [value]);
}

function pricedRevenue(sales: ReadonlyArray<BirdSale>): number {
  return sumKes(
    sales
      .map((sale) => saleRevenueKes(sale))
      .filter((value): value is number => value !== null),
  );
}

export function buildFarmReport(
  input: ReportInput,
  period: ReportPeriod,
  options: { includeFinance: boolean },
): FarmReport {
  const { includeFinance } = options;

  const mortalityByBatch = new Map<string, MortalityEvent[]>();
  const salesByBatch = new Map<string, BirdSale[]>();
  const transfersIn = new Map<string, BirdTransfer[]>();
  const transfersOut = new Map<string, BirdTransfer[]>();
  const issuesByBatch = new Map<string, StockMovement[]>();
  const weightsByBatch = new Map<string, BatchWeight[]>();
  const salesByAllocation = new Map<string, BirdSale[]>();
  const returnsByAllocation = new Map<string, BirdReturn[]>();

  for (const event of input.mortality) push(mortalityByBatch, event.batchId, event);
  for (const sale of input.sales) {
    push(salesByBatch, sale.batchId, sale);
    if (sale.allocationId) push(salesByAllocation, sale.allocationId, sale);
  }
  for (const transfer of input.transfers) {
    push(transfersIn, transfer.toBatchId, transfer);
    push(transfersOut, transfer.fromBatchId, transfer);
  }
  for (const movement of input.movements) {
    if (movement.kind === 'issue' && movement.batchId) push(issuesByBatch, movement.batchId, movement);
  }
  for (const sample of input.weights) push(weightsByBatch, sample.batchId, sample);
  for (const event of input.returns) push(returnsByAllocation, event.allocationId, event);

  // Deliveries are farm-wide; a batch's feed is valued from the same feed's
  // average delivered price, so every batch agrees on what a kilogram cost.
  const receipts = input.movements.filter((movement) => movement.kind === 'receipt');

  /** The batch's live count now, from every event on this phone. */
  function liveFor(candidate: Batch): number {
    return batchCounts({
      initialCount: candidate.initialCount,
      mortality: (mortalityByBatch.get(candidate.id) ?? []).map((event) => event.count),
      sold: (salesByBatch.get(candidate.id) ?? []).map((item) => item.count),
      transferredOut: (transfersOut.get(candidate.id) ?? []).map((item) => item.count),
      transferredIn: (transfersIn.get(candidate.id) ?? []).map((item) => item.count),
    }).live;
  }

  const periodMortality = input.mortality.filter((event) => isInPeriod(event.recordedAt, period));
  const periodSales = input.sales.filter((sale) => isInPeriod(sale.recordedAt, period));
  const periodReturns = input.returns.filter((event) => isInPeriod(event.recordedAt, period));
  const periodExpenses = input.expenses.filter((expense) => isInPeriod(expense.recordedAt, period));
  const periodIssues = input.movements.filter(
    (movement) => movement.kind === 'issue' && isInPeriod(movement.recordedAt, period),
  );

  /**
   * Birds that could die in this period: the flock at the start, plus arrivals
   * during it. A batch that arrived inside the period contributes its arrival
   * count, which is the closest honest denominator available without weights
   * or daily stock counts.
   */
  function birdsAtRisk(batch: Batch): number {
    if (batch.arrivalDate > period.endDay) return 0;

    let atStart: number;
    if (batch.arrivalDate >= period.startDay) {
      atStart = batch.initialCount;
    } else {
      const before = (recordedAt: string) => dayOf(recordedAt) < period.startDay;
      atStart = batchCounts({
        initialCount: batch.initialCount,
        mortality: (mortalityByBatch.get(batch.id) ?? [])
          .filter((event) => before(event.recordedAt))
          .map((event) => event.count),
        sold: (salesByBatch.get(batch.id) ?? [])
          .filter((sale) => before(sale.recordedAt))
          .map((sale) => sale.count),
        transferredOut: (transfersOut.get(batch.id) ?? [])
          .filter((transfer) => before(transfer.recordedAt))
          .map((transfer) => transfer.count),
        transferredIn: (transfersIn.get(batch.id) ?? [])
          .filter((transfer) => before(transfer.recordedAt))
          .map((transfer) => transfer.count),
      }).live;
    }

    const arrivedInPeriod = (transfersIn.get(batch.id) ?? [])
      .filter((transfer) => isInPeriod(transfer.recordedAt, period))
      .reduce((total, transfer) => total + transfer.count, 0);

    return Math.max(0, atStart + arrivedInPeriod);
  }

  const houseNames = new Map(input.houses.map((house) => [house.id, house.name]));
  const approvals = input.approvals;

  const batches: BatchReportRow[] = input.batches
    .filter((batch) => batch.arrivalDate <= period.endDay)
    .map((batch) => {
      const deaths = (mortalityByBatch.get(batch.id) ?? [])
        .filter((event) => isInPeriod(event.recordedAt, period))
        .reduce((total, event) => total + event.count, 0);
      const batchSales = (salesByBatch.get(batch.id) ?? []).filter((sale) =>
        isInPeriod(sale.recordedAt, period),
      );
      const sold = batchSales.reduce((total, sale) => total + sale.count, 0);
      const periodIssuesForBatch = (issuesByBatch.get(batch.id) ?? []).filter((movement) =>
        isInPeriod(movement.recordedAt, period),
      );
      const feedUsedKg = roundKg(
        periodIssuesForBatch.reduce((total, movement) => total + movement.quantityKg, 0),
      );
      const feed = feedCostKes(periodIssuesForBatch, receipts);
      const weight = latestWeight(weightsByBatch.get(batch.id) ?? []);
      const atRisk = birdsAtRisk(batch);
      const approvedExpenses = periodExpenses.filter(
        (expense) =>
          expense.batchId === batch.id && expenseState(expense.id, approvals) === 'approved',
      );
      const revenueKes = includeFinance ? pricedRevenue(batchSales) : null;
      const expensesKes = includeFinance
        ? sumKes(approvedExpenses.map((expense) => expense.amountKes))
        : null;
      const feedCostKesValue = includeFinance ? feed.costKes : null;

      return {
        batchId: batch.id,
        code: batch.code,
        houseName: houseNames.get(batch.houseId) ?? 'House',
        arrivalDate: batch.arrivalDate,
        status: batch.status,
        live: liveFor(batch),
        mortality: deaths,
        mortalityRatePct: ratePct(deaths, atRisk),
        sold,
        feedUsedKg,
        feedPerBirdKg: sold > 0 ? roundKg(feedUsedKg / sold) : null,
        avgWeightKg: weight ? weight.averageWeightKg : null,
        feedCostKes: feedCostKesValue,
        uncostedFeedKg: feed.uncostedKg,
        revenueKes,
        expensesKes,
        marginKes:
          revenueKes !== null && expensesKes !== null && feedCostKesValue !== null
            ? roundKes(revenueKes - expensesKes - feedCostKesValue)
            : null,
        unpricedSales: batchSales.filter((sale) => saleRevenueKes(sale) === null).length,
      };
    })
    .filter(
      (row) =>
        row.status === 'active' ||
        row.mortality > 0 ||
        row.sold > 0 ||
        row.feedUsedKg > 0 ||
        row.avgWeightKg !== null ||
        (row.revenueKes ?? 0) > 0 ||
        (row.expensesKes ?? 0) > 0,
    )
    .sort(
      (left, right) =>
        right.arrivalDate.localeCompare(left.arrivalDate) || left.code.localeCompare(right.code),
    );

  const mortalityByBatchRows: MortalityBatchRow[] = batches
    .filter((row) => row.mortality > 0)
    .map((row) => ({
      batchId: row.batchId,
      code: row.code,
      birds: row.mortality,
      mortalityRatePct: row.mortalityRatePct,
    }))
    .sort((left, right) => right.birds - left.birds);

  const totalAtRisk = input.batches.reduce((total, batch) => total + birdsAtRisk(batch), 0);
  const mortalityCount = periodMortality.reduce((total, event) => total + event.count, 0);
  const feedUsedKg = roundKg(
    periodIssues.reduce((total, movement) => total + movement.quantityKg, 0),
  );

  let finance: FinanceReport | null = null;
  if (includeFinance) {
    const money = rangeMoney(input.sales, input.expenses, approvals, period.startDay, period.endDay);
    const approved = periodExpenses.filter(
      (expense) => expenseState(expense.id, approvals) === 'approved',
    );

    finance = {
      revenueKes: money.revenueKes,
      spendKes: money.spendKes,
      netKes: money.netKes,
      unpricedSales: money.unpricedSales,
      pendingCount: periodExpenses.filter(
        (expense) => expenseState(expense.id, approvals) === 'pending',
      ).length,
      byCategory: expensesByCategory(approved).map((row) => ({
        ...row,
        label: EXPENSE_CATEGORY_LABELS[row.category],
      })),
      trend: buildBuckets(period).map((bucket) => {
        const bucketMoney = rangeMoney(
          input.sales,
          input.expenses,
          approvals,
          bucket.startDay,
          bucket.endDay,
        );
        return {
          startDay: bucket.startDay,
          endDay: bucket.endDay,
          label:
            bucket.startDay === bucket.endDay
              ? dayLabel(bucket.startDay)
              : `w/c ${dayLabel(bucket.startDay)}`,
          revenueKes: bucketMoney.revenueKes,
          spendKes: bucketMoney.spendKes,
          netKes: bucketMoney.netKes,
          unpricedSales: bucketMoney.unpricedSales,
        };
      }),
    };
  }

  const allocationById = new Map(input.allocations.map((allocation) => [allocation.id, allocation]));
  const periodAllocations = input.allocations.filter((allocation) =>
    isInPeriod(allocation.recordedAt, period),
  );
  const people = new Set<string>();
  for (const allocation of periodAllocations) people.add(allocation.salespersonId);
  for (const sale of periodSales) {
    const allocation = sale.allocationId ? allocationById.get(sale.allocationId) : undefined;
    if (allocation) people.add(allocation.salespersonId);
  }

  const teamNames = new Map(input.team.map((member) => [member.id, member.name]));
  const salespeople: SalespersonReportRow[] = [...people]
    .map((salespersonId) => {
      const mine = input.allocations.filter(
        (allocation) => allocation.salespersonId === salespersonId,
      );
      const myIds = new Set(mine.map((allocation) => allocation.id));
      const handovers = periodAllocations.filter(
        (allocation) => allocation.salespersonId === salespersonId,
      );
      const mySales = periodSales.filter(
        (sale) => sale.allocationId !== null && myIds.has(sale.allocationId),
      );
      const sold = mySales.reduce((total, sale) => total + sale.count, 0);
      const returned = periodReturns
        .filter((event) => myIds.has(event.allocationId))
        .reduce((total, event) => total + event.count, 0);
      const feedKg = roundKg(
        periodIssues
          .filter(
            (movement) => movement.allocationId !== null && myIds.has(movement.allocationId),
          )
          .reduce((total, movement) => total + movement.quantityKg, 0),
      );

      return {
        salespersonId,
        name: teamNames.get(salespersonId) ?? 'Salesperson',
        handovers: handovers.length,
        allocated: handovers.reduce((total, allocation) => total + allocation.count, 0),
        sold,
        returned,
        feedKg,
        feedPerBirdSoldKg: sold > 0 ? roundKg(feedKg / sold) : null,
        stillOut: mine.reduce(
          (total, allocation) =>
            total +
            allocationBalance({
              allocated: allocation.count,
              sold: (salesByAllocation.get(allocation.id) ?? []).map((item) => item.count),
              returned: (returnsByAllocation.get(allocation.id) ?? []).map((item) => item.count),
            }).remaining,
          0,
        ),
        revenueKes: includeFinance ? pricedRevenue(mySales) : null,
        unpricedSales: mySales.filter((sale) => saleRevenueKes(sale) === null).length,
      };
    })
    .sort((left, right) => {
      const leftValue = includeFinance ? (left.revenueKes ?? 0) : left.sold;
      const rightValue = includeFinance ? (right.revenueKes ?? 0) : right.sold;
      return rightValue - leftValue || left.name.localeCompare(right.name);
    });

  return {
    period,
    summary: {
      birdsSold: periodSales.reduce((total, sale) => total + sale.count, 0),
      mortalityCount,
      mortalityRatePct: ratePct(mortalityCount, totalAtRisk),
      feedUsedKg,
      revenueKes: finance?.revenueKes ?? null,
      spendKes: finance?.spendKes ?? null,
      netKes: finance?.netKes ?? null,
      unpricedSales: periodSales.filter((sale) => saleRevenueKes(sale) === null).length,
    },
    batches,
    mortality: {
      total: mortalityCount,
      byCause: groupMortalityByCause(periodMortality),
      byBatch: mortalityByBatchRows,
    },
    finance,
    salespeople,
  };
}
